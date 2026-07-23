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
    dispatchRequestedAt,
  });
}

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
