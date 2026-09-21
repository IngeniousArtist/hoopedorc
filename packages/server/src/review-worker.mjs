// One supervised browser check. No repository command, control token, shared
// browser profile, or arbitrary browser destination is accepted here.
import { chromium } from "playwright";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let started = false;
let cancelled = false;
let server;
let cleanup;
const send = (message) => new Promise((resolve) => {
  if (!process.connected) return resolve(false);
  process.send(message, (error) => resolve(!error));
});
const close = () => {
  if (!server) return Promise.resolve();
  cleanup ??= (async () => {
    let timer;
    try {
      await Promise.race([server.close().catch(() => server.kill()), new Promise((resolve, reject) => {
        timer = setTimeout(() => { void server.kill().then(resolve, reject); }, 5000);
      })]);
    } finally { clearTimeout(timer); }
  })();
  return cleanup;
};
const stop = () => { cancelled = true; void close().catch(() => {}); if (!started) process.exit(0); };
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("message", (message) => {
  if (message?.type === "stop") { stop(); return; }
  if (message?.type !== "start" || started) return;
  started = true;
  void run(message).catch(async (error) => {
    await send({ type: "result", state: "failed", detail: error instanceof Error ? error.message : "Browser supervisor failed." });
  }).finally(() => { if (process.connected) process.disconnect(); });
});

async function run(input) {
  const errors = [];
  const record = (text) => { if (errors.length < 40) errors.push(String(text).slice(0, 500)); };
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(); }, 60_000);
  let context;
  let page;
  let result = "passed";
  let detail = "Browser route and requested interactions completed.";
  try {
    server = await chromium.launchServer({ host: "127.0.0.1", headless: true, executablePath: input.executablePath, timeout: 15_000, env: input.env });
    await send({ type: "browser", pid: server.process().pid });
    if (cancelled) throw new Error("Browser check cancelled before startup completed.");
    const browser = await chromium.connect(server.wsEndpoint());
    context = await browser.newContext({ viewport: input.viewport, serviceWorkers: "block", acceptDownloads: false });
    context.setDefaultTimeout(3000);
    const expectedOrigin = new URL(input.launchUrl).origin;
    await context.route("**/*", async (route) => {
      const target = new URL(route.request().url());
      if (target.origin === expectedOrigin || ["data:", "blob:"].includes(target.protocol)) return route.continue();
      record(`External resource blocked: ${target.origin}`); await route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (route) => {
      const target = new URL(route.url()); target.protocol = target.protocol === "wss:" ? "https:" : "http:";
      if (target.origin === expectedOrigin) route.connectToServer();
      else { record(`External WebSocket blocked: ${target.origin}`); route.close(); }
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    page = await context.newPage();
    page.on("pageerror", (error) => record(error.message));
    page.on("console", (message) => { if (message.type() === "error") record(message.text()); });
    const entry = await page.goto(input.launchUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
    if (!entry || entry.status() >= 400) throw new Error(`Preview authentication/readiness failed (${entry?.status() ?? "no response"}).`);
    const response = await page.goto(new URL(input.path, expectedOrigin).href, { waitUntil: "domcontentloaded", timeout: 10_000 });
    if (!response || response.status() >= 400) throw new Error(`Application returned HTTP ${response?.status() ?? "no response"}.`);
    for (const step of input.steps) {
      if (cancelled) throw new Error("Browser check cancelled.");
      if (step.action === "clickText") await page.getByText(step.target, { exact: true }).click();
      else if (step.action === "fillLabel") await page.getByLabel(step.target, { exact: true }).fill(step.value);
      else await page.getByText(step.target, { exact: true }).waitFor({ state: "visible" });
    }
    if (errors.length) throw new Error("Browser reported errors or blocked external resources. Inspect the diagnostics and trace.");
  } catch (error) {
    result = cancelled ? "cancelled" : "failed";
    detail = error instanceof Error ? error.message : "Browser check failed."; record(detail);
  } finally {
    try {
      if (page && !page.isClosed()) {
        const png = await page.screenshot({ timeout: 5000, fullPage: false });
        if (png.length <= 5 * 1024 * 1024) await send({ type: "artifact", kind: "screenshot", name: "screenshot.png", content: png.toString("base64") });
        else { result = "failed"; record("Screenshot exceeded 5 MiB and was not retained."); }
      }
    } catch (error) { record(`Screenshot unavailable: ${error instanceof Error ? error.message : "capture failed"}`); if (result === "passed") result = "failed"; }
    try {
      if (context) {
        const path = join(input.directory, "trace.zip");
        await context.tracing.stop({ path });
        if (statSync(path).size <= 20 * 1024 * 1024) await send({ type: "artifact", kind: "trace", name: "trace.zip", content: readFileSync(path).toString("base64") });
        else { result = "failed"; record("Trace exceeded 20 MiB and was not retained."); }
      }
    } catch (error) { record(`Trace unavailable: ${error instanceof Error ? error.message : "capture failed"}`); if (result === "passed") result = "failed"; }
    clearTimeout(timer);
    await close();
    if (result === "passed" && errors.length) result = "failed";
    if (cancelled) { result = timedOut ? "failed" : "cancelled"; detail = timedOut ? "Browser check exceeded its 60-second deadline." : "Browser check cancelled; available artifacts were retained."; }
    if (timedOut) record(detail);
    if (result === "failed" && errors.length) detail = errors.join("\n");
    const diagnostics = Buffer.from(`${detail}\n${errors.join("\n")}`);
    await send({ type: "artifact", kind: "text", name: "diagnostics.txt", content: diagnostics.toString("base64") });
    await send({ type: "result", state: result, detail: detail.slice(0, 20_000) });
  }
}
