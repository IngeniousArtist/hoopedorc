import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initDb, type Db } from "./db/index.js";
import * as repo from "./db/repo.js";
import { activePlanningOperation, getPlanningOperation, PlanningOperations, type PlanningExecutionResult } from "./planning-operations.js";

function project(db: Db) {
  repo.createProject(db, { id: "p", name: "Planning", repoUrl: "https://example.com/p", localPath: "/unused", defaultBranch: "main", status: "paused" });
  return repo.ensurePlanningRevision(db, "p");
}
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const result = (): PlanningExecutionResult => ({ result: { reply: "Done", costUsd: 0 }, update: { messages: [{ role: "assistant", content: "Done" }] } });
function manager(db: Db, execute: () => Promise<PlanningExecutionResult>) {
  return new PlanningOperations({ db, controllers: new Set(), execute, own: (_label, run) => { void run().catch(() => {}); },
    onUpdate: () => {}, warn: () => {}, error: (error) => ({ message: String(error), status: 409 }) });
}

test("VW06: exact submissions execute/finalize once; conflicts and project-crossing reads refuse", async () => {
  const db = initDb(":memory:");
  const revisionId = project(db);
  const done = deferred<PlanningExecutionResult>();
  let calls = 0;
  const operations = manager(db, () => { calls++; return done.promise; });
  const input = { revisionId, operationId: randomUUID(), sessionVersion: 0, messages: [{ role: "user" as const, content: "Build it" }] };
  try {
    const first = operations.start("p", "chat", input);
    assert.equal(operations.start("p", "chat", input).id, first.id);
    assert.throws(() => operations.start("p", "chat", { ...input, messages: [{ role: "user", content: "Different" }] }), /different planning request/);
    assert.throws(() => operations.start("p", "chat", { ...input, operationId: randomUUID() }), /already active/);
    assert.equal(getPlanningOperation(db, "another-project", first.id), null);
    await Promise.resolve();
    assert.equal(calls, 1);
    done.resolve(result());
    const completed = await operations.wait("p", first.id);
    assert.equal(completed.state, "succeeded");
    assert.equal(completed.result?.sessionVersion, 1);
    assert.equal(repo.getPlanningSession(db, "p").messages.length, 1);
    assert.equal(operations.start("p", "chat", input).state, "succeeded");
    assert.equal(calls, 1);
    assert.throws(() => operations.start("p", "chat", { ...input, operationId: randomUUID() }), /session changed/);
  } finally { await operations.stop(); db.close(); }
});

test("VW06: cancellation keeps ownership until execution settles and preserves the previous draft", async () => {
  const db = initDb(":memory:");
  const revisionId = project(db);
  repo.savePlanningSession(db, "p", { prd: "Existing draft" });
  const done = deferred<PlanningExecutionResult>();
  const operations = manager(db, () => done.promise);
  try {
    const operation = operations.start("p", "deconstruct", { revisionId, sessionVersion: 1, messages: [{ role: "user", content: "Replace draft" }] });
    await Promise.resolve();
    assert.equal(operations.cancel("p", operation.id).state, "cancelling");
    assert.equal(activePlanningOperation(db, "p")?.id, operation.id);
    done.resolve(result());
    assert.equal((await operations.wait("p", operation.id)).state, "cancelled");
    assert.equal(activePlanningOperation(db, "p"), null);
    assert.equal(repo.getPlanningSession(db, "p").prd, "Existing draft");
    assert.equal(repo.getPlanningSession(db, "p").sessionVersion, 1);
  } finally { await operations.stop(); db.close(); }
});

test("VW06: stale results and failed finalization never partially overwrite a session", async () => {
  const db = initDb(":memory:");
  const revisionId = project(db);
  let done = deferred<PlanningExecutionResult>();
  const operations = manager(db, () => done.promise);
  try {
    const operation = operations.start("p", "chat", { revisionId, messages: [{ role: "user", content: "Old" }] });
    await Promise.resolve();
    repo.savePlanningSession(db, "p", { messages: [{ role: "user", content: "Newer state" }] });
    done.resolve(result());
    assert.equal((await operations.wait("p", operation.id)).state, "failed");
    assert.equal(repo.getPlanningSession(db, "p").messages[0]?.content, "Newer state");
    done = deferred<PlanningExecutionResult>();
    const second = operations.start("p", "chat", { revisionId, messages: [{ role: "user", content: "New request" }] });
    db.exec("CREATE TRIGGER refuse_result BEFORE UPDATE OF state ON planning_operations WHEN NEW.state = 'succeeded' BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END");
    done.resolve(result());
    assert.equal((await operations.wait("p", second.id)).state, "failed");
    assert.equal(repo.getPlanningSession(db, "p").sessionVersion, 1);
    assert.equal(repo.getPlanningSession(db, "p").messages[0]?.content, "Newer state");
  } finally { await operations.stop(); db.close(); }
});

test("VW06: restart recovery is idempotent and retry creates one separately identified attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hoopedorc-vw06-"));
  const path = join(dir, "state.sqlite");
  let db = initDb(path);
  const revisionId = project(db);
  const id = randomUUID();
  db.prepare("INSERT INTO planning_operations (id, project_id, revision_id, kind, state, input_json, created_at) VALUES (?, 'p', ?, 'chat', 'running', ?, ?)")
    .run(id, revisionId, JSON.stringify({ revisionId, sessionVersion: 0, messages: [{ role: "user", content: "Retained request" }] }), new Date().toISOString());
  db.close();
  db = initDb(path);
  assert.equal(getPlanningOperation(db, "p", id)?.state, "interrupted");
  const endedAt = getPlanningOperation(db, "p", id)?.endedAt;
  db.close();
  db = initDb(path);
  assert.equal(getPlanningOperation(db, "p", id)?.endedAt, endedAt);
  let calls = 0;
  const done = deferred<PlanningExecutionResult>();
  const operations = manager(db, () => { calls++; return done.promise; });
  try {
    assert.equal(calls, 0, "restart never calls a model automatically");
    const retry = operations.retry("p", id);
    assert.notEqual(retry.id, id);
    assert.equal(retry.retryOf, id);
    assert.equal(retry.input.messages[0]?.content, "Retained request");
    assert.equal(operations.retry("p", id).id, retry.id);
    done.resolve(result());
    assert.equal((await operations.wait("p", retry.id)).state, "succeeded");
    assert.equal(calls, 1);
    assert.equal(operations.retry("p", id).id, retry.id, "lost retry responses replay the same child");
  } finally { await operations.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("VW06: upgrading an older database preserves its planning draft", () => {
  const dir = mkdtempSync(join(tmpdir(), "hoopedorc-vw06-upgrade-"));
  const path = join(dir, "old.sqlite");
  let db = initDb(path);
  project(db);
  repo.savePlanningSession(db, "p", { prd: "Keep this operator draft" });
  db.exec("DROP TABLE planning_operation_invocations; DROP TABLE planning_operations; ALTER TABLE projects DROP COLUMN planning_version");
  db.close();
  try {
    db = initDb(path);
    assert.equal(repo.getPlanningSession(db, "p").prd, "Keep this operator draft");
    assert.equal(repo.getPlanningSession(db, "p").sessionVersion, 0);
    assert.equal(activePlanningOperation(db, "p"), null);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
