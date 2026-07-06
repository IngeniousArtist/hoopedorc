import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV } from "../config";

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
  ]) {
    try { db.exec(col); } catch { /* column already exists */ }
  }
  return db;
}
