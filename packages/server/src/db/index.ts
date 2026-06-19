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
  return db;
}
