import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import type { ActivationPolicy, ActivationResponse, SaveActivationResponse, ReviewEvidence } from "@orc/types";
import { initDb } from "./db/index";
import * as repo from "./db/repo";
import { ActivationStore, activationRevision, inheritedActivation, parseActivationSave } from "./activation-store";
import { ActivationService } from "./activation";
import { LibraryStore } from "./library";
import { registerActivationRoutes } from "./activation-routes";
import { openTaskBrowser } from "./activation-browser";
import { PreviewManager } from "./previews";
import { ReviewManager } from "./reviews";

function fixture(path = "/activation-mock") {
  const db = initDb(":memory:");
  const project = repo.createProject(db, { id: "p", name: "Activation", repoUrl: "unused", localPath: path, defaultBranch: "main", status: "paused", config: { preview: { command: "never-execute", args: [], readinessPath: "/", startupTimeoutSeconds: 5 } } });
  const task = repo.createTask(db, { id: "t", projectId: "p", title: "Task", description: "", difficulty: "easy", assignedModel: "claude", status: "in_progress", acceptanceCriteria: [], dependsOn: [], scopePaths: [], attempts: 1, maxAttempts: 3, worktreePath: path, branch: "task" });
  return { db, project, task, store: new ActivationStore(db) };
}
const save = (policy: ActivationPolicy, expectedRevision = 0) => ({ requestId: randomUUID(), expectedRevision, policy });

test("VW12: durable versions, exact retries, task pins and strict input refusal", () => {
  const f = fixture();
  try {
    assert.equal(f.store.version("p").policy.mode, "inherit");
    const input = save({ ...inheritedActivation(), mode: "selected" }); const first = f.store.save("p", input);
    assert.deepEqual(f.store.save("p", input), first);
    assert.throws(() => f.store.save("p", { ...input, policy: inheritedActivation() }), /different activation/);
    assert.throws(() => f.store.save("p", save(inheritedActivation())), /another session/);
    f.store.save("p", save(inheritedActivation(), 1));
    assert.equal(new ActivationStore(f.db).resolve("p", "hoop-activation:1").policy.mode, "selected");
    assert.equal(f.store.resolve("p").revision, 2);
    assert.throws(() => activationRevision("hoop-activation:1 hoop-activation:2"), /conflicting/);
    assert.throws(() => activationRevision("hoop-activation:no"), /malformed/);
    assert.throws(() => f.store.version("other", 1), /unavailable/);
    for (const policy of [ { ...inheritedActivation(), nativePlugins: ["x"] }, { ...inheritedActivation(), mcps: [{ id: "x", enabled: true, transport: { type: "http", url: "https://secret@host/mcp" } }] }, { ...inheritedActivation(), mcps: [{ id: "x", enabled: true, transport: { type: "stdio", command: "relative", args: [] } }] } ]) assert.throws(() => parseActivationSave({ requestId: randomUUID(), expectedRevision: 0, policy }), /Unknown|credentials|absolute/);
  } finally { f.db.close(); }
});

test("VW12: selected snapshots and MCPs reach an invocation without inherited registrations; cleanup and unsupported refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "activation-service-")); const previous = process.env.PATH;
  const cli = join(root, "claude");
  writeFileSync(cli, `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2); if(args.includes('--version')){console.log('2.1.278 (Claude Code)');process.exit(0);}
if(args.includes('auth')) { console.log(JSON.stringify({loggedIn:true,authMethod:'fixture',apiProvider:'fixture'})); process.exit(0); }
const servers=Object.keys(JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config')+1],'utf8')).mcpServers);
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.type!=='control_request')throw Error('No model calls');console.log(JSON.stringify({type:'control_response',response:{subtype:'success',response:r.request.subtype==='initialize'?{commands:[],agents:[]}:{mcpServers:servers.map(name=>({name,status:'connected',tools:[{name:'fixture_check'}]}))}}}));});
`); chmodSync(cli, 0o755); process.env.PATH = `${root}:${previous}`;
  const f = fixture(root); const service = new ActivationService(f.db);
  try {
    const library = new LibraryStore(f.db);
    library.save("p", "skill", { requestId: randomUUID(), expectedRevision: 0, reference: { title: "Selected skill", kind: "skill", source: { type: "text", locator: "" }, applicability: "", conflictGroup: "", content: "SELECTED_INSTRUCTIONS", archived: false } });
    const revision = f.store.save("p", save({ mode: "selected", skills: [{ id: "skill", revision: 1 }], browser: false, mcps: [{ id: "selected", enabled: true, transport: { type: "stdio", command: "/not-executed-by-fixture", args: [] } }, { id: "inactive", enabled: false, transport: { type: "http", url: "https://unused.invalid/mcp" } }] }));
    const invocation = { id: "author-one", project: f.project, task: f.task, stage: "author" as const, runner: "claude-code" as const, cwd: root };
    const prepared = await service.prepare(invocation, revision);
    try {
      assert.match(prepared.instructions, /SELECTED_INSTRUCTIONS/);
      const config = JSON.parse(readFileSync(prepared.launch!.mcpConfigPath, "utf8")) as { mcpServers: Record<string, unknown> }; assert.deepEqual(Object.keys(config.mcpServers), ["selected"]);
      f.store.save("p", save(inheritedActivation(), 1)); assert.match(prepared.instructions, /SELECTED_INSTRUCTIONS/);
      assert.equal(f.store.response("p").manifests[0]?.revision, 1);
      assert.equal(f.store.response("p").manifests[0]?.servers[0]?.tools[0]?.schemaSha, undefined, "Absent schemas are not fabricated");
    } finally { await prepared.close(); }
    assert.equal(existsSync(prepared.launch!.mcpConfigPath), false);
    await assert.rejects(service.prepare({ ...invocation, id: "unsupported", runner: "codex" }, revision), /not verified/);
    assert.equal(f.store.response("p").manifests[0]?.state, "refused");
    const inherited = await service.prepare({ ...invocation, id: "inherited", runner: "opencode" });
    assert.equal(inherited.launch, undefined); await inherited.close();
    assert.match((await service.check(f.project, { ...f.task, description: "hoop-activation:1" }, "opencode"))!, /not verified/);
  } finally { process.env.PATH = previous; f.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("VW12: REST is mock-safe, project-bound and idempotent without launching registered commands", async () => {
  const f = fixture(); const app = Fastify(); registerActivationRoutes(app, f.db);
  try {
    assert.equal((await app.inject("/api/projects/other/activation")).statusCode, 404);
    const policy = { ...inheritedActivation(), mcps: [{ id: "never", enabled: true, transport: { type: "stdio" as const, command: "/does-not-exist", args: [] } }] };
    const payload = save(policy); const url = "/api/projects/p/activation";
    assert.equal((await app.inject({ method: "PUT", url, payload })).statusCode, 200);
    assert.equal((await app.inject({ method: "PUT", url, payload })).json<SaveActivationResponse>().revision.revision, 1);
    assert.equal((await app.inject(url)).json<ActivationResponse>().manifests.length, 0);
  } finally { await app.close(); f.db.close(); }
});

test("VW12: scoped browser MCP rejects foreign arguments, captures only owned evidence, revokes on stale attempts and closes", async () => {
  const f = fixture(); const previews = new PreviewManager(f.db, [{ port: 4318, origin: "http://127.0.0.1:4318" }], true); const reviews = new ReviewManager(f.db, previews, true);
  const bridge = await openTaskBrowser(f.db, previews, reviews, f.project, f.task);
  type McpReply = { result: { isError?: boolean; content: { text: string }[] } };
  const call = async (name: string, args = {}): Promise<McpReply> => (await fetch(bridge.config.url, { method: "POST", headers: { ...bridge.config.headers, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json() as Promise<McpReply>;
  try {
    assert.equal((await fetch(bridge.config.url, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await call("browser_start", { taskId: "other" })).result.isError, true);
    assert.equal((await call("browser_start")).result.isError, undefined);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const result = await call("browser_capture", { path: "/", viewport: { width: 390, height: 844 }, steps: [] });
    const evidence = JSON.parse(result.result.content[0]!.text) as ReviewEvidence; assert.equal(evidence.taskId, "t"); assert.equal(evidence.state, "passed");
    repo.updateTask(f.db, "t", { attempts: 2 }); assert.equal((await call("browser_status")).result.isError, true);
  } finally { await bridge.close(); await reviews.close(); await previews.close(); f.db.close(); }
  await assert.rejects(fetch(bridge.config.url, { method: "POST", headers: bridge.config.headers, body: "{}" }));
});


test("VW12: cleanup failure refuses success while retaining the completed model's usage", async () => {
  const f = fixture(); const service = new ActivationService(f.db);
  service.prepare = () => Promise.resolve({ instructions: "", close: () => Promise.reject(new Error("worker did not settle")) });
  try {
    const wrapped = service.wrap(f.project, { runner: "claude-code", run: () => Promise.resolve({ ok: true, exitReason: "completed", costUsd: 1.25, tokensIn: 100, tokensOut: 50, tokensCached: 10, summary: "Model finished" }) });
    const result = await wrapped.run({ model: "claude", cwd: f.project.localPath, prompt: "test", onLog() {} });
    assert.equal(result.ok, false); assert.equal(result.costUsd, 1.25); assert.equal(result.tokensCached, 10); assert.match(result.summary!, /cleanup failed/);
  } finally { f.db.close(); }
});
