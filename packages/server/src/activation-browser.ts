import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { abortableDelay } from "@orc/adapters";
import type { Project, Task } from "@orc/types";
import type { Db } from "./db/index";
import * as repo from "./db/repo";
import type { PreviewManager } from "./previews";
import type { ReviewManager } from "./reviews";
import { parseCaptureRequest } from "./review-policy";

export const BROWSER_TOOLS = [
  { name: "browser_status", description: "Inspect this task's owned preview and browser availability.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "browser_start", description: "Start this task's saved preview profile. No command or URL input is accepted. Check browser_status until ready.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "browser_capture", description: "Run bounded Playwright interactions in a fresh context against this task's ready preview. Store screenshot, trace and diagnostics in Review; return evidence and a small screenshot when available.", inputSchema: { type: "object", properties: { path: { type: "string" }, viewport: { type: "object", properties: { width: { type: "integer" }, height: { type: "integer" } }, required: ["width", "height"], additionalProperties: false }, steps: { type: "array", maxItems: 10, items: { type: "object", properties: { action: { enum: ["clickText", "fillLabel", "expectText"] }, target: { type: "string" }, value: { type: "string" } }, required: ["action", "target"], additionalProperties: false } } }, required: ["path", "viewport", "steps"], additionalProperties: false } },
];

/** Ephemeral loopback MCP. The credential authorizes one invocation/task only;
 * it is never a control-plane bearer token and is invalid after close. */
export async function openTaskBrowser(db: Db, previews: PreviewManager, reviews: ReviewManager, project: Project, task: Task, signal?: AbortSignal) {
  const token = randomBytes(32).toString("hex"); const controller = new AbortController();
  const owned = new Set<string>(); let startedPreview: string | undefined; let busy = false; let calls = 0; let closing = false;
  const operations = new Set<Promise<void>>();
  const current = () => {
    const value = repo.getTask(db, task.id);
    if (closing || controller.signal.aborted || !value || value.projectId !== project.id || value.runGeneration !== task.runGeneration || value.attempts !== task.attempts || value.worktreePath !== task.worktreePath || repo.getProject(db, project.id)?.localPath !== project.localPath) throw new Error("This invocation no longer owns the task workspace.");
    return value;
  };
  const server = createServer((req, res) => {
    const work = (async () => {
      const credential = Buffer.from(req.headers.authorization ?? ""); const expected = Buffer.from(`Bearer ${token}`);
      if (req.method !== "POST" || req.url !== "/mcp" || req.headers.origin || credential.length !== expected.length || !timingSafeEqual(credential, expected)) { res.writeHead(401); res.end(); return; }
      let bytes = 0; const parts: Buffer[] = [];
      for await (const raw of req) { const chunk = Buffer.from(raw as Uint8Array); bytes += chunk.length; if (bytes > 16 * 1024) { res.writeHead(413); res.end(); return; } parts.push(chunk); }
      const message = JSON.parse(Buffer.concat(parts).toString("utf8")) as { jsonrpc?: string; id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (message.id === undefined) { res.writeHead(202); res.end(); return; }
      const reply = (result: unknown) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })); };
      if (message.method === "initialize") { reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "hoop-browser", version: "1" } }); return; }
      if (message.method === "tools/list") { reply({ tools: BROWSER_TOOLS }); return; }
      if (message.method !== "tools/call") { reply({}); return; }
      try {
        const value = current(); const name = message.params?.name; const args = message.params?.arguments ?? {};
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Use an object for browser arguments.");
        if (name === "browser_status") {
          if (Object.keys(args).length) throw new Error("Browser status takes no arguments.");
          const preview = previews.latest(project.id, task.id);
          reply({ content: [{ type: "text", text: JSON.stringify({ preview: preview ? { state: preview.state, detail: preview.detail } : null, browser: reviews.capability() }) }] }); return;
        }
        if (busy || ++calls > 20) throw new Error("Wait for the active check; each invocation permits at most 20 browser actions.");
        busy = true;
        try {
          const available = reviews.capability(); if (!available.available) throw new Error(available.reason);
          if (name === "browser_start") {
            if (Object.keys(args).length) throw new Error("Browser start takes no commands, URLs or other arguments.");
            if (!project.config?.preview) throw new Error("Save a preview profile in Workspaces first.");
            const prior = previews.latest(project.id, task.id);
            if (!prior || !["starting", "ready"].includes(prior.state)) { const preview = previews.start(project, value, project.config.preview); startedPreview = preview.id; }
            reply({ content: [{ type: "text", text: "Preview requested. Use browser_status before capturing." }] }); return;
          }
          if (name !== "browser_capture" || Object.keys(args).some((key) => !["path", "viewport", "steps"].includes(key))) throw new Error("Unsupported browser action or argument.");
          const preview = previews.latest(project.id, task.id); if (!preview || preview.state !== "ready") throw new Error("This task's preview is not ready. Start it and check browser_status.");
          const requestId = randomUUID(); owned.add(requestId);
          let evidence = await reviews.capture(project, value, parseCaptureRequest({ ...args, requestId, taskUpdatedAt: value.updatedAt, previewId: preview.id }));
          while (evidence.state === "running") { current(); await abortableDelay(200, controller.signal); evidence = reviews.store.get(evidence.id)!; }
          const content: ({ type: "text"; text: string } | { type: "image"; mimeType: string; data: string })[] = [{ type: "text", text: JSON.stringify(evidence) }];
          const screenshot = evidence.artifacts.find((a) => a.kind === "screenshot");
          if (screenshot && screenshot.bytes <= 1024 * 1024) { const artifact = reviews.store.artifact(project.id, task.id, screenshot.id); content.push({ type: "image", mimeType: "image/png", data: artifact.bytes.toString("base64") }); }
          reply({ content, isError: evidence.state !== "passed" });
        } finally { busy = false; }
      } catch (error) { reply({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Browser action refused." }] }); }
    })().catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); }).finally(() => operations.delete(work));
    operations.add(work);
  });
  server.requestTimeout = 90_000; server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let closed: Promise<void> | undefined;
  const close = () => closed ??= (async () => {
    closing = true; controller.abort(); signal?.removeEventListener("abort", abort);
    const finished = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await Promise.all(operations);
    const results = await Promise.allSettled([...owned].filter((id) => reviews.store.get(id)).map((id) => reviews.cancel(project.id, task.id, id)));
    if (startedPreview && previews.latest(project.id, task.id)?.id === startedPreview) await previews.stop(project.id, task.id);
    await finished;
    if (results.some((result) => result.status === "rejected")) throw new Error("An invocation-owned browser check did not settle.");
  })();
  // Abort revokes calls immediately. The invocation's finally block awaits
  // close, so cleanup errors cannot be swallowed in an event listener.
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  return { config: { type: "http", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, headers: { Authorization: `Bearer ${token}` } }, close };
}
