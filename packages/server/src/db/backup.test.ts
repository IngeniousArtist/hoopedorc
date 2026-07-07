import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initDb } from "./index.js";
import { runBackup } from "./backup.js";

/** F17: real better-sqlite3 backup API against real files on disk — no mocks. */

test("runBackup: an in-memory DB is skipped entirely, no directory created", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "hoopedorc-backup-test-"));
  const backupDir = join(scratch, "backups");
  try {
    const db = initDb(":memory:");
    const result = await runBackup(db, ":memory:", backupDir, 7);
    assert.deepEqual(result, { skipped: true });
    assert.equal(existsSync(backupDir), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("runBackup: a real file DB produces a real, correctly-named backup file", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "hoopedorc-backup-test-"));
  const dbPath = join(scratch, "hoopedorc.db");
  const backupDir = join(scratch, "backups");
  try {
    const db = initDb(dbPath);
    const result = await runBackup(db, dbPath, backupDir, 7);
    assert.equal(result.skipped, false);
    if (result.skipped) throw new Error("unreachable"); // narrow for TS
    assert.match(
      result.file,
      /hoopedorc-\d{4}-\d{2}-\d{2}-\d{4}\.db$/,
    );
    assert.equal(existsSync(result.file), true);
    assert.equal(existsSync(backupDir), true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("runBackup: prunes to the newest `keep` backups, surviving the just-created one", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "hoopedorc-backup-test-"));
  const dbPath = join(scratch, "hoopedorc.db");
  const backupDir = join(scratch, "backups");
  try {
    const db = initDb(dbPath);

    // Pre-seed 9 dummy older backups (matching the prune filter's
    // hoopedorc-*.db naming, not necessarily the exact timestamp format) —
    // oldest first, each with a distinct, deliberately old mtime so the
    // "newest wins" ordering is unambiguous. runBackup() itself creates
    // backupDir on its first call, so create it explicitly first.
    mkdirSync(backupDir, { recursive: true });
    const dummyBase = Date.now() - 1000 * 60 * 60 * 24 * 30; // 30 days ago
    for (let i = 0; i < 9; i++) {
      const f = join(backupDir, `hoopedorc-dummy-${i}.db`);
      writeFileSync(f, "x");
      const mtimeSec = (dummyBase + i * 1000) / 1000;
      utimesSync(f, mtimeSec, mtimeSec);
    }
    assert.equal(readdirSync(backupDir).length, 9);

    const result = await runBackup(db, dbPath, backupDir, 7);
    assert.equal(result.skipped, false);
    if (result.skipped) throw new Error("unreachable");

    const remaining = readdirSync(backupDir);
    assert.equal(remaining.length, 7);
    // The just-created (newest) backup must survive the prune.
    assert.ok(remaining.includes(result.file.split("/").pop()!));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
