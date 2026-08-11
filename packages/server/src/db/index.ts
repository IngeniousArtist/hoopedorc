import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV, normalizeSettings } from "../config";

const here = dirname(fileURLToPath(import.meta.url));

// O13: schema.sql owns fresh databases; this explicit idempotent migration
// keeps the existing-database upgrade path reviewable and independently
// testable. The partial indexes are justified by the sparse pending-approval
// UNION branches rather than by generic notification reads.
const O13_QUERY_INDEX_MIGRATION = `
  CREATE INDEX IF NOT EXISTS idx_model_invocations_started
    ON model_invocations(started_at);
  CREATE INDEX IF NOT EXISTS idx_merge_decisions_task_ts
    ON merge_decisions(task_id, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_created
    ON notifications(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_project_created
    ON notifications(project_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_task_created
    ON notifications(task_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_pending_created
    ON notifications(created_at DESC)
    WHERE requires_approval = 1 AND responded_with IS NULL;
  CREATE INDEX IF NOT EXISTS idx_notifications_project_pending_created
    ON notifications(project_id, created_at DESC)
    WHERE requires_approval = 1 AND responded_with IS NULL;
`;

// O14: the columns must exist before this index is created on an upgraded
// database, so this cannot live in schema.sql's pre-migration index section.
// initDb applies it for both fresh and existing databases.
const O14_DURABLE_TRANSITION_MIGRATION = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_live_approval_key
    ON notifications(approval_key)
    WHERE approval_key IS NOT NULL
      AND approval_delivery IN ('pending', 'recorded');
  CREATE INDEX IF NOT EXISTS idx_tasks_stop_requested
    ON tasks(stop_requested_at)
    WHERE stop_requested_at IS NOT NULL;
`;

export type Db = Database.Database;

export function openDb(path: string = ENV.dbPath): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/** Open the DB and apply schema.sql (idempotent — uses IF NOT EXISTS). */
export function initDb(path: string = ENV.dbPath): Db {
  const db = openDb(path);
  // In dev (tsx) schema.sql sits next to this file. For a bundled build, copy
  // schema.sql into dist or inline it — see the spec.
  const schema = readFileSync(join(here, "schema.sql"), "utf8");
  db.exec(schema);
  // Safe column migrations for existing databases (SQLite ignores IF NOT EXISTS
  // on ALTER TABLE, so we catch the "duplicate column" error instead).
  for (const col of [
    "ALTER TABLE projects ADD COLUMN planning_messages TEXT",
    "ALTER TABLE projects ADD COLUMN planning_prd TEXT",
    "ALTER TABLE projects ADD COLUMN planning_draft_tasks TEXT",
    "ALTER TABLE projects ADD COLUMN prd TEXT",
    "ALTER TABLE tasks ADD COLUMN role TEXT",
    // B15: scope WS broadcasts per project — these need a project_id to key on.
    "ALTER TABLE runs ADD COLUMN project_id TEXT",
    "ALTER TABLE logs ADD COLUMN project_id TEXT",
    "ALTER TABLE merge_decisions ADD COLUMN project_id TEXT",
    // F9: per-project gate/retry/merge-policy overrides.
    "ALTER TABLE projects ADD COLUMN config TEXT",
    // F19: when the scheduler last auto-started this project.
    "ALTER TABLE projects ADD COLUMN last_scheduled_run_at TEXT",
    // O35: durable, per-project task mutation generation. The schema's task
    // triggers increment it in the same transaction as every row mutation.
    "ALTER TABLE projects ADD COLUMN task_generation INTEGER NOT NULL DEFAULT 0",
    // F22: PR link + validator reasons for an approval notification — the
    // same context Telegram's approval message already carries, now also
    // persisted so the web UI can render it (JSON, nullable).
    "ALTER TABLE notifications ADD COLUMN context TEXT",
    // F28: which archived markdown file (context/plan-sessions/<ts>.md)
    // this project's current planning session is being written to. Kept
    // separate from the other planning_* columns so it can be cleared
    // independently at /plan/commit (see plan-sessions.ts).
    "ALTER TABLE projects ADD COLUMN planning_session_file TEXT",
    // F38: AGENTS.md draft from the last deconstruct, alongside the other
    // planning_* scratch fields — persisted so a reload mid-planning keeps
    // the operator's edits, cleared at /plan/commit like planning_prd.
    "ALTER TABLE projects ADD COLUMN planning_agents_md TEXT",
    // F52: verified exact-node metadata only — no raw Figma payload/cache.
    "ALTER TABLE projects ADD COLUMN planning_figma_refs TEXT",
    // O3: immutable id for the active editable planning revision. Successful
    // commit receipts keep old ids replayable after this column is cleared.
    "ALTER TABLE projects ADD COLUMN planning_revision_id TEXT",
    // One-line human-readable terminal outcome ("Merged PR #4" / "Gates
    // kept failing: tests") — set by the orchestrator, shown on Audit cards.
    "ALTER TABLE tasks ADD COLUMN status_reason TEXT",
    // B34: durable manual-priority queue intent. Cleared when dispatch starts.
    "ALTER TABLE tasks ADD COLUMN dispatch_requested_at TEXT",
    // O14: durable intent closes the cancellation -> final transaction crash
    // window so boot recovery cannot revive a task the operator stopped.
    "ALTER TABLE tasks ADD COLUMN stop_requested_at TEXT",
    // O34: restart-safe logical-run accounting. Keep max_attempts immutable;
    // these fields own runtime recovery allowance and fallback position.
    "ALTER TABLE tasks ADD COLUMN run_generation INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN run_extra_attempts INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN run_model TEXT",
    "ALTER TABLE tasks ADD COLUMN run_exhausted_models TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE tasks ADD COLUMN run_rate_limit_retries INTEGER NOT NULL DEFAULT 0",
    // Cached-input token counts, for manual per-model pricing (fresh vs
    // cached input bill at different rates).
    "ALTER TABLE runs ADD COLUMN tokens_cached INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE costs ADD COLUMN tokens_cached INTEGER NOT NULL DEFAULT 0",
    // F48: attempt-stable CLI effort used for this run (`default` when the
    // model config left effort unset).
    "ALTER TABLE runs ADD COLUMN effort TEXT",
    // B40: ties the legacy costs projection to one authoritative invocation.
    "ALTER TABLE costs ADD COLUMN invocation_id TEXT",
    "ALTER TABLE model_checks ADD COLUMN invocation_id TEXT",
    // O14: a choice is durable before it is delivered to an in-memory waiter.
    "ALTER TABLE notifications ADD COLUMN approval_key TEXT",
    "ALTER TABLE notifications ADD COLUMN approval_delivery TEXT",
    "ALTER TABLE notifications ADD COLUMN response_recorded_at TEXT",
    "ALTER TABLE notifications ADD COLUMN response_applied_at TEXT",
  ]) {
    try {
      db.exec(col);
    } catch (error) {
      if (
        error instanceof Error &&
        /duplicate column name/i.test(error.message)
      ) {
        continue;
      }
      throw error;
    }
  }
  db.exec(O13_QUERY_INDEX_MIGRATION);
  // Pre-O14 pending approvals cannot be associated with a recoverable waiter.
  // Expire those once during upgrade; all new rows carry a durable key and
  // survive ordinary restarts in pending/recorded state.
  db.transaction(() => {
    db.prepare(
      `UPDATE notifications
       SET responded_with = 'expired_restart',
           approval_delivery = 'expired_no_owner',
           response_recorded_at = COALESCE(response_recorded_at, ?)
       WHERE requires_approval = 1
         AND approval_delivery IS NULL
         AND responded_with IS NULL`,
    ).run(new Date().toISOString());
    db.exec(`
      UPDATE notifications
      SET approval_delivery = CASE
        WHEN responded_with = 'cancelled_stop' THEN 'cancelled'
        WHEN responded_with = 'expired_restart' THEN 'expired_no_owner'
        ELSE 'applied'
      END,
      response_recorded_at = COALESCE(response_recorded_at, created_at),
      response_applied_at = CASE
        WHEN responded_with NOT IN ('cancelled_stop', 'expired_restart')
          THEN COALESCE(response_applied_at, created_at)
        ELSE response_applied_at
      END
      WHERE requires_approval = 1
        AND approval_delivery IS NULL
        AND responded_with IS NOT NULL;
    `);
  })();
  db.exec(O14_DURABLE_TRANSITION_MIGRATION);
  // O3 migration: preserve legacy scratch exactly and assign one stable
  // revision only where a planning session was already active. Empty projects
  // receive a revision lazily from GET /plan/session instead.
  db.transaction(() => {
    const active = db
      .prepare(
        `SELECT id
         FROM projects
         WHERE planning_revision_id IS NULL
           AND (
             status = 'planning'
             OR planning_messages IS NOT NULL
             OR planning_prd IS NOT NULL
             OR planning_draft_tasks IS NOT NULL
             OR planning_agents_md IS NOT NULL
             OR planning_figma_refs IS NOT NULL
             OR planning_session_file IS NOT NULL
           )`,
      )
      .all() as { id: string }[];
    const assign = db.prepare(
      "UPDATE projects SET planning_revision_id = ? WHERE id = ? AND planning_revision_id IS NULL",
    );
    for (const project of active) assign.run(randomUUID(), project.id);
  })();
  // B40 migration/backfill. Deterministic ids + INSERT OR IGNORE make this
  // safe on every boot. Prefer run rows (author/docs), then add historical
  // non-run costs (planner/validator), then model checks (health). Existing
  // cost rows are linked to the chosen invocation so rollout cannot bill a
  // historical call twice.
  db.transaction(() => {
    db.exec(`
      INSERT OR IGNORE INTO model_invocations (
        id, project_id, task_id, run_id, stage, model, runner, effort,
        started_at, ended_at, outcome, exit_reason, cost_usd,
        tokens_in, tokens_out, tokens_cached
      )
      SELECT
        r.id,
        COALESCE(NULLIF(r.project_id, ''), t.project_id),
        r.task_id,
        r.id,
        CASE WHEN r.id LIKE 'run-%-docs' THEN 'docs' ELSE 'author' END,
        r.model,
        'unknown',
        COALESCE(r.effort, 'default'),
        r.started_at,
        r.ended_at,
        CASE r.status
          WHEN 'running' THEN 'running'
          WHEN 'passed' THEN 'completed'
          WHEN 'stopped' THEN 'stopped'
          ELSE 'failed'
        END,
        r.exit_reason,
        r.cost_usd,
        r.tokens_in,
        r.tokens_out,
        COALESCE(r.tokens_cached, 0)
      FROM runs r
      LEFT JOIN tasks t ON t.id = r.task_id;

      UPDATE costs
      SET invocation_id = run_id
      WHERE invocation_id IS NULL
        AND run_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM model_invocations i WHERE i.id = costs.run_id)
        AND id = (
          SELECT c2.id FROM costs c2
          WHERE c2.run_id = costs.run_id
          ORDER BY c2.ts DESC, c2.id DESC LIMIT 1
        );

      INSERT OR IGNORE INTO model_invocations (
        id, project_id, task_id, stage, model, runner, effort,
        started_at, ended_at, outcome, exit_reason, cost_usd,
        tokens_in, tokens_out, tokens_cached
      )
      SELECT
        'legacy-cost:' || c.id,
        c.project_id,
        c.task_id,
        CASE WHEN c.task_id IS NULL THEN 'planner' ELSE 'validator' END,
        c.model,
        'unknown',
        'default',
        c.ts,
        c.ts,
        'completed',
        'legacy_backfill',
        c.cost_usd,
        c.tokens_in,
        c.tokens_out,
        COALESCE(c.tokens_cached, 0)
      FROM costs c
      WHERE c.invocation_id IS NULL
        AND (
          c.run_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM model_invocations i WHERE i.id = c.run_id)
        );

      UPDATE costs
      SET invocation_id = 'legacy-cost:' || id
      WHERE invocation_id IS NULL
        AND (
          run_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM model_invocations i WHERE i.id = costs.run_id)
        );

      INSERT OR IGNORE INTO model_invocations (
        id, stage, model, runner, effort, started_at, ended_at, outcome,
        exit_reason, cost_usd, tokens_in, tokens_out, tokens_cached
      )
      SELECT
        'legacy-health:' || id,
        'health',
        model_id,
        'unknown',
        'default',
        ts,
        ts,
        CASE WHEN ok = 1 THEN 'completed' ELSE 'failed' END,
        CASE WHEN ok = 1 THEN 'completed' ELSE 'error' END,
        cost_usd,
        0,
        0,
        0
      FROM model_checks
      WHERE invocation_id IS NULL;

      UPDATE model_checks
      SET invocation_id = 'legacy-health:' || id
      WHERE invocation_id IS NULL;
    `);

    // A process cannot still own a `running` invocation when a fresh server
    // is initializing this database. Preserve the call and close it as an
    // interrupted attempt instead of leaving quota/health state ambiguous.
    db.prepare(
      `UPDATE model_invocations
       SET outcome = 'interrupted', ended_at = ?, exit_reason = 'process_restart'
       WHERE outcome = 'running'`,
    ).run(new Date().toISOString());
  })();
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_costs_invocation ON costs(invocation_id) WHERE invocation_id IS NOT NULL",
  );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_model_checks_invocation ON model_checks(invocation_id) WHERE invocation_id IS NOT NULL",
  );
  // B37: migrate every historical settings blob through the current deep
  // defaults and reject corrupt persisted policy at boot instead of trusting
  // it until an arbitrary runtime path crashes later.
  const settingsRow = db.prepare("SELECT json FROM settings WHERE id = 1").get() as
    | { json: string }
    | undefined;
  if (settingsRow) {
    const normalized = normalizeSettings(JSON.parse(settingsRow.json) as unknown);
    db.prepare("UPDATE settings SET json = ? WHERE id = 1").run(JSON.stringify(normalized));
  }
  return db;
}
