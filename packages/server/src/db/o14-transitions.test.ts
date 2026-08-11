import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initDb, type Db } from "./index.js";
import * as repo from "./repo.js";

function setup(path = ":memory:"): Db {
  const db = initDb(path);
  repo.createProject(db, {
    id: "o14-project",
    name: "O14",
    repoUrl: "https://github.com/example/o14",
    defaultBranch: "main",
    localPath: "/tmp/o14",
    status: "running",
  });
  repo.createTask(db, {
    id: "o14-task",
    projectId: "o14-project",
    title: "Durable transition",
    description: "Exercise O14 boundaries",
    difficulty: "medium",
    status: "in_review",
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash",
    scopePaths: [],
    attempts: 1,
    maxAttempts: 3,
  });
  return db;
}

function approval(db: Db) {
  return repo.createOrReuseApprovalNotification(db, {
    projectId: "o14-project",
    taskId: "o14-task",
    severity: "action_required",
    title: "Approve O14",
    message: "Apply the durable choice?",
    requiresApproval: true,
    options: ["approve", "reject"],
  });
}

test("O14: approval claim and audit roll back together before delivery", () => {
  const db = setup();
  const first = approval(db);
  assert.equal(first.created, true);
  assert.equal(first.notification.approvalDelivery, "pending");
  assert.equal(approval(db).notification.id, first.notification.id);

  db.exec(`
    CREATE TRIGGER o14_fail_approval_audit
    BEFORE INSERT ON audit_log
    WHEN NEW.kind = 'approval_resolved'
    BEGIN
      SELECT RAISE(ABORT, 'injected approval audit failure');
    END;
  `);
  assert.throws(
    () => repo.recordApprovalResponse(db, first.notification.id, "approve"),
    /injected approval audit failure/,
  );
  const rolledBack = repo.getNotification(db, first.notification.id)!;
  assert.equal(rolledBack.respondedWith, undefined);
  assert.equal(rolledBack.approvalDelivery, "pending");
  assert.equal(repo.getAuditLog(db, "o14-project").length, 0);

  db.exec("DROP TRIGGER o14_fail_approval_audit");
  const won = repo.recordApprovalResponse(
    db,
    first.notification.id,
    "approve",
  );
  assert.equal(won.outcome, "recorded");
  assert.equal(won.notification?.approvalDelivery, "recorded");
  assert.ok(won.notification?.responseRecordedAt);
  assert.equal(repo.getAuditLog(db, "o14-project").length, 1);

  assert.equal(
    repo.recordApprovalResponse(db, first.notification.id, "reject").outcome,
    "conflict",
    "a second channel with another choice loses",
  );
  assert.equal(
    repo.recordApprovalResponse(db, first.notification.id, "approve").outcome,
    "retry_recorded",
    "an identical retry can redeliver after owner persistence failed",
  );
  db.exec(`
    CREATE TRIGGER o14_fail_applied_marker
    BEFORE UPDATE OF approval_delivery ON notifications
    WHEN NEW.approval_delivery = 'applied'
    BEGIN
      SELECT RAISE(ABORT, 'injected applied marker failure');
    END;
  `);
  assert.throws(
    () => repo.markApprovalApplied(db, first.notification.id, "approve"),
    /injected applied marker failure/,
  );
  assert.equal(
    repo.getNotification(db, first.notification.id)?.approvalDelivery,
    "recorded",
  );
  db.exec("DROP TRIGGER o14_fail_applied_marker");
  const applied = repo.markApprovalApplied(db, first.notification.id, "approve")!;
  assert.equal(applied.approvalDelivery, "applied");
  assert.ok(applied.responseAppliedAt);
  assert.equal(approval(db).created, true, "a later identical prompt gets a new row");
});

test("O14: ownerless expiry is atomic and never pretends the choice applied", () => {
  const db = setup();
  db.prepare("UPDATE tasks SET status = 'failed' WHERE id = 'o14-task'").run();
  const notification = approval(db).notification;
  assert.equal(
    repo.recordApprovalResponse(db, notification.id, "reject").outcome,
    "recorded",
  );
  assert.equal(repo.hasRecoverableApprovalOwner(db, notification.id), false);

  db.exec(`
    CREATE TRIGGER o14_fail_expiry_audit
    BEFORE INSERT ON audit_log
    WHEN NEW.kind = 'approval_delivery_expired'
    BEGIN
      SELECT RAISE(ABORT, 'injected expiry audit failure');
    END;
  `);
  assert.throws(
    () => repo.expireRecordedApprovalNoOwner(db, notification.id),
    /injected expiry audit failure/,
  );
  assert.equal(
    repo.getNotification(db, notification.id)?.approvalDelivery,
    "recorded",
  );
  db.exec("DROP TRIGGER o14_fail_expiry_audit");

  const expired = repo.expireRecordedApprovalNoOwner(db, notification.id)!;
  assert.equal(expired.approvalDelivery, "expired_no_owner");
  assert.equal(expired.respondedWith, "reject");
  assert.equal(expired.responseAppliedAt, undefined);
});

test("O14: Stop audit failure preserves the intent and boot recovery commits one consistent outcome", () => {
  const db = setup();
  repo.createRun(db, {
    id: "o14-run",
    projectId: "o14-project",
    taskId: "o14-task",
    model: "deepseek-flash",
    attempt: 1,
    status: "running",
    startedAt: "2026-08-11T00:00:00.000Z",
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
  });
  const claim = repo.claimTaskStop(db, "o14-task");
  assert.equal(claim.claimed, true);
  assert.equal(claim.pending, true);
  assert.equal(repo.getTask(db, "o14-task")?.status, "in_review");
  assert.equal(repo.getRun(db, "o14-run")?.status, "running");

  db.exec(`
    CREATE TRIGGER o14_fail_stop_audit
    BEFORE INSERT ON audit_log
    WHEN NEW.kind = 'stopped'
    BEGIN
      SELECT RAISE(ABORT, 'injected Stop audit failure');
    END;
  `);
  assert.throws(
    () => repo.finalizeTaskStop(db, "o14-task"),
    /injected Stop audit failure/,
  );
  assert.equal(repo.getTask(db, "o14-task")?.status, "in_review");
  assert.equal(repo.getRun(db, "o14-run")?.status, "running");
  assert.equal(repo.claimTaskStop(db, "o14-task").pending, true);
  assert.equal(repo.getAuditLog(db, "o14-project").length, 0);

  db.exec("DROP TRIGGER o14_fail_stop_audit");
  const [recovered] = repo.recoverInterruptedTaskStops(db);
  assert.equal(recovered?.changed, true);
  assert.equal(recovered?.task?.status, "blocked");
  assert.equal(recovered?.runs[0]?.status, "stopped");
  assert.equal(recovered?.runs[0]?.exitReason, "killed");
  assert.equal(repo.getAuditLog(db, "o14-project").length, 1);
  assert.deepEqual(repo.recoverInterruptedTaskStops(db), []);
  assert.equal(repo.claimTaskStop(db, "o14-task").pending, false);
});

test("O14: legacy pending approvals expire once while keyed rows survive idempotent reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-o14-migration-"));
  const path = join(root, "o14.sqlite");
  try {
    let db = setup(path);
    const keyed = approval(db).notification;
    const legacy = repo.createNotification(db, {
      id: "o14-legacy",
      projectId: "o14-project",
      taskId: "o14-task",
      severity: "action_required",
      title: "Legacy",
      message: "No durable identity",
      requiresApproval: true,
      options: ["approve", "reject"],
    });
    db.prepare(
      `UPDATE notifications
       SET approval_delivery = NULL, approval_key = NULL
       WHERE id = ?`,
    ).run(legacy.id);
    db.close();

    db = initDb(path);
    assert.equal(repo.getNotification(db, keyed.id)?.approvalDelivery, "pending");
    assert.equal(repo.getNotification(db, keyed.id)?.respondedWith, undefined);
    assert.equal(
      repo.getNotification(db, legacy.id)?.approvalDelivery,
      "expired_no_owner",
    );
    assert.equal(repo.getNotification(db, legacy.id)?.respondedWith, "expired_restart");
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name IN
           ('idx_notifications_live_approval_key', 'idx_tasks_stop_requested')
         ORDER BY name`,
      )
      .all() as { name: string }[];
    assert.deepEqual(indexes.map(({ name }) => name), [
      "idx_notifications_live_approval_key",
      "idx_tasks_stop_requested",
    ]);
    db.close();

    db = initDb(path);
    assert.equal(repo.getNotification(db, keyed.id)?.approvalDelivery, "pending");
    assert.equal(repo.getNotification(db, legacy.id)?.respondedWith, "expired_restart");
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
