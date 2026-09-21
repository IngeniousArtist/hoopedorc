import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import type { PreviewProfile } from "@orc/types";
import { workspaceRetained, WorktreeManagerImpl } from "@orc/engine";
import { defaultSettings } from "./config";
import { initDb } from "./db/index";
import * as repo from "./db/repo";
import { PreviewManager, previewOwnsPort } from "./previews";
import { parsePreviewProfile, previewSlots } from "./preview-policy";

const require = createRequire(import.meta.url);
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
async function freePort() {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}
const profile: PreviewProfile = { command: process.execPath, args: ["server.cjs"], readinessPath: "/", startupTimeoutSeconds: 5 };
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hoop-vw09-")); const localPath = join(root, "primary"); mkdirSync(localPath);
  git(localPath, ["init", "-qb", "main"]); git(localPath, ["config", "user.name", "Preview Test"]); git(localPath, ["config", "user.email", "preview@test.local"]);
  writeFileSync(join(localPath, "server.cjs"), `const http=require('node:http');const {WebSocketServer}=require(${JSON.stringify(require.resolve("ws"))});
const server=http.createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{Location:'http://169.254.169.254/latest'}).end();return;}
res.setHeader('Set-Cookie','session=app-cookie; Path=/; HttpOnly');res.end(JSON.stringify({url:req.url,authorization:req.headers.authorization,cookie:req.headers.cookie,controlToken:process.env.API_TOKEN}));});
const ws=new WebSocketServer({server});ws.on('connection',socket=>socket.on('message',message=>socket.send(message)));
server.listen(Number(process.env.PORT),process.env.HOST);`);
  git(localPath, ["add", "."]); git(localPath, ["commit", "-qm", "initial"]);
  const path = `${localPath}-wt-t`; git(localPath, ["worktree", "add", "-qb", "orc/t", path]);
  const db = initDb(join(root, "state.sqlite")); repo.upsertSettings(db, defaultSettings());
  const project = repo.createProject(db, { id: "p", name: "Preview", repoUrl: "unused", localPath, defaultBranch: "main", status: "paused", config: { preview: profile } });
  repo.createTask(db, { id: "t", projectId: "p", title: "Preview task", description: "", difficulty: "easy", assignedModel: "codex", status: "in_review",
    acceptanceCriteria: [], dependsOn: [], scopePaths: [], attempts: 1, maxAttempts: 3, branch: "orc/t", worktreePath: path });
  const task = repo.updateTask(db, "t", { branch: "orc/t", worktreePath: path })!;
  const port = await freePort(); const slots = [{ port, origin: `http://127.0.0.1:${port}` }];
  const manager = new PreviewManager(db, slots);
  return { root, path, db, project, task, port, slots, manager };
}
async function waitFor(run: () => boolean, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!run()) { if (Date.now() >= end) throw new Error("condition timed out"); await new Promise((resolve) => setTimeout(resolve, 40)); }
}

test("VW09: real preview owns its process, authenticates HTTP/WS, strips secrets, and settles repeated stop", async () => {
  const f = await fixture(); const priorToken = process.env.API_TOKEN; process.env.API_TOKEN = "control-plane-must-not-leak";
  try {
    const first = f.manager.start(f.project, f.task, profile);
    assert.equal(f.manager.start(f.project, f.task, profile).id, first.id);
    assert.equal(workspaceRetained(f.path), true);
    await new WorktreeManagerImpl().remove(f.project, f.task);
    assert.equal(existsSync(f.path), true, "engine cleanup retains an active preview worktree");
    await assert.rejects(new WorktreeManagerImpl().create(f.project, f.task), /Stop this task's preview/, "replacement refuses before touching remote branches");
    await waitFor(() => f.manager.latest("p", "t")?.state !== "starting");
    assert.equal(f.manager.latest("p", "t")?.state, "ready", f.manager.latest("p", "t")?.detail);
    assert.equal((await fetch(f.slots[0]!.origin)).status, 401);
    assert.throws(() => f.manager.open("p", "t", f.slots[0]!.origin), /differ/);
    const launch = f.manager.open("p", "t", "http://127.0.0.1:4317");
    const browserLaunch = f.manager.open("p", "t", "http://127.0.0.1:4317");
    const exchange = await fetch(launch.url, { redirect: "manual" }); assert.equal(exchange.status, 303);
    const session = exchange.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal((await fetch(launch.url, { redirect: "manual" })).status, 401, "tickets are one-use");
    assert.equal((await fetch(browserLaunch.url, { redirect: "manual" })).status, 303, "browser capture and operator links do not revoke each other");
    const response = await fetch(f.slots[0]!.origin, { headers: { cookie: `${session}; control=session-secret`, authorization: "Bearer control-secret" } });
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.authorization, undefined); assert.equal(body.cookie, undefined); assert.equal(body.controlToken, undefined);
    const applicationCookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const second = await fetch(f.slots[0]!.origin, { headers: { cookie: `${session}; ${applicationCookie}; other=not-forwarded` } });
    assert.equal(((await second.json()) as { cookie: string }).cookie, "session=app-cookie");
    assert.equal((await fetch(`${f.slots[0]!.origin}/redirect`, { headers: { cookie: session }, redirect: "manual" })).status, 502);
    assert.equal((await fetch(f.slots[0]!.origin, { method: "POST", headers: { cookie: session, origin: "http://evil.test" } })).status, 403);
    assert.equal((await fetch(f.slots[0]!.origin, { headers: { cookie: session, "service-worker": "script" } })).status, 403);
    const ws = new WebSocket(f.slots[0]!.origin.replace("http:", "ws:"), { headers: { cookie: session, origin: f.slots[0]!.origin } });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const echoed = new Promise<unknown>((resolve) => ws.once("message", resolve)); ws.send("preview echo"); assert.deepEqual(await echoed, Buffer.from("preview echo"));
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    const [stopped, repeated] = await Promise.all([f.manager.stop("p", "t"), f.manager.stop("p", "t")]);
    assert.equal(stopped?.state, "stopped"); assert.equal(repeated?.state, "stopped"); await closed;
    assert.equal(workspaceRetained(f.path), false);
    assert.equal(f.manager.hasActivity("p"), false);
    assert.throws(() => f.manager.open("p", "t"), /not ready/);
    await new WorktreeManagerImpl().remove(f.project, f.task);
    assert.equal(existsSync(f.path), false, "cleanup works after the preview settles");
  } finally { if (priorToken === undefined) delete process.env.API_TOKEN; else process.env.API_TOKEN = priorToken; await f.manager.close(); f.db.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("VW09: readiness timeout settles its group and a vanished workspace revokes access", async () => {
  const f = await fixture();
  try {
    f.manager.start(f.project, f.task, { ...profile, args: ["-e", "setInterval(()=>{},1000)"] });
    await waitFor(() => f.manager.latest("p", "t")?.state === "failed");
    assert.match(f.manager.latest("p", "t")!.detail, /readiness timed out/);
    assert.equal(workspaceRetained(f.path), false);
    f.manager.start(f.project, f.task, profile);
    await waitFor(() => f.manager.latest("p", "t")?.state === "ready");
    const launch = f.manager.open("p", "t");
    const exchange = await fetch(launch.url, { redirect: "manual" });
    const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
    repo.updateTask(f.db, "t", { worktreePath: undefined });
    await fetch(f.slots[0]!.origin, { headers: { cookie } }).catch(() => undefined);
    await waitFor(() => f.manager.latest("p", "t")?.state === "failed");
    assert.match(f.manager.latest("p", "t")!.detail, /no longer owned/);
  } finally { await f.manager.close(); f.db.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("VW09: abrupt owner death settles the child group and restart records an interrupted generation", async () => {
  const f = await fixture(); await f.manager.close(); f.db.close();
  const harness = join(f.root, "owner.mjs");
  writeFileSync(harness, `import {PreviewManager} from ${JSON.stringify(new URL("./previews.ts", import.meta.url).href)};
import {initDb} from ${JSON.stringify(new URL("./db/index.ts", import.meta.url).href)};
import * as repo from ${JSON.stringify(new URL("./db/repo.ts", import.meta.url).href)};
const db=initDb(${JSON.stringify(join(f.root, "state.sqlite"))});
const manager=new PreviewManager(db,${JSON.stringify(f.slots)});
const value=manager.start(repo.getProject(db,'p'),repo.getTask(db,'t'),${JSON.stringify(profile)});
const timer=setInterval(()=>{const current=manager.latest('p','t');if(current.state!=='starting') {clearInterval(timer);process.send({value:current,pid:db.prepare('SELECT child_pid FROM workspace_previews WHERE id=?').get(value.id).child_pid});}},50);`);
  const child = fork(harness, [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let recovery: PreviewManager | undefined; let db: ReturnType<typeof initDb> | undefined;
  try {
    const message = await new Promise<{ value: { state: string; detail: string; id: string }; pid: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("owner did not become ready")), 10_000);
      child.once("message", (value) => { clearTimeout(timer); resolve(value as never); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("owner exited before reporting readiness")); });
    });
    assert.equal(message.value.state, "ready", message.value.detail);
    child.kill("SIGKILL"); await closed;
    await waitFor(() => { try { process.kill(-message.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } });
    db = initDb(join(f.root, "state.sqlite")); recovery = new PreviewManager(db, f.slots);
    assert.equal(recovery.latest("p", "t")?.state, "interrupted");
    assert.throws(() => recovery!.open("p", "t"), /not ready/);
    await assert.rejects(fetch(f.slots[0]!.origin));
    const restarted = recovery.start(repo.getProject(db, "p")!, repo.getTask(db, "t")!, profile);
    assert.notEqual(restarted.id, message.value.id);
    await waitFor(() => recovery!.latest("p", "t")?.state === "ready");
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; await recovery?.close(); db?.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("VW09: sandbox refusal, conflicting proxy port, spawn failure and stop while starting preserve workspace", async () => {
  const f = await fixture();
  try {
    repo.upsertSettings(f.db, { ...defaultSettings(), sandboxGates: "required" });
    assert.throws(() => f.manager.start(f.project, f.task, profile), /requires sandboxing/);
    repo.upsertSettings(f.db, defaultSettings());
    const conflict = createServer(); await new Promise<void>((resolve) => conflict.listen(f.port, "127.0.0.1", resolve));
    f.manager.start(f.project, f.task, profile);
    await waitFor(() => f.manager.latest("p", "t")?.state === "failed");
    assert.match(f.manager.latest("p", "t")!.detail, /EADDRINUSE|address already in use/);
    await new Promise<void>((resolve) => conflict.close(() => resolve()));
    f.manager.start(f.project, f.task, { ...profile, command: "hoopedorc-nonexistent-preview-command" });
    await waitFor(() => f.manager.latest("p", "t")?.state === "failed");
    f.manager.start(f.project, f.task, profile);
    assert.equal((await f.manager.stop("p", "t"))?.state, "stopped");
    assert.equal(workspaceRetained(f.path), false);
  } finally { await f.manager.close(); f.db.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("VW09: profiles and public origins refuse unbounded or arbitrary-target configuration", () => {
  assert.ok("value" in parsePreviewProfile(profile));
  assert.ok("error" in parsePreviewProfile({ ...profile, readinessPath: "//example.com" }));
  assert.ok("error" in parsePreviewProfile({ ...profile, startupTimeoutSeconds: 999 }));
  assert.throws(() => previewSlots("4318,4318"));
  assert.throws(() => previewSlots("4318", "http://example.com"));
  assert.throws(() => previewSlots("4318", "https://example.com/path"));
  assert.deepEqual(previewSlots("4318", "https://my-private-host.test:8443"), [{ port: 4318, origin: "https://my-private-host.test:8443" }]);
});

test("VW09: readiness refuses a listening port owned by another process", async () => {
  const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await assert.rejects(previewOwnsPort(address.port, 999999999), /another process/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
