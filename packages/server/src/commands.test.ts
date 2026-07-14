import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSettings } from "./config.js";
import { initDb } from "./db/index.js";
import * as repo from "./db/repo.js";
import { EngineRunner } from "./engine-runner.js";
import { WsHub } from "./ws-hub.js";
import { findTaskByIdPrefix, retryTask, setMergePolicy, stopAllProjects } from "./commands.js";

function setup() {
  const db = initDb(":memory:");
  repo.upsertSettings(db, defaultSettings());
  return db;
}

function project(db: ReturnType<typeof initDb>, id: string) {
  return repo.createProject(db, {
    id,
    name: id,
    repoUrl: "https://github.com/x/y",
    defaultBranch: "main",
    localPath: `/tmp/${id}`,
    status: "created",
  });
}

function task(
  db: ReturnType<typeof initDb>,
  id: string,
  projectId: string,
  status: string,
) {
  return repo.createTask(db, {
    id,
    projectId,
    title: `Task ${id}`,
    description: "",
    difficulty: "medium",
    status: status as never,
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash" as never,
    scopePaths: [],
    attempts: 0,
    maxAttempts: 3,
  });
}

test("setMergePolicy: flips the policy, persists it, and audit-logs against every project", () => {
  const db = setup();
  project(db, "p1");
  project(db, "p2");

  setMergePolicy(db, "fully_autonomous", "telegram");

  const saved = repo.getSettings(db)!;
  assert.equal(saved.mergePolicy, "fully_autonomous");

  for (const pid of ["p1", "p2"]) {
    const entries = repo.getAuditLog(db, pid);
    const match = entries.find((e) => e.kind === "settings_changed");
    assert.ok(match, `expected a settings_changed audit entry for ${pid}`);
    assert.equal(match!.actor, "telegram");
    assert.match(match!.summary, /fully_autonomous/);
  }
});

test("setMergePolicy: flipping back to hard_gate_flag_risky persists that too", () => {
  const db = setup();
  project(db, "p1");
  setMergePolicy(db, "fully_autonomous", "telegram");
  setMergePolicy(db, "hard_gate_flag_risky", "telegram");
  assert.equal(repo.getSettings(db)!.mergePolicy, "hard_gate_flag_risky");
});

test("B37: Telegram policy changes pass through the shared settings validator", () => {
  const db = setup();
  assert.throws(
    () => setMergePolicy(db, "invalid" as never, "telegram"),
    /mergePolicy must be one of/,
  );
  assert.equal(repo.getSettings(db)!.mergePolicy, "hard_gate_flag_risky");
});

test("findTaskByIdPrefix: a unique prefix match resolves to that task", () => {
  const db = setup();
  project(db, "p1");
  task(db, "abc123", "p1", "failed");
  task(db, "def456", "p1", "failed");

  const result = findTaskByIdPrefix(db, "abc");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.task.id, "abc123");
});

test("findTaskByIdPrefix: no match returns a clear error", () => {
  const db = setup();
  project(db, "p1");
  task(db, "abc123", "p1", "failed");

  const result = findTaskByIdPrefix(db, "zzz");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /No task matches/);
});

test("findTaskByIdPrefix: an ambiguous prefix lists every candidate instead of guessing", () => {
  const db = setup();
  project(db, "p1");
  task(db, "abc111", "p1", "failed");
  task(db, "abc222", "p1", "blocked");

  const result = findTaskByIdPrefix(db, "abc");
  assert.equal(result.ok, false);
  const error = result.ok ? "" : result.error;
  assert.match(error, /Ambiguous/);
  assert.match(error, /abc111/);
  assert.match(error, /abc222/);
});

test("retryTask: a task not in a retryable status is rejected without touching the engine", async () => {
  const db = setup();
  const hub = new WsHub();
  const engine = new EngineRunner(db, hub);
  project(db, "p1");
  task(db, "t1", "p1", "in_progress");

  const result = await retryTask(db, engine, () => {}, "t1", "telegram");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /only failed\/changes_requested\/blocked can be retried/);
});

test("retryTask: an unknown task id is rejected", async () => {
  const db = setup();
  const hub = new WsHub();
  const engine = new EngineRunner(db, hub);

  const result = await retryTask(db, engine, () => {}, "nope", "telegram");
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /task not found/);
});

test("stopAllProjects: updates status, broadcasts, and audit-logs only for whatever the engine reports as actually stopped", async () => {
  const db = setup();
  project(db, "p1");
  project(db, "p2");
  // A minimal fake standing in for a real EngineRunner here — same
  // narrow-fake-object pattern gate-runner.test.ts uses for WorktreeManager
  // — so this test exercises stopAllProjects' own DB/broadcast/audit
  // handling deterministically, without needing a real orchestrator
  // actually running (that's the engine's own concern, already covered by
  // its own tests; this only reuses engine.stopAll's *result*).
  const fakeEngine = { stopAll: async () => ["p1"] } as unknown as EngineRunner;
  const broadcasts: unknown[] = [];

  const stoppedIds = await stopAllProjects(db, fakeEngine, (e) => broadcasts.push(e), "telegram");

  assert.deepEqual(stoppedIds, ["p1"]);
  assert.equal(repo.getProject(db, "p1")!.status, "paused");
  assert.equal(repo.getProject(db, "p2")!.status, "created", "untouched -- the engine said only p1 was running");
  const audit = repo.getAuditLog(db, "p1").find((e) => e.kind === "stopped");
  assert.ok(audit, "expected a stopped audit entry for p1");
  assert.equal(audit!.actor, "telegram");
  assert.equal(broadcasts.length, 1, "one project.updated broadcast for the one stopped project");
});
