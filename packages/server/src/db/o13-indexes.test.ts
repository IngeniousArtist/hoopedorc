import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initDb, type Db } from "./index.js";

const O13_INDEXES = [
  "idx_model_invocations_started",
  "idx_merge_decisions_task_ts",
  "idx_notifications_created",
  "idx_notifications_project_created",
  "idx_notifications_task_created",
  "idx_notifications_pending_created",
  "idx_notifications_project_pending_created",
] as const;

const PROJECT_NOTIFICATIONS = `
  SELECT * FROM (
    SELECT * FROM notifications
    WHERE project_id = ? ORDER BY created_at DESC LIMIT ?
  )
  UNION
  SELECT * FROM notifications
  WHERE project_id = ?
    AND requires_approval = 1
    AND responded_with IS NULL
  ORDER BY created_at DESC
`;

const GLOBAL_NOTIFICATIONS = `
  SELECT * FROM (
    SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?
  )
  UNION
  SELECT * FROM notifications
  WHERE requires_approval = 1 AND responded_with IS NULL
  ORDER BY created_at DESC
`;

function plan(db: Db, sql: string, ...params: unknown[]): string[] {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
      detail: string;
    }>
  ).map((row) => row.detail);
}

function joinedPlan(db: Db, sql: string, ...params: unknown[]): string {
  return plan(db, sql, ...params).join("\n");
}

function seedRepresentativeRows(db: Db): void {
  db.exec(`
    WITH RECURSIVE n(x) AS (
      VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 20000
    )
    INSERT INTO model_invocations (
      id, project_id, task_id, stage, model, runner,
      started_at, outcome, cost_usd
    )
    SELECT printf('inv-%06d', x), printf('p-%d', x % 5),
           printf('t-%d', x % 100), 'author', printf('m-%d', x % 4),
           'codex', datetime('now', printf('-%d minutes', x)),
           'completed', 0.01
    FROM n;

    WITH RECURSIVE n(x) AS (
      VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 10000
    )
    INSERT INTO merge_decisions (
      id, project_id, task_id, run_id, validator_model, verdict,
      reasons, confidence, gate, ts
    )
    SELECT printf('md-%06d', x), 'p-1', printf('t-%d', x % 100),
           printf('r-%d', x), 'deepseek-pro', 'approve', '[]', 1, '{}',
           datetime('now', printf('-%d seconds', x))
    FROM n;

    WITH RECURSIVE n(x) AS (
      VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 20000
    )
    INSERT INTO notifications (
      id, project_id, task_id, severity, title, message,
      requires_approval, responded_with, created_at, context
    )
    SELECT printf('no-%06d', x), printf('p-%d', x % 5),
           printf('t-%d', x % 100), 'info', 'title', 'message',
           CASE WHEN x % 50 = 0 THEN 1 ELSE 0 END,
           CASE WHEN x % 100 = 0 THEN NULL ELSE 'done' END,
           datetime('now', printf('-%d seconds', x)), '{}'
    FROM n;
  `);
}

test("O13: existing-database migration is idempotent and selects every measured index", () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-o13-indexes-"));
  const path = join(root, "existing.sqlite");
  let db = initDb(path);
  try {
    for (const index of O13_INDEXES) {
      db.exec(`DROP INDEX ${index}`);
    }
    seedRepresentativeRows(db);

    assert.deepEqual(
      ["model_invocations", "merge_decisions", "notifications"].map(
        (table) =>
          Number(
            (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
          ),
      ),
      [20_000, 10_000, 20_000],
    );

    assert.match(
      joinedPlan(
        db,
        "SELECT SUM(cost_usd) FROM model_invocations WHERE started_at >= ?",
        "2026-01-01",
      ),
      /SCAN model_invocations/,
    );
    assert.match(
      joinedPlan(
        db,
        "SELECT SUM(cost_usd) FROM model_invocations WHERE model = ? AND started_at >= ?",
        "m-1",
        "2026-01-01",
      ),
      /idx_model_invocations_model_started/,
    );
    assert.match(
      joinedPlan(
        db,
        "SELECT * FROM merge_decisions WHERE task_id = ? ORDER BY ts DESC",
        "t-1",
      ),
      /SCAN merge_decisions[\s\S]*USE TEMP B-TREE FOR ORDER BY/,
    );
    assert.doesNotMatch(
      joinedPlan(db, GLOBAL_NOTIFICATIONS, 200),
      /idx_notifications_(?:created|pending_created)/,
    );
    assert.doesNotMatch(
      joinedPlan(db, PROJECT_NOTIFICATIONS, "p-1", 200, "p-1"),
      /idx_notifications_project_(?:created|pending_created)/,
    );
    assert.match(
      joinedPlan(
        db,
        "SELECT * FROM notifications WHERE task_id = ? AND context IS NOT NULL ORDER BY created_at DESC",
        "t-1",
      ),
      /SCAN notifications[\s\S]*USE TEMP B-TREE FOR ORDER BY/,
    );
  } finally {
    db.close();
  }

  db = initDb(path);
  try {
    assert.match(
      joinedPlan(
        db,
        "SELECT SUM(cost_usd) FROM model_invocations WHERE started_at >= ?",
        "2026-01-01",
      ),
      /idx_model_invocations_started/,
    );
    assert.match(
      joinedPlan(
        db,
        "SELECT SUM(cost_usd) FROM model_invocations WHERE model = ? AND started_at >= ?",
        "m-1",
        "2026-01-01",
      ),
      /idx_model_invocations_model_started/,
    );
    assert.match(
      joinedPlan(
        db,
        "SELECT * FROM merge_decisions WHERE task_id = ? ORDER BY ts DESC",
        "t-1",
      ),
      /idx_merge_decisions_task_ts/,
    );

    const globalNotifications = joinedPlan(db, GLOBAL_NOTIFICATIONS, 200);
    assert.match(globalNotifications, /idx_notifications_created/);
    assert.match(globalNotifications, /idx_notifications_pending_created/);

    const projectNotifications = joinedPlan(
      db,
      PROJECT_NOTIFICATIONS,
      "p-1",
      200,
      "p-1",
    );
    assert.match(projectNotifications, /idx_notifications_project_created/);
    assert.match(
      projectNotifications,
      /idx_notifications_project_pending_created/,
    );
    assert.match(
      joinedPlan(
        db,
        "SELECT * FROM notifications WHERE task_id = ? AND context IS NOT NULL ORDER BY created_at DESC",
        "t-1",
      ),
      /idx_notifications_task_created/,
    );
  } finally {
    db.close();
  }

  // A second existing-database boot must be a no-op, not a duplicate-index
  // migration failure.
  db = initDb(path);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test("O13: fresh schema contains the exact measured index set", () => {
  const db = initDb(":memory:");
  try {
    const names = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    for (const index of O13_INDEXES) assert.equal(names.has(index), true, index);
  } finally {
    db.close();
  }
});
