import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { ResourceUnavailableError, type ExecutionProfile, type ExecutionStatusResponse, type ModelInvocation } from "@orc/types";
import { defaultSettings, normalizeSettings } from "./config";
import { initDb } from "./db/index";
import * as repo from "./db/repo";
import { ResourceManager } from "./resources";
import { persistInvocationEvent } from "./invocation-ledger";
import { ExecutionService } from "./execution";
import { DockerExecutionDriver, ExecutionUnsettledError, workerIdentity } from "./execution-docker";
import { registerExecutionRoutes } from "./execution-routes";
import { registerResourceRoutes } from "./resource-routes";

const profile: ExecutionProfile = { id: "isolated", name: "Codex worker", runner: "codex", kind: "docker", image: `sha256:${"a".repeat(64)}`, accountPoolId: "shared", accountVolume: "hoopedorc-account-test", cpus: 2, memoryMiB: 1024, pidsLimit: 128 };
function fixture(path = ":memory:") {
  const db = initDb(path); const settings = defaultSettings();
  settings.accountPools = [{ id: "shared", name: "Account", billing: "subscription", maxConcurrent: 1, reviewSlots: 0 }]; settings.executionProfiles = [profile];
  settings.models.push({ ...settings.models[0]!, id: "worker-codex", runner: "codex", codexModel: "fixture", enabled: true, executionProfileId: profile.id, accountPoolId: profile.accountPoolId });
  repo.upsertSettings(db, settings); return { db, settings, model: settings.models.find((model) => model.runner === "codex")! };
}
function saveWorker(service: ExecutionService, invocationId: string, state = "unresolved") {
  const identity = workerIdentity(service.owner); const now = new Date().toISOString();
  const record = { id: identity.id, invocationId, profileId: profile.id, imageId: profile.image, workerName: identity.workerName, proxyName: identity.proxyName, state, createdAt: now, updatedAt: now, identity, cwd: "/tmp/work", directory: join(service.root, "jobs", identity.id) };
  service.db.prepare("INSERT INTO execution_workers (id, invocation_id, profile_id, state, json) VALUES (?, ?, ?, ?, ?)").run(record.id, invocationId, profile.id, state, JSON.stringify(record)); return record;
}

test("VW14: normalize explicit supported profiles; never silently downgrade invalid selection", () => {
  const { db, settings } = fixture(); try {
    assert.equal(normalizeSettings(settings).executionProfiles?.[0]?.image, profile.image);
    for (const patch of [{ image: "mutable:latest" }, { accountVolume: "/home/operator" }, { runner: "claude-code" }, { memoryMiB: 1 }, { cpus: 0 }, { accountPoolId: "missing" }]) assert.throws(() => normalizeSettings({ ...settings, executionProfiles: [{ ...profile, ...patch }] }));
    assert.throws(() => normalizeSettings({ ...settings, executionProfiles: [] }), /same harness and account pool/);
    assert.throws(() => normalizeSettings({ ...settings, accountPools: [{ ...settings.accountPools![0], billing: "metered" }] }), /subscription/);
    assert.deepEqual(normalizeSettings({ ...defaultSettings(), executionProfiles: undefined }).executionProfiles, []);
  } finally { db.close(); }
});

test("VW14: terminal/unstarted ledger and restart retain uncertain Docker capacity; owned recovery is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "vw14-recovery-")); const path = join(root, "state.db"); let { db, model } = fixture(path);
  let stopped = 0; let failStop = true;
  const driver = new DockerExecutionDriver(); driver.stop = () => { stopped++; return failStop ? Promise.reject(new Error("daemon unavailable")) : Promise.resolve(); };
  let service = new ExecutionService(db, driver, join(root, "execution")); const resources = new ResourceManager(db);
  const id = randomUUID(); resources.reserve({ id, model: model.id, stage: "author" });
  const call: ModelInvocation = { id, model: model.id, runner: "codex", stage: "author", effort: "default", startedAt: new Date().toISOString(), outcome: "running", costUsd: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0 };
  persistInvocationEvent(db, call); const record = saveWorker(service, id, "running");
  persistInvocationEvent(db, { ...call, outcome: "failed", costUsd: 5, tokensIn: 10 });
  assert.equal(resources.response().unresolved.length, 1); assert.equal(repo.getInvocation(db, id)?.costUsd, 0);
  const pending = resources.response().unresolved[0]!; const request = { requestId: randomUUID(), expectedUpdatedAt: pending.updatedAt, confirmWorkerStopped: true as const };
  assert.throws(() => resources.recover(id, request), /isolated worker must be stopped/);
  assert.throws(() => repo.upsertSettings(db, { ...defaultSettings(), accountPools: [{ id: "shared", name: "Account", billing: "subscription", maxConcurrent: 1, reviewSlots: 0 }] }), /cannot remove a profile/);
  db.close(); ({ db, model } = fixture(path)); service = new ExecutionService(db, driver, join(root, "execution"));
  try {
    await service.recover(); assert.equal(service.response().workers[0]!.state, "unresolved"); assert.equal(new ResourceManager(db).response().unresolved.length, 1);
    await assert.rejects(service.stop(record.id), ExecutionUnsettledError);
    const app = Fastify(); registerResourceRoutes(app, new ResourceManager(db), (id) => service.stopInvocation(id));
    const current = new ResourceManager(db).response().unresolved[0]!; const body = { ...request, expectedUpdatedAt: current.updatedAt };
    const before = stopped; assert.equal((await app.inject({ method: "POST", url: `/api/resources/${id}/recover`, payload: { ...body, confirmWorkerStopped: false } })).statusCode, 409); assert.equal(stopped, before);
    failStop = false;
    const result = await app.inject({ method: "POST", url: `/api/resources/${id}/recover`, payload: body }); assert.equal(result.statusCode, 200, result.body);
    assert.equal((await app.inject({ method: "POST", url: `/api/resources/${id}/recover`, payload: body })).statusCode, 200); assert.equal(stopped, before + 1);
    assert.equal(service.response().workers[0]!.state, "stopped"); await app.close();
    const unstartedId = randomUUID(); new ResourceManager(db).reserve({ id: unstartedId, model: model.id, stage: "health" }); saveWorker(service, unstartedId, "preparing"); new ResourceManager(db).releaseUnstarted(unstartedId); assert.equal(new ResourceManager(db).response().unresolved.length, 1);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("VW14: unavailable image/auth refuses before adapter prompt and mock routes never invoke Docker", async () => {
  const { db, model } = fixture(); const root = await mkdtemp(join(tmpdir(), "vw14-refusal-"));
  const driver = new DockerExecutionDriver(); let probes = 0; driver.inspectProfile = () => { probes++; return Promise.reject(new ResourceUnavailableError("Worker image unavailable", false)); };
  const service = new ExecutionService(db, driver, join(root, "execution")); let prompts = 0;
  try {
    assert.match((await service.check(model))!, /Worker image unavailable/);
    const wrapped = service.wrap(undefined, model, { runner: "codex", run: () => { prompts++; return Promise.reject(new Error("must not run")); } });
    await assert.rejects(wrapped.run({ model: model.id, cwd: root, prompt: "private", onLog: () => {}, invocation: { id: randomUUID(), stage: "health" } }), /Worker image unavailable/); assert.equal(prompts, 0);
    const app = Fastify(); registerExecutionRoutes(app, service, true); const before = probes;
    assert.equal((await app.inject({ method: "POST", url: `/api/execution/profiles/${profile.id}/verify` })).statusCode, 409); assert.equal(probes, before);
    const response = (await app.inject({ method: "GET", url: "/api/execution" })).json<ExecutionStatusResponse>(); assert.equal(response.host.filesystemIsolated, false); assert.equal(response.profiles[0]!.state, "unavailable"); await app.close();
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("VW14: Docker cleanup refuses foreign labels and retains daemon failures instead of interpreting absence", async () => {
  const identity = workerIdentity("installation"); const commands: string[][] = [];
  const driver = new DockerExecutionDriver();
  driver.command = (args) => { commands.push(args); return Promise.resolve(args.includes("ls") ? "foreign-id" : JSON.stringify([{ Config: { Labels: { "io.hoopedorc.owner": "someone-else" } } }])); };
  await assert.rejects(driver.stop(identity), ExecutionUnsettledError); assert.equal(commands.some((args) => args.includes("rm")), false);
  driver.command = () => Promise.reject(new Error("daemon unavailable")); await assert.rejects(driver.stop(identity), /daemon unavailable/);
});

test("VW14: cleanup failure preserves observed usage once while retaining the account slot", async () => {
  const { db, model } = fixture(); const root = await mkdtemp(join(tmpdir(), "vw14-usage-")); const service = new ExecutionService(db, new DockerExecutionDriver(), join(root, "execution"));
  const id = randomUUID(); const resources = new ResourceManager(db); resources.reserve({ id, model: model.id, stage: "health" });
  persistInvocationEvent(db, { id, model: model.id, runner: "codex", stage: "health", effort: "default", startedAt: new Date().toISOString(), outcome: "running", costUsd: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0 }); saveWorker(service, id);
  service.prepare = () => Promise.resolve({ execution: { outputDirectory: root, spawn: () => { throw new Error("fixture has no process"); }, close: () => Promise.resolve() }, finish: () => Promise.reject(new ExecutionUnsettledError()) });
  try {
    const adapter = service.wrap(undefined, model, { runner: "codex", run: () => Promise.resolve({ ok: true, exitReason: "completed", costUsd: 5, tokensIn: 20, tokensOut: 10 }) });
    await assert.rejects(adapter.run({ invocation: { id, stage: "health" }, model: model.id, cwd: root, prompt: "fixture", onLog: () => {} }), ExecutionUnsettledError);
    const saved = repo.getInvocation(db, id)!; assert.equal(saved.tokensIn, 20); assert.equal(saved.reportedCostUsd, 5); assert.equal(saved.costUsd, 0); assert.equal(saved.outcome, "failed");
    persistInvocationEvent(db, { ...saved, tokensIn: 0 }); assert.equal(repo.getInvocation(db, id)?.tokensIn, 20); assert.equal(resources.response().unresolved.length, 1);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("VW14: concurrent profile checks share one bounded probe and overlapping control workspaces refuse first", async () => {
  const { db, model } = fixture(); const root = await mkdtemp(join(tmpdir(), "vw14-check-")); const driver = new DockerExecutionDriver(); let probes = 0;
  let finish!: () => void; const pending = new Promise<void>((resolve) => { finish = resolve; });
  driver.inspectProfile = async () => { probes++; await pending; throw new ResourceUnavailableError("Image unavailable", false); };
  const service = new ExecutionService(db, driver, join(root, "control"));
  try {
    const first = service.verify(profile); const second = service.verify(profile); finish(); await Promise.all([first, second]); assert.equal(probes, 1);
    const project = repo.createProject(db, { id: "overlap", name: "Overlap", repoUrl: "", localPath: root, defaultBranch: "main", status: "created" });
    await assert.rejects(service.prepare(model, randomUUID(), root, "planner", undefined, project), /overlaps control-plane/); assert.equal(probes, 1);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
