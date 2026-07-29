import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initDb } from "./index.js";
import * as repo from "./repo.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function setup() {
  const db = initDb(":memory:");
  repo.createProject(db, {
    id: "proj-1",
    name: "P",
    repoUrl: "https://github.com/x/y",
    defaultBranch: "main",
    localPath: "/tmp/x",
    status: "running",
  });
  return db;
}

function seedRollbackTask(db: ReturnType<typeof initDb>) {
  return repo.createTask(db, {
    id: "task-rollback",
    projectId: "proj-1",
    title: "Merged task",
    description: "",
    difficulty: "medium",
    status: "done",
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash",
    scopePaths: [],
    prNumber: 7,
    attempts: 1,
    maxAttempts: 3,
  });
}

function seedLogTask(db: ReturnType<typeof initDb>) {
  return repo.createTask(db, {
    id: "task-logs",
    projectId: "proj-1",
    title: "Logs",
    description: "",
    difficulty: "easy",
    status: "ready",
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash",
    scopePaths: [],
    attempts: 0,
    maxAttempts: 3,
  });
}

/** Creates a real notification via the public API, then backdates its
 *  created_at directly — createNotification always stamps "now", and these
 *  tests need explicit control over age. */
function seedNotification(
  db: ReturnType<typeof initDb>,
  opts: {
    id: string;
    requiresApproval: boolean;
    respondedWith?: string;
    ageMs: number;
  },
) {
  const n = repo.createNotification(db, {
    id: opts.id,
    projectId: "proj-1",
    severity: opts.requiresApproval ? "action_required" : "info",
    title: opts.id,
    message: "msg",
    requiresApproval: opts.requiresApproval,
    options: opts.requiresApproval ? ["approve", "reject"] : undefined,
  });
  const createdAt = new Date(Date.now() - opts.ageMs).toISOString();
  db.prepare("UPDATE notifications SET created_at = ?, responded_with = ? WHERE id = ?").run(
    createdAt,
    opts.respondedWith ?? null,
    n.id,
  );
}

// ── O27: pruneLogs age + per-task bounds ──

test("O27: pruneLogs removes expired rows and preserves recent history", () => {
  const db = setup();
  const task = seedLogTask(db);
  repo.createLog(db, {
    projectId: "proj-1",
    taskId: task.id,
    runId: "run-old",
    ts: new Date(Date.now() - 31 * DAY_MS).toISOString(),
    level: "info",
    source: "agent",
    message: "old",
  });
  repo.createLog(db, {
    projectId: "proj-1",
    taskId: task.id,
    runId: "run-recent",
    ts: new Date(Date.now() - DAY_MS).toISOString(),
    level: "info",
    source: "agent",
    message: "recent",
  });

  assert.equal(repo.pruneLogs(db, 14), 1);
  assert.deepEqual(
    repo.getLogsByTask(db, task.id).map((log) => log.message),
    ["recent"],
  );
});

test("O27: pruneLogs keeps only the newest configured rows per task", () => {
  const db = setup();
  const task = seedLogTask(db);
  for (let index = 0; index < 5; index++) {
    repo.createLog(db, {
      projectId: "proj-1",
      taskId: task.id,
      runId: `run-${index}`,
      ts: new Date(Date.now() - (5 - index) * 1000).toISOString(),
      level: "info",
      source: "agent",
      message: `log-${index}`,
    });
  }

  assert.equal(repo.pruneLogs(db, 14, 2), 3);
  assert.deepEqual(
    repo.getLogsByTask(db, task.id).map((log) => log.message),
    ["log-3", "log-4"],
  );
});

// ── B23: pruneNotifications never deletes a pending approval ──

test("pruneNotifications: deletes old responded notifications", () => {
  const db = setup();
  seedNotification(db, { id: "old-info", requiresApproval: false, respondedWith: undefined, ageMs: 40 * DAY_MS });
  const deleted = repo.pruneNotifications(db, 30);
  assert.equal(deleted, 1);
  assert.equal(repo.getNotification(db, "old-info"), null);
});

test("pruneNotifications: never deletes an old pending approval", () => {
  const db = setup();
  seedNotification(db, {
    id: "old-pending",
    requiresApproval: true,
    respondedWith: undefined,
    ageMs: 90 * DAY_MS,
  });
  const deleted = repo.pruneNotifications(db, 30);
  assert.equal(deleted, 0);
  assert.notEqual(repo.getNotification(db, "old-pending"), null);
});

test("pruneNotifications: a resolved-but-old approval is fair game (only unresponded ones are exempt)", () => {
  const db = setup();
  seedNotification(db, {
    id: "old-resolved-approval",
    requiresApproval: true,
    respondedWith: "approve",
    ageMs: 90 * DAY_MS,
  });
  const deleted = repo.pruneNotifications(db, 30);
  assert.equal(deleted, 1);
  assert.equal(repo.getNotification(db, "old-resolved-approval"), null);
});

test("pruneNotifications: recent notifications survive regardless of type", () => {
  const db = setup();
  seedNotification(db, { id: "recent", requiresApproval: false, ageMs: DAY_MS });
  const deleted = repo.pruneNotifications(db, 30);
  assert.equal(deleted, 0);
  assert.notEqual(repo.getNotification(db, "recent"), null);
});

test("O16: cancelPendingApproval is single-winner and never overwrites a human response", () => {
  const db = setup();
  seedNotification(db, {
    id: "stop-wins",
    requiresApproval: true,
    ageMs: 0,
  });
  assert.equal(
    repo.cancelPendingApproval(db, "stop-wins")?.respondedWith,
    repo.CANCELLED_STOP,
  );
  assert.equal(repo.cancelPendingApproval(db, "stop-wins"), null);

  seedNotification(db, {
    id: "human-wins",
    requiresApproval: true,
    respondedWith: "approve",
    ageMs: 0,
  });
  assert.equal(repo.cancelPendingApproval(db, "human-wins"), null);
  assert.equal(
    repo.getNotification(db, "human-wins")?.respondedWith,
    "approve",
  );
});

// ── B26: getNotifications' LIMIT must not drop a pending approval ──

test("getNotifications: an old pending approval survives past 250 newer responded notifications (default limit)", () => {
  const db = setup();
  seedNotification(db, {
    id: "pending-1",
    requiresApproval: true,
    respondedWith: undefined,
    ageMs: 40 * DAY_MS,
  });
  for (let i = 0; i < 250; i++) {
    seedNotification(db, {
      id: `n-${i}`,
      requiresApproval: false,
      respondedWith: "ack",
      ageMs: i * 1000,
    });
  }
  const result = repo.getNotifications(db, "proj-1");
  assert.equal(result.some((n) => n.id === "pending-1"), true);
  assert.equal(
    result.every(
      (n, i) => i === 0 || new Date(result[i - 1]!.createdAt) >= new Date(n.createdAt),
    ),
    true,
  );
});

test("getNotifications: the pending approval survives even with a small explicit limit", () => {
  const db = setup();
  seedNotification(db, {
    id: "pending-1",
    requiresApproval: true,
    respondedWith: undefined,
    ageMs: 40 * DAY_MS,
  });
  for (let i = 0; i < 20; i++) {
    seedNotification(db, {
      id: `n-${i}`,
      requiresApproval: false,
      respondedWith: "ack",
      ageMs: i * 1000,
    });
  }
  const result = repo.getNotifications(db, "proj-1", 5);
  assert.equal(result.some((n) => n.id === "pending-1"), true);
  assert.equal(result.length, 6); // newest 5 + the 1 pending approval
});

test("getNotifications: a fresh pending approval already within the window isn't duplicated", () => {
  const db = setup();
  seedNotification(db, {
    id: "pending-fresh",
    requiresApproval: true,
    respondedWith: undefined,
    ageMs: 0,
  });
  const result = repo.getNotifications(db, "proj-1", 5);
  assert.equal(result.filter((n) => n.id === "pending-fresh").length, 1);
});

test("getNotifications: works with no projectId (global) too", () => {
  const db = setup();
  seedNotification(db, {
    id: "pending-1",
    requiresApproval: true,
    respondedWith: undefined,
    ageMs: 40 * DAY_MS,
  });
  const result = repo.getNotifications(db);
  assert.equal(result.some((n) => n.id === "pending-1"), true);
});

test("B36: rollback jobs round-trip and duplicate task/PR requests are idempotent", () => {
  const db = setup();
  seedRollbackTask(db);
  const first = repo.createOrGetRollbackJob(db, {
    id: "rollback-1",
    projectId: "proj-1",
    taskId: "task-rollback",
    sourcePrNumber: 7,
    branch: "orc/rollback-1",
    worktreePath: "/tmp/rollback-1",
    status: "requested",
  });
  const duplicate = repo.createOrGetRollbackJob(db, {
    id: "rollback-2",
    projectId: "proj-1",
    taskId: "task-rollback",
    sourcePrNumber: 7,
    branch: "orc/rollback-2",
    worktreePath: "/tmp/rollback-2",
    status: "requested",
  });

  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.branch, "orc/rollback-1");
  const awaiting = repo.updateRollbackJob(db, first.id, {
    sourceCommit: "a".repeat(40),
    sourceParentCount: 1,
    rollbackPrNumber: 11,
    status: "awaiting_approval",
    approvalNotificationId: "notification-1",
    approvalChoice: "approve_merge",
  })!;
  assert.equal(awaiting.sourceCommit, "a".repeat(40));
  assert.equal(awaiting.rollbackPrNumber, 11);
  assert.equal(awaiting.approvalChoice, "approve_merge");
  assert.deepEqual(
    repo.getRecoverableRollbackJobs(db).map((job) => job.id),
    [first.id],
  );

  repo.updateRollbackJob(db, first.id, { status: "completed" });
  assert.deepEqual(repo.getRecoverableRollbackJobs(db), []);
});

// ── F38: AGENTS.md planning-session persistence ──

test("savePlanningSession/getPlanningSession: agentsMd round-trips alongside prd/draftTasks", () => {
  const db = setup();
  repo.savePlanningSession(db, "proj-1", {
    messages: [{ role: "user", content: "hi" }],
    prd: "# PRD",
    draftTasks: [],
    agentsMd: "# Project context\n\nA test project.",
  });
  const session = repo.getPlanningSession(db, "proj-1");
  assert.equal(session.prd, "# PRD");
  assert.equal(session.agentsMd, "# Project context\n\nA test project.");
});

test("savePlanningSession: agentsMd: null clears a previously saved value", () => {
  const db = setup();
  repo.savePlanningSession(db, "proj-1", { agentsMd: "# Draft" });
  assert.equal(repo.getPlanningSession(db, "proj-1").agentsMd, "# Draft");

  repo.savePlanningSession(db, "proj-1", { agentsMd: null });
  assert.equal(repo.getPlanningSession(db, "proj-1").agentsMd, undefined);
});

test("getPlanningSession: agentsMd is undefined when never set", () => {
  const db = setup();
  const session = repo.getPlanningSession(db, "proj-1");
  assert.equal(session.agentsMd, undefined);
});

test("F52: verified Figma references round-trip and clear with planning scratch", () => {
  const db = setup();
  const references = [
    {
      canonicalUrl:
        "https://www.figma.com/design/File123/Login?node-id=10-20",
      fileKey: "File123",
      nodeId: "10:20",
      name: "Login desktop",
      fileName: "Product",
      width: 1440,
      height: 900,
      verifiedModel: "codex",
      verifiedRunner: "codex" as const,
      verifiedAt: "2026-07-23T12:00:00.000Z",
    },
  ];
  repo.savePlanningSession(db, "proj-1", {
    verifiedFigmaReferences: references,
  });
  assert.deepEqual(
    repo.getPlanningSession(db, "proj-1").verifiedFigmaReferences,
    references,
  );

  repo.savePlanningSession(db, "proj-1", {
    verifiedFigmaReferences: null,
  });
  assert.equal(
    repo.getPlanningSession(db, "proj-1").verifiedFigmaReferences,
    undefined,
  );
});

test("F52: an existing database receives the planning Figma column idempotently", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hoopedorc-f52-migration-")), "orc.db");
  const original = initDb(path);
  original.exec("ALTER TABLE projects DROP COLUMN planning_figma_refs");
  original.close();

  const migrated = initDb(path);
  const columns = migrated
    .prepare("PRAGMA table_info(projects)")
    .all() as { name: string }[];
  assert.ok(columns.some((column) => column.name === "planning_figma_refs"));
  migrated.close();

  const reopened = initDb(path);
  const reopenedColumns = reopened
    .prepare("PRAGMA table_info(projects)")
    .all() as { name: string }[];
  assert.equal(
    reopenedColumns.filter((column) => column.name === "planning_figma_refs").length,
    1,
  );
  reopened.close();
});

test("O34: an existing database receives durable task-run columns idempotently", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hoopedorc-o34-migration-")), "orc.db");
  const original = initDb(path);
  repo.createProject(original, {
    id: "legacy-project",
    name: "Legacy",
    repoUrl: "https://github.com/x/legacy",
    defaultBranch: "main",
    localPath: "/tmp/legacy",
    status: "paused",
  });
  repo.createTask(original, {
    id: "legacy-task",
    projectId: "legacy-project",
    title: "Legacy task",
    description: "",
    difficulty: "medium",
    status: "failed",
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash",
    scopePaths: [],
    attempts: 4,
    maxAttempts: 7,
  });
  for (const column of [
    "run_generation",
    "run_extra_attempts",
    "run_model",
    "run_exhausted_models",
    "run_rate_limit_retries",
  ]) {
    original.exec(`ALTER TABLE tasks DROP COLUMN ${column}`);
  }
  original.close();

  for (let pass = 0; pass < 2; pass++) {
    const migrated = initDb(path);
    const columns = migrated
      .prepare("PRAGMA table_info(tasks)")
      .all() as { name: string }[];
    for (const column of [
      "run_generation",
      "run_extra_attempts",
      "run_model",
      "run_exhausted_models",
      "run_rate_limit_retries",
    ]) {
      assert.equal(
        columns.filter((candidate) => candidate.name === column).length,
        1,
        `${column} exists exactly once after migration pass ${pass + 1}`,
      );
    }
    const legacy = repo.getTask(migrated, "legacy-task")!;
    assert.equal(legacy.attempts, 4);
    assert.equal(legacy.maxAttempts, 7);
    assert.equal(legacy.runGeneration, 0);
    assert.equal(legacy.runExtraAttempts, 0);
    assert.deepEqual(legacy.runExhaustedModels, []);
    assert.equal(legacy.runRateLimitRetries, 0);
    migrated.close();
  }
});

// ── B34: durable priority dispatch + race-safe Stop transitions ──

function seedTask(
  db: ReturnType<typeof initDb>,
  id: string,
  status: "ready" | "backlog" | "in_progress" | "done" | "failed",
  dispatchRequestedAt?: string,
) {
  return repo.createTask(db, {
    id,
    projectId: "proj-1",
    title: id,
    description: "",
    difficulty: "medium",
    status,
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash",
    scopePaths: [],
    attempts: 0,
    maxAttempts: 3,
    runGeneration: 0,
    runExtraAttempts: 0,
    runExhaustedModels: [],
    runRateLimitRetries: 0,
    dispatchRequestedAt,
  });
}

test("O34: task-run accounting round-trips and only one conditional Retry wins", () => {
  const db = setup();
  seedTask(db, "retry-race", "failed");
  repo.updateTask(db, "retry-race", {
    attempts: 4,
    runGeneration: 7,
    runExtraAttempts: 2,
    runModel: "deepseek-pro",
    runExhaustedModels: ["deepseek-flash"],
    runRateLimitRetries: 1,
    branch: "orc/retry-race",
    worktreePath: "/tmp/retry-race",
    prNumber: 42,
    statusReason: "No fallback left",
  });

  const first = repo.resetTaskForRetry(db, "retry-race", "human");
  const second = repo.resetTaskForRetry(db, "retry-race", "telegram");

  assert.ok(first);
  assert.equal(second, null);
  const reset = repo.getTask(db, "retry-race")!;
  assert.equal(reset.status, "backlog");
  assert.equal(reset.attempts, 0);
  assert.equal(reset.maxAttempts, 3);
  assert.equal(reset.runGeneration, 8);
  assert.equal(reset.runExtraAttempts, 0);
  assert.equal(reset.runModel, undefined);
  assert.deepEqual(reset.runExhaustedModels, []);
  assert.equal(reset.runRateLimitRetries, 0);
  assert.equal(reset.branch, undefined);
  assert.equal(reset.worktreePath, undefined);
  assert.equal(reset.prNumber, undefined);
  assert.equal(reset.statusReason, undefined);
  assert.ok(reset.dispatchRequestedAt, "accepted Retry persists scheduler intent");
  const retries = repo
    .getAuditLog(db, "proj-1")
    .filter((entry) => entry.kind === "retry");
  assert.equal(retries.length, 1);
  assert.equal(retries[0]!.actor, "human");
});

test("O35: an existing database receives task generations and triggers idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "hoopedorc-o35-migration-"));
  const path = join(dir, "legacy.db");
  const original = initDb(path);
  repo.createProject(original, {
    id: "legacy-generation-project",
    name: "Legacy generation",
    repoUrl: "https://github.com/x/legacy-generation",
    defaultBranch: "main",
    localPath: "/tmp/legacy-generation",
    status: "paused",
  });
  repo.createTask(original, {
    id: "legacy-generation-task",
    projectId: "legacy-generation-project",
    title: "Legacy task",
    description: "",
    difficulty: "medium",
    status: "ready",
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash",
    scopePaths: [],
    attempts: 0,
    maxAttempts: 3,
  });
  for (const trigger of [
    "tasks_generation_after_insert",
    "tasks_generation_after_update",
    "tasks_generation_after_delete",
  ]) {
    original.exec(`DROP TRIGGER ${trigger}`);
  }
  original.exec("ALTER TABLE projects DROP COLUMN task_generation");
  original.close();

  for (let pass = 0; pass < 2; pass++) {
    const migrated = initDb(path);
    const columns = migrated
      .prepare("PRAGMA table_info(projects)")
      .all() as { name: string }[];
    assert.equal(
      columns.filter((column) => column.name === "task_generation").length,
      1,
    );
    const triggers = migrated
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND name LIKE 'tasks_generation_after_%'`,
      )
      .all() as { name: string }[];
    assert.equal(triggers.length, 3);
    assert.equal(repo.getTaskGeneration(migrated, "legacy-generation-project"), 0);
    assert.ok(repo.getTask(migrated, "legacy-generation-task"));
    migrated.close();
  }
});

test("O35: every task mutation advances durable generation and repository wake state", () => {
  const db = setup();
  const projectId = "proj-1";
  const startGeneration = repo.getTaskGeneration(db, projectId);
  const startWake = repo.getTaskWakeVersion(db, projectId);

  seedTask(db, "generation-task", "failed", "queued");
  assert.equal(repo.getTaskGeneration(db, projectId), startGeneration + 1);
  assert.equal(repo.getTaskWakeVersion(db, projectId), startWake + 1);

  repo.updateTask(db, "generation-task", { status: "in_progress" });
  assert.equal(repo.getTaskGeneration(db, projectId), startGeneration + 2);
  assert.equal(repo.getTaskWakeVersion(db, projectId), startWake + 2);

  assert.equal(
    repo.markTaskStoppedIfActive(db, "generation-task").changed,
    true,
  );
  assert.equal(repo.getTaskGeneration(db, projectId), startGeneration + 3);
  assert.equal(repo.getTaskWakeVersion(db, projectId), startWake + 3);

  repo.updateTask(db, "generation-task", {
    status: "failed",
    dispatchRequestedAt: "queued",
  });
  repo.clearDispatchRequests(db, projectId);
  assert.equal(repo.getTaskGeneration(db, projectId), startGeneration + 5);
  assert.equal(repo.getTaskWakeVersion(db, projectId), startWake + 5);

  assert.ok(repo.resetTaskForRetry(db, "generation-task", "human"));
  assert.equal(repo.getTaskGeneration(db, projectId), startGeneration + 6);
  assert.equal(repo.getTaskWakeVersion(db, projectId), startWake + 6);

  // A write from another process/older code still advances the trigger-owned
  // durable generation. It deliberately has no in-memory hint; the bounded
  // scheduler deadline is the recovery path.
  db.prepare("UPDATE tasks SET title = title WHERE id = ?").run("generation-task");
  assert.equal(repo.getTaskGeneration(db, projectId), startGeneration + 7);
  assert.equal(repo.getTaskWakeVersion(db, projectId), startWake + 6);
});

test("dispatchRequestedAt round-trips and project Stop clears queued requests", () => {
  const db = setup();
  const requestedAt = "2026-07-14T00:00:00.000Z";
  seedTask(db, "queued-1", "ready", requestedAt);
  seedTask(db, "queued-2", "ready", requestedAt);

  assert.equal(repo.getTask(db, "queued-1")!.dispatchRequestedAt, requestedAt);
  const cleared = repo.clearDispatchRequests(db, "proj-1");
  assert.deepEqual(cleared.map((task) => task.id).sort(), ["queued-1", "queued-2"]);
  assert.equal(repo.getTask(db, "queued-1")!.dispatchRequestedAt, undefined);
  assert.equal(repo.getTask(db, "queued-2")!.dispatchRequestedAt, undefined);
});

test("markTaskStoppedIfActive blocks active work but never rewrites a terminal task", () => {
  const db = setup();
  seedTask(db, "active", "in_progress");
  seedTask(db, "finished", "done");
  seedTask(db, "failed", "failed");
  seedTask(db, "waiting", "backlog");

  const active = repo.markTaskStoppedIfActive(db, "active");
  assert.equal(active.changed, true);
  assert.equal(active.task!.status, "blocked");
  assert.equal(active.task!.statusReason, "Stopped by user");

  const finished = repo.markTaskStoppedIfActive(db, "finished");
  assert.equal(finished.changed, false);
  assert.equal(finished.task!.status, "done");
  assert.equal(repo.markTaskStoppedIfActive(db, "failed").changed, false);
  assert.equal(repo.getTask(db, "failed")!.status, "failed");
  assert.equal(repo.markTaskStoppedIfActive(db, "waiting").changed, false);
  assert.equal(repo.getTask(db, "waiting")!.status, "backlog");
});
