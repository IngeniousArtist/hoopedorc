import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initDb } from "./db/index.js";
import {
  commitTelegramActionEffect,
  SqliteTelegramUpdateStore,
} from "./telegram-inbox.js";
import type { TgUpdate } from "./telegram.js";

function message(updateId: number, text = "/start p1"): TgUpdate {
  return {
    update_id: updateId,
    message: {
      chat: { id: 42, type: "private" },
      from: { id: 42 },
      text,
    },
  };
}

const action = {
  kind: "command_start",
  payload: { cmd: "start", args: ["p1"] },
};

test("O15: migration is idempotent and abandoned processing survives reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "orc-telegram-inbox-"));
  const path = join(dir, "orc.db");
  try {
    const firstDb = initDb(path);
    const first = new SqliteTelegramUpdateStore(firstDb);
    assert.throws(
      () => first.claim(message(Number.NaN), "invalid", action),
      /invalid Telegram update_id/,
    );
    first.claim(message(700), "command:start:p1", action);
    assert.equal(first.tryStart(700), true);
    firstDb.close();

    const reopenedDb = initDb(path);
    // Running initDb repeatedly is the existing-database migration path.
    initDb(path).close();
    const reopened = new SqliteTelegramUpdateStore(reopenedDb);
    assert.deepEqual(reopened.recover().map((update) => update.update_id), [700]);
    assert.equal(reopened.getUpdate(700)?.state, "claimed");
    assert.equal(reopened.getAction(700)?.idempotencyKey, "telegram:700");
    assert.equal(reopened.nextOffset(), 700);
    reopenedDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("O15: conditional ownership has one winner and completion cannot cross a gap", () => {
  const db = initDb(":memory:");
  const first = new SqliteTelegramUpdateStore(db);
  const second = new SqliteTelegramUpdateStore(db);
  for (const updateId of [100, 101, 102]) {
    first.claim(message(updateId), `command:start:${updateId}`, action);
  }

  assert.equal(first.tryStart(100), true);
  assert.equal(second.tryStart(100), false, "a second poll loop cannot own the row");
  assert.equal(first.tryStart(101), true);
  assert.equal(first.tryStart(102), true);

  first.complete(100);
  assert.equal(first.nextOffset(), 101);
  first.complete(102);
  assert.equal(first.nextOffset(), 101, "processed update 102 cannot skip update 101");
  first.complete(101);
  assert.equal(first.nextOffset(), 103);
  db.close();
});

test("O15: a crash after the domain effect replays its stored result exactly once", () => {
  const db = initDb(":memory:");
  const store = new SqliteTelegramUpdateStore(db);
  store.claim(message(300), "command:start:p1", action);
  assert.equal(store.tryStart(300), true);

  let effects = 0;
  const first = commitTelegramActionEffect(db, "telegram:300", () => ({
    count: ++effects,
  }));
  assert.equal(first.committed, true);
  // Simulate process loss after the effect transaction and before inbox
  // completion: startup releases the abandoned processing owner.
  assert.deepEqual(store.recover().map((update) => update.update_id), [300]);
  assert.equal(store.tryStart(300), true);
  const replay = commitTelegramActionEffect(db, "telegram:300", () => ({
    count: ++effects,
  }));
  assert.deepEqual(replay, { committed: false, result: { count: 1 } });
  assert.equal(effects, 1);

  store.complete(300);
  assert.equal(store.getUpdate(300)?.state, "processed");
  assert.equal(store.getAction(300)?.state, "completed");
  assert.equal(store.claim(message(300), "command:start:p1", action).state, "processed");
  db.close();
});

test("O15: failure before offset advance rolls back completion and remains recoverable", () => {
  const db = initDb(":memory:");
  const store = new SqliteTelegramUpdateStore(db);
  store.claim(message(400), "command:start:p1", action);
  assert.equal(store.tryStart(400), true);
  commitTelegramActionEffect(db, "telegram:400", () => ({ ok: true }));
  db.exec(`
    CREATE TRIGGER telegram_fail_offset
    BEFORE UPDATE ON telegram_poll_state
    BEGIN
      SELECT RAISE(ABORT, 'injected crash before offset');
    END;
  `);

  assert.throws(() => store.complete(400), /injected crash before offset/);
  assert.equal(store.getUpdate(400)?.state, "processing");
  assert.equal(store.getAction(400)?.state, "effect_committed");
  assert.equal(store.nextOffset(), 400);

  db.exec("DROP TRIGGER telegram_fail_offset");
  assert.deepEqual(store.recover().map((update) => update.update_id), [400]);
  assert.equal(store.tryStart(400), true);
  store.complete(400);
  assert.equal(store.getUpdate(400)?.state, "processed");
  assert.equal(store.nextOffset(), 401);
  db.close();
});

test("O15: retention prunes only old completed rows below the permanent high-water mark", () => {
  const db = initDb(":memory:");
  const store = new SqliteTelegramUpdateStore(db);
  store.claim(message(500), "command:start:500", action);
  assert.equal(store.tryStart(500), true);
  store.complete(500);
  store.claim(message(501), "command:start:501", action);
  db.prepare(
    "UPDATE telegram_updates SET processed_at = '2000-01-01T00:00:00.000Z' WHERE update_id = 500",
  ).run();

  assert.equal(store.prune(30), 1);
  assert.equal(store.getUpdate(500), null);
  assert.equal(store.getAction(500), null);
  assert.equal(store.getUpdate(501)?.state, "claimed");
  assert.equal(store.nextOffset(), 501);
  assert.equal(store.prune(30), 0, "retention is idempotent");
  db.close();
});
