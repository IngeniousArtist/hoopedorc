import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV, normalizeSettings } from "../config";

const here = dirname(fileURLToPath(import.meta.url));

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
    // One-line human-readable terminal outcome ("Merged PR #4" / "Gates
    // kept failing: tests") — set by the orchestrator, shown on Audit cards.
    "ALTER TABLE tasks ADD COLUMN status_reason TEXT",
    // B34: durable manual-priority queue intent. Cleared when dispatch starts.
    "ALTER TABLE tasks ADD COLUMN dispatch_requested_at TEXT",
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
  ]) {
    try { db.exec(col); } catch { /* column already exists */ }
  }
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
