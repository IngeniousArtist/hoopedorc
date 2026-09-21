import { expect, test } from "@playwright/test";
import { execFileSync, fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import type { CaptureReviewRequest, PreviewProfile } from "@orc/types";
import { defaultSettings } from "../../../packages/server/src/config";
import { initDb } from "../../../packages/server/src/db/index";
import * as repo from "../../../packages/server/src/db/repo";
import { PreviewManager, processGroupExists } from "../../../packages/server/src/previews";
import { ReviewManager } from "../../../packages/server/src/reviews";
import { openTaskBrowser } from "../../../packages/server/src/activation-browser";
import { probeSelectiveClaude } from "@orc/adapters";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hoop-vw10-browser-")); const localPath = join(root, "project"); mkdirSync(localPath);
  git(localPath, ["init", "-qb", "main"]); git(localPath, ["config", "user.name", "Review Test"]); git(localPath, ["config", "user.email", "review@test.local"]);
  writeFileSync(join(localPath, "app.cjs"), `require('node:http').createServer((req,res)=>{
if(req.url==='/wait')return;
res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body><h1>Review fixture</h1><label>Name<input></label><button onclick="document.querySelector(\\'output\\').textContent=\\'Complete\\'">Show result</button><output>Waiting</output></body></html>');
}).listen(Number(process.env.PORT),process.env.HOST);`);
  git(localPath, ["add", "."]); git(localPath, ["commit", "-qm", "fixture"]);
  const path = `${localPath}-wt-task`; git(localPath, ["worktree", "add", "-qb", "orc/task", path]);
  const db = initDb(join(root, "state.sqlite")); repo.upsertSettings(db, defaultSettings());
  const profile: PreviewProfile = { command: process.execPath, args: ["app.cjs"], readinessPath: "/", startupTimeoutSeconds: 15 };
  const project = repo.createProject(db, { id: "project", name: "Native review", repoUrl: "unused", localPath, defaultBranch: "main", status: "paused", config: { preview: profile } });
  repo.createTask(db, { id: "task", projectId: project.id, title: "Native review", description: "", difficulty: "easy", assignedModel: "codex", status: "in_review", acceptanceCriteria: ["The button shows Complete"], dependsOn: [], scopePaths: [], attempts: 1, maxAttempts: 3 });
  const task = repo.updateTask(db, "task", { branch: "orc/task", worktreePath: path })!;
  const portOwner = createServer(); await new Promise<void>((resolve) => portOwner.listen(0, "127.0.0.1", resolve));
  const address = portOwner.address(); if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => portOwner.close(() => resolve()));
  const previews = new PreviewManager(db, [{ port: address.port, origin: `http://127.0.0.1:${address.port}` }]);
  const reviews = new ReviewManager(db, previews, false);
  previews.start(project, task, profile);
  try { await expect.poll(() => previews.latest(project.id, task.id)?.state, { timeout: 20_000 }).toBe("ready"); }
  catch (error) { await reviews.close(); await previews.close(); db.close(); rmSync(root, { recursive: true, force: true }); throw error; }
  return { root, project, task, db, previews, reviews };
}

test("VW12: task-scoped MCP delivers real Playwright evidence and settles cancellation", async () => {
  test.setTimeout(60_000);
  const f = await fixture();
  const bridge = await openTaskBrowser(f.db, f.previews, f.reviews, f.project, f.task);
  const call = async (name: string, args = {}) => (await fetch(bridge.config.url, { method: "POST", headers: { ...bridge.config.headers, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json();
  try {
    // Optional installed-CLI control initialization, never a model request.
    // CI always exercises the real browser bridge; local compatibility checks
    // additionally prove the installed harness receives the actual tool list.
    if (process.env.VW12_LIVE_CLAUDE === "1") {
      const old = process.env; const home = join(f.root, "cli-home"); mkdirSync(home);
      const config = join(f.root, "mcp.json"); writeFileSync(config, JSON.stringify({ mcpServers: { "hoop-browser": bridge.config } }), { mode: 0o600 });
      process.env = { PATH: `${join(old.HOME ?? "", ".local", "bin")}:${old.PATH}`, HOME: home, CLAUDE_CONFIG_DIR: home, TMPDIR: f.root, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
      try { const result = await probeSelectiveClaude(f.task.worktreePath!, { mcpConfigPath: config }, ["hoop-browser"]); expect(result[0]?.tools.map((tool) => tool.name).sort()).toEqual(["browser_capture", "browser_start", "browser_status"]); }
      finally { process.env = old; }
    }
    const result = await call("browser_capture", { path: "/", viewport: { width: 390, height: 844 }, steps: [{ action: "clickText", target: "Show result" }, { action: "expectText", target: "Complete" }] });
    expect(result.result.isError).toBe(false);
    const evidence = JSON.parse(result.result.content[0].text);
    expect(evidence.taskId).toBe(f.task.id); expect(evidence.state).toBe("passed");
    expect(result.result.content[1].type).toBe("image");
    expect(evidence.artifacts.map((item: { kind: string }) => item.kind).sort()).toEqual(["screenshot", "text", "trace"]);
    const waiting = call("browser_capture", { path: "/wait", viewport: { width: 390, height: 844 }, steps: [] }).catch(() => null);
    await expect.poll(() => f.reviews.hasActivity(f.project.id)).toBe(true);
    await bridge.close(); await waiting;
    expect(f.reviews.hasActivity(f.project.id)).toBe(false);
    expect(f.previews.latest(f.project.id, f.task.id)?.state, "An operator-started preview survives invocation cleanup").toBe("ready");
  } finally { await bridge.close(); await f.reviews.close(); await f.previews.close(); f.db.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("VW10: real browser captures success/failure artifacts, cancels, and survives owner disappearance", async () => {
  test.setTimeout(90_000);
  const f = await fixture();
  try {
    expect(f.reviews.capability()).toEqual({ available: true });
    const input = (steps: CaptureReviewRequest["steps"], path = "/"): CaptureReviewRequest => ({ requestId: randomUUID(), taskUpdatedAt: f.task.updatedAt, previewId: f.previews.latest(f.project.id, f.task.id)!.id, path, viewport: { width: 390, height: 844 }, steps });
    const request = input([{ action: "fillLabel", target: "Name", value: "Designer" }, { action: "clickText", target: "Show result" }, { action: "expectText", target: "Complete" }]);
    const evidence = await f.reviews.capture(f.project, f.task, request);
    expect((await f.reviews.capture(f.project, f.task, request)).id).toBe(evidence.id);
    await expect.poll(() => f.reviews.store.get(evidence.id)?.state, { timeout: 30_000 }).toBe("passed");
    const context = await f.reviews.context(f.project, f.task);
    expect(context.evidence[0]?.freshness).toBe("current");
    expect(context.evidence[0]?.artifacts.map((item) => item.kind).sort()).toEqual(["screenshot", "text", "trace"]);
    const screenshot = context.evidence[0]!.artifacts.find((item) => item.kind === "screenshot")!;
    expect(f.reviews.store.artifact(f.project.id, f.task.id, screenshot.id).bytes.subarray(1, 4).toString()).toBe("PNG");

    const failed = await f.reviews.capture(f.project, f.task, input([{ action: "expectText", target: "Missing text" }]));
    await expect.poll(() => f.reviews.store.get(failed.id)?.state, { timeout: 20_000 }).toBe("failed");
    expect(f.reviews.store.get(failed.id)?.artifacts.map((item) => item.kind)).toContain("screenshot");
    expect(f.reviews.store.get(failed.id)?.artifacts.map((item) => item.kind)).toContain("trace");

    const waiting = await f.reviews.capture(f.project, f.task, input([], "/wait"));
    await expect.poll(() => (f.db.prepare("SELECT browser_pid FROM review_evidence WHERE id = ?").get(waiting.id) as { browser_pid: number | null }).browser_pid, { timeout: 15_000 }).toBeTruthy();
    const pid = (f.db.prepare("SELECT browser_pid FROM review_evidence WHERE id = ?").get(waiting.id) as { browser_pid: number }).browser_pid;
    expect((await f.reviews.cancel(f.project.id, f.task.id, waiting.id)).state).toBe("cancelled");
    expect(processGroupExists(pid)).toBe(false);
    expect((await f.reviews.cancel(f.project.id, f.task.id, waiting.id)).state).toBe("cancelled");

    // Kill only a temporary parent harness. Its browser supervisor must reap
    // its own Chromium while the independent preview service stays healthy.
    const harness = join(f.root, "browser-owner.mjs");
    const workerUrl = new URL("../../../packages/server/src/review-worker.mjs", import.meta.url).href;
    const launch = f.previews.open(f.project.id, f.task.id);
    const directory = join(f.root, "browser-owner-home"); mkdirSync(directory);
    const env = { PATH: process.env.PATH, HOME: directory, TMPDIR: directory };
    writeFileSync(harness, `import {fork} from 'node:child_process';import {fileURLToPath} from 'node:url';
const worker=fork(fileURLToPath(${JSON.stringify(workerUrl)}),[],{env:${JSON.stringify(env)},execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
worker.on('message',message=>{if(message.type==='browser')process.send(message);});
worker.send(${JSON.stringify({ type: "start", directory, env, executablePath: chromium.executablePath(), launchUrl: launch.url, path: "/wait", viewport: { width: 390, height: 844 }, steps: [] })});`);
    const parent = fork(harness, [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const closed = new Promise<void>((resolve) => parent.once("close", () => resolve()));
    try {
      const browserPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Browser supervisor did not report its process")), 20_000);
        parent.once("message", (raw: unknown) => { clearTimeout(timer); resolve((raw as { pid: number }).pid); });
        parent.once("error", (error) => { clearTimeout(timer); reject(error); });
      });
      parent.kill("SIGKILL"); await closed;
      await expect.poll(() => processGroupExists(browserPid), { timeout: 15_000 }).toBe(false);
    } finally { if (!parent.killed) parent.kill("SIGKILL"); await closed; }

    await f.previews.stop(f.project.id, f.task.id);
    expect((await f.reviews.context(f.project, f.task)).evidence.find((item) => item.id === evidence.id)?.freshness).toBe("stale");
    expect(f.reviews.hasActivity(f.project.id)).toBe(false);
  } finally { await f.reviews.close(); await f.previews.close(); f.db.close(); rmSync(f.root, { recursive: true, force: true }); }
});
