import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./index";

function timestampedFilename(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `hoopedorc-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.db`;
}

function pruneOldBackups(backupDir: string, keep: number): void {
  const files = readdirSync(backupDir)
    .filter((f) => f.startsWith("hoopedorc-") && f.endsWith(".db"))
    .map((f) => ({ name: f, mtimeMs: statSync(join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

  for (const f of files.slice(keep)) {
    try {
      unlinkSync(join(backupDir, f.name));
    } catch {
      /* best effort — a leftover old backup file is harmless */
    }
  }
}

/**
 * F17: online-backup the live DB via better-sqlite3's built-in `db.backup()`
 * (safe against a DB being actively written to — it uses SQLite's own
 * backup API, not a raw file copy, so it can't produce a half-written
 * snapshot). `dbPath` must be the actual path the running `Db` was opened
 * with — pass `":memory:"` for a mock/in-memory boot to skip entirely
 * (better-sqlite3 itself rejects `":memory:"` as a backup destination, and
 * there's nothing durable there to protect anyway). Prunes to the newest
 * `keep` backups afterward. Throws on a real failure — callers must catch
 * and log rather than let a failed backup crash the server.
 */
export async function runBackup(
  db: Db,
  dbPath: string,
  backupDir: string,
  keep: number,
): Promise<{ skipped: true } | { skipped: false; file: string }> {
  if (dbPath === ":memory:") return { skipped: true };

  mkdirSync(backupDir, { recursive: true });
  const dest = join(backupDir, timestampedFilename());
  await db.backup(dest);
  pruneOldBackups(backupDir, keep);
  return { skipped: false, file: dest };
}
