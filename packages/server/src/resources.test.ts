import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { ResourceUnavailableError, type AccountPool, type ModelInvocation, type InvocationStage } from "@orc/types";
import { defaultSettings, normalizeSettings } from "./config";
import { initDb } from "./db/index";
import * as repo from "./db/repo";
import { persistInvocationEvent } from "./invocation-ledger";
import { ResourceManager } from "./resources";
import { registerResourceRoutes } from "./resource-routes";
import { testModels } from "./setup";

const pool: AccountPool = { id: "shared", name: "Shared login", billing: "subscription", maxConcurrent: 2, reviewSlots: 1 };
function fixture(path = ":memory:", overrides: Partial<AccountPool> = {}) {
  const db = initDb(path); const settings = defaultSettings();
  settings.accountPools = [{ ...pool, ...overrides }];
  settings.models = settings.models.map((model) => ({ ...model, accountPoolId: pool.id, enabled: true }));
  repo.upsertSettings(db, settings);
  for (const id of ["p1", "p2"]) repo.createProject(db, { id, name: id, repoUrl: "", defaultBranch: "main", localPath: "/tmp", status: "created" });
  return { db, resources: new ResourceManager(db), settings };
}
function event(id: string, model: string, stage: InvocationStage = "author", projectId = "p1"): ModelInvocation {
  return { id, model, stage, projectId, runner: "claude-code", effort: "default", startedAt: new Date().toISOString(), outcome: "running", costUsd: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0 };
}
function finish(db: ReturnType<typeof initDb>, call: ModelInvocation, patch: Partial<ModelInvocation> = {}) {
  return persistInvocationEvent(db, { ...call, outcome: "completed", exitReason: "completed", costUsd: 4, tokensIn: 100, tokensOut: 20, tokensCached: 10, ...patch });
}

test("VW13: shared admission is atomic across profiles/projects, protects review capacity and bills once", () => {
  const { db, resources, settings } = fixture();
  try {
    const author = event("author", settings.models[0]!.id);
    const competing = event("competing", settings.models[1]!.id, "planner", "p2");
    const validator = { ...competing, id: "review", stage: "validator" as const };
    assert.throws(() => persistInvocationEvent(db, author), ResourceUnavailableError);
    resources.reserve(author); resources.reserve(author);
    assert.equal(resources.response().pools[0]!.observedCalls, 1);
    assert.throws(() => new ResourceManager(db).reserve(competing), /review capacity/);
    resources.reserve(validator);
    persistInvocationEvent(db, author); persistInvocationEvent(db, author); persistInvocationEvent(db, validator);
    assert.equal(resources.response().pools[0]!.observedCalls, 2, "reserved calls must not count twice at start");
    resources.releaseUnstarted(author.id);
    assert.equal(resources.response().pools[0]!.active, 2, "cleanup cannot release a running worker");
    const saved = finish(db, author); finish(db, author, { costUsd: 99 });
    assert.equal(saved.invocation.costUsd, 0); assert.equal(saved.invocation.reportedCostUsd, 4);
    assert.equal(repo.getInvocation(db, author.id)!.tokensIn, 100);
    assert.equal(resources.response().pools[0]!.active, 1);
    resources.reserve(competing); resources.releaseUnstarted(competing.id); resources.reserve(competing);
    assert.throws(() => resources.reserve({ ...validator, model: author.model }), /identity/);
    finish(db, validator); resources.releaseUnstarted(competing.id);
    assert.equal(resources.response().pools[0]!.observedCalls, 2);
  } finally { db.close(); }
});

test("VW13: rolling quota, observed spend and cooldown are shared; pricing is fixed at admission", () => {
  const { db, resources, settings } = fixture(":memory:", { billing: "metered", reviewSlots: 0, quota: { windowHours: 1, maxCalls: 2 } });
  try {
    settings.models[0]!.costPerMInputUsd = 10;
    repo.upsertSettings(db, settings);
    const first = event("first", settings.models[0]!.id); const second = event("second", settings.models[1]!.id, "health", "p2");
    resources.reserve(first); persistInvocationEvent(db, first); resources.reserve(second);
    settings.models[0]!.costPerMInputUsd = 999;
    repo.upsertSettings(db, settings);
    assert.equal(finish(db, first, { tokensIn: 1_000_000 }).invocation.costUsd, 10);
    persistInvocationEvent(db, second); finish(db, second, { outcome: "failed", exitReason: "rate_limited" });
    assert.match(resources.check(first.model)!, /cooling down/);
    assert.ok(resources.coolingDownUntil(second.model));
    const future = new ResourceManager(db, () => Date.now() + 6 * 60_000);
    assert.match(future.check(first.model)!, /2\/2/);
    settings.accountPools![0]!.quota = { windowHours: 1, maxCostUsd: 5 }; repo.upsertSettings(db, settings);
    assert.match(future.check(second.model)!, /observed cost limit/);
    assert.equal(new ResourceManager(db, () => Date.now() + 2 * 3_600_000).check(first.model), null);
  } finally { db.close(); }
});

test("VW13: all model stages require admission; queued cancellation and health refusal start no calls", async () => {
  const { db, resources, settings } = fixture(":memory:", { maxConcurrent: 1, reviewSlots: 0 });
  try {
    const stages: InvocationStage[] = ["author", "validator", "docs", "planner", "deconstructor", "health"];
    for (const stage of stages) {
      const call = event(stage, settings.models[0]!.id, stage);
      assert.throws(() => persistInvocationEvent(db, call), ResourceUnavailableError);
      resources.reserve(call); persistInvocationEvent(db, call); finish(db, call);
    }
    const occupied = event("occupied", settings.models[0]!.id); resources.reserve(occupied);
    const controller = new AbortController(); let waiting = 0;
    const pending = resources.acquire(event("waiting", settings.models[1]!.id), controller.signal, true, () => { waiting++; });
    controller.abort(); await assert.rejects(pending); assert.equal(waiting, 1);
    assert.equal(repo.getInvocation(db, "waiting"), null);
    const events: ModelInvocation[] = [];
    const results = await testModels(settings, "http://unused", (item) => events.push(item), undefined, (model, id, signal) => resources.guard({ id, model: model.id, stage: "health" }, signal, false));
    assert.equal(events.length, 0); assert.ok(results.results.every((result) => !result.ok && !result.invocationId));
  } finally { db.close(); }
});

test("VW13: restart retains unknown workers, releases unstarted reservations and recovery is versioned/idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "vw13-recovery-")); const path = join(root, "db.sqlite");
  const initial = fixture(path, { maxConcurrent: 3, reviewSlots: 0 });
  let { db, resources } = initial; const { settings } = initial;
  const first = event("active", settings.models[0]!.id); const reserved = event("reserved", first.model);
  resources.reserve(first); persistInvocationEvent(db, first); resources.reserve(reserved); db.close();
  db = initDb(path); resources = new ResourceManager(db);
  const app = Fastify(); registerResourceRoutes(app, resources);
  try {
    assert.equal(repo.getInvocation(db, first.id)!.outcome, "interrupted");
    let state = resources.response(); assert.equal(state.unresolved.length, 1); assert.equal(state.pools[0]!.reserved, 0);
    assert.equal(state.pools[0]!.unknownSpendCalls, 1);
    assert.throws(() => repo.upsertSettings(db, { ...settings, accountPools: [], models: settings.models.map((model) => ({ ...model, accountPoolId: undefined })) }), /cannot remove/);
    const request = { requestId: randomUUID(), expectedUpdatedAt: state.unresolved[0]!.updatedAt, confirmWorkerStopped: true as const };
    const url = `/api/resources/${first.id}/recover`;
    assert.equal((await app.inject({ method: "POST", url, payload: { ...request, expectedUpdatedAt: "stale" } })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url, payload: { ...request, confirmWorkerStopped: false } })).statusCode, 409);
    const saved = await app.inject({ method: "POST", url, payload: request }); assert.equal(saved.statusCode, 200);
    const retry = await app.inject({ method: "POST", url, payload: { confirmWorkerStopped: true, expectedUpdatedAt: request.expectedUpdatedAt, requestId: request.requestId } });
    assert.deepEqual(retry.json(), saved.json());
    assert.equal((await app.inject({ method: "POST", url: "/api/resources/other/recover", payload: request })).statusCode, 409);
    state = (await app.inject({ method: "GET", url: "/api/resources" })).json(); assert.equal(state.unresolved.length, 0);
    assert.equal(repo.getInvocation(db, first.id)!.outcome, "interrupted");
    resources.reserve(reserved); resources.releaseUnstarted(reserved.id);
    assert.throws(() => resources.reserve(first), /already released/);
    db.close(); db = initDb(path); assert.equal(new ResourceManager(db).response().unresolved.length, 0);
  } finally { await app.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("VW13: normalized pool membership is explicit and unpooled in-flight pricing survives later membership", () => {
  const db = initDb(":memory:");
  try {
    const settings = defaultSettings(); repo.upsertSettings(db, settings); const resources = new ResourceManager(db);
    assert.deepEqual(settings.accountPools, []);
    assert.throws(() => normalizeSettings({ ...settings, accountPools: [{ ...pool, reviewSlots: 2 }] }), /reviewSlots/);
    assert.throws(() => normalizeSettings({ ...settings, accountPools: [{ ...pool, quota: { windowHours: 1, maxCostUsd: 5 } }] }), /subscription/);
    assert.throws(() => normalizeSettings({ ...settings, models: settings.models.map((model) => ({ ...model, accountPoolId: "missing" })) }), /accountPoolId/);
    const call = { ...event("unpooled", settings.models[0]!.id, "health"), projectId: undefined };
    const accounting = resources.reserve(call);
    repo.upsertSettings(db, { ...settings, accountPools: [pool], models: settings.models.map((model) => ({ ...model, accountPoolId: pool.id })) });
    persistInvocationEvent(db, { ...call, accounting });
    assert.equal(finish(db, call).invocation.costUsd, 4);
    assert.equal(resources.response().pools[0]!.observedCalls, 0, "new membership cannot rewrite old history");
  } finally { db.close(); }
});
