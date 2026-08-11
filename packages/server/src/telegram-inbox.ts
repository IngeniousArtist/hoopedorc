import type { TgUpdate, TelegramUpdateStore } from "./telegram.js";
import type { Db } from "./db/index.js";

export const TELEGRAM_INBOX_RETENTION_DAYS = 30;

export interface TelegramActionDescriptor {
  kind: string;
  payload: Record<string, unknown>;
}

export interface TelegramInboxRow {
  updateId: number;
  state: "claimed" | "processing" | "processed";
  identity: string;
  actionKind?: string;
  processedAt?: string;
}

export interface TelegramActionRow {
  updateId: number;
  idempotencyKey: string;
  kind: string;
  state: "pending" | "effect_committed" | "completed";
  result?: unknown;
}

function mapInbox(row: Record<string, unknown>): TelegramInboxRow {
  return {
    updateId: Number(row.update_id),
    state: String(row.state) as TelegramInboxRow["state"],
    identity: String(row.identity),
    actionKind:
      typeof row.action_kind === "string" ? row.action_kind : undefined,
    processedAt:
      typeof row.processed_at === "string" ? row.processed_at : undefined,
  };
}

function mapAction(row: Record<string, unknown>): TelegramActionRow {
  return {
    updateId: Number(row.update_id),
    idempotencyKey: String(row.idempotency_key),
    kind: String(row.kind),
    state: String(row.state) as TelegramActionRow["state"],
    result:
      typeof row.result === "string"
        ? (JSON.parse(row.result) as unknown)
        : undefined,
  };
}

/** SQLite implementation injected into TelegramBot; transport code never
 * receives the database handle or gets to invent its own persistence rules. */
export class SqliteTelegramUpdateStore implements TelegramUpdateStore {
  constructor(private readonly db: Db) {}

  claim(
    update: TgUpdate,
    identity: string,
    action?: TelegramActionDescriptor,
  ): TelegramInboxRow {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) {
      throw new Error("invalid Telegram update_id");
    }
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const payload = JSON.stringify(update);
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO telegram_updates
             (update_id, payload, identity, action_kind, action_payload, state,
              received_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?)`,
        )
        .run(
          update.update_id,
          payload,
          identity,
          action?.kind ?? null,
          action ? JSON.stringify(action.payload) : null,
          now,
          now,
        );
      if (inserted.changes === 1) {
        this.db.prepare(
          `INSERT OR IGNORE INTO telegram_poll_state (id, next_offset, updated_at)
           VALUES (1, ?, ?)`,
        ).run(update.update_id, now);
        if (action) {
          this.db.prepare(
            `INSERT INTO telegram_actions
               (update_id, idempotency_key, kind, payload, state, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
          ).run(
            update.update_id,
            `telegram:${update.update_id}`,
            action.kind,
            JSON.stringify(action.payload),
            now,
            now,
          );
        }
      }

      const stored = this.db
        .prepare("SELECT * FROM telegram_updates WHERE update_id = ?")
        .get(update.update_id) as Record<string, unknown> | undefined;
      if (!stored) throw new Error(`telegram update ${update.update_id} disappeared`);
      if (String(stored.payload) !== payload || String(stored.identity) !== identity) {
        throw new Error(
          `telegram update_id ${update.update_id} was reused with different content`,
        );
      }
      return mapInbox(stored);
    })();
  }

  tryStart(updateId: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE telegram_updates
           SET state = 'processing', processing_started_at = ?, updated_at = ?
           WHERE update_id = ? AND state = 'claimed'`,
        )
        .run(new Date().toISOString(), new Date().toISOString(), updateId)
        .changes === 1
    );
  }

  /** A fresh process is the only caller. Reset abandoned ownership, then
   * return every gap-blocking update before any newer getUpdates request. */
  recover(): TgUpdate[] {
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare(
        `UPDATE telegram_updates
         SET state = 'claimed', processing_started_at = NULL, updated_at = ?
         WHERE state = 'processing'`,
      ).run(now);
      const rows = this.db
        .prepare(
          `SELECT payload FROM telegram_updates
           WHERE state = 'claimed' ORDER BY update_id ASC`,
        )
        .all() as { payload: string }[];
      return rows.map(({ payload }) => JSON.parse(payload) as TgUpdate);
    })();
  }

  release(updateId: number): void {
    this.db.prepare(
      `UPDATE telegram_updates
       SET state = 'claimed', processing_started_at = NULL, updated_at = ?
       WHERE update_id = ? AND state = 'processing'`,
    ).run(new Date().toISOString(), updateId);
  }

  complete(updateId: number): void {
    this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare(
        `UPDATE telegram_actions
         SET state = 'completed', completed_at = ?, updated_at = ?
         WHERE update_id = ? AND state IN ('pending', 'effect_committed')`,
      ).run(now, now, updateId);
      const completed = this.db.prepare(
        `UPDATE telegram_updates
         SET state = 'processed', processed_at = ?, updated_at = ?
         WHERE update_id = ? AND state = 'processing'`,
      ).run(now, now, updateId);
      if (completed.changes !== 1) {
        const current = this.getUpdate(updateId);
        if (current?.state === "processed") return;
        throw new Error(`telegram update ${updateId} was not owned for completion`);
      }

      const state = this.db
        .prepare("SELECT next_offset FROM telegram_poll_state WHERE id = 1")
        .get() as { next_offset: number } | undefined;
      if (!state) throw new Error("telegram poll offset is not initialized");
      let next = Number(state.next_offset);
      while (true) {
        const row = this.db
          .prepare("SELECT state FROM telegram_updates WHERE update_id = ?")
          .get(next) as { state: string } | undefined;
        if (row?.state !== "processed") break;
        next += 1;
      }
      this.db.prepare(
        "UPDATE telegram_poll_state SET next_offset = ?, updated_at = ? WHERE id = 1",
      ).run(next, now);
    })();
  }

  nextOffset(): number {
    const row = this.db
      .prepare("SELECT next_offset FROM telegram_poll_state WHERE id = 1")
      .get() as { next_offset: number } | undefined;
    return row ? Number(row.next_offset) : 0;
  }

  getUpdate(updateId: number): TelegramInboxRow | null {
    const row = this.db
      .prepare("SELECT * FROM telegram_updates WHERE update_id = ?")
      .get(updateId) as Record<string, unknown> | undefined;
    return row ? mapInbox(row) : null;
  }

  getAction(updateId: number): TelegramActionRow | null {
    const row = this.db
      .prepare("SELECT * FROM telegram_actions WHERE update_id = ?")
      .get(updateId) as Record<string, unknown> | undefined;
    return row ? mapAction(row) : null;
  }

  prune(retentionDays = TELEGRAM_INBOX_RETENTION_DAYS): number {
    const cutoff = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    return this.db.transaction(() => {
      const offset = this.nextOffset();
      this.db.prepare(
        `DELETE FROM telegram_actions
         WHERE update_id IN (
           SELECT update_id FROM telegram_updates
           WHERE state = 'processed' AND processed_at < ? AND update_id < ?
         )`,
      ).run(cutoff, offset);
      return this.db.prepare(
        `DELETE FROM telegram_updates
         WHERE state = 'processed' AND processed_at < ? AND update_id < ?`,
      ).run(cutoff, offset).changes;
    })();
  }
}

/** Commit a database-owned domain effect and its outbox marker together.
 * Replays receive the original result without executing `effect` again. */
export function commitTelegramActionEffect<T>(
  db: Db,
  idempotencyKey: string,
  effect: () => T,
): { committed: boolean; result: T } {
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT state, result FROM telegram_actions WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as { state: string; result: string | null } | undefined;
    if (!row) throw new Error(`telegram action ${idempotencyKey} not found`);
    if (row.state !== "pending") {
      if (!row.result) {
        throw new Error(`telegram action ${idempotencyKey} has no durable result`);
      }
      return { committed: false, result: JSON.parse(row.result) as T };
    }
    const result = effect();
    const encoded = JSON.stringify(result);
    const changed = db.prepare(
      `UPDATE telegram_actions
       SET state = 'effect_committed', result = ?, updated_at = ?
       WHERE idempotency_key = ? AND state = 'pending'`,
    ).run(encoded, new Date().toISOString(), idempotencyKey);
    if (changed.changes !== 1) {
      throw new Error(`telegram action ${idempotencyKey} lost its effect claim`);
    }
    return { committed: true, result };
  })();
}

/** Replace the durable result while compensating a synchronously refused
 * external action. The compensation and replay outcome stay atomic. */
export function replaceTelegramActionEffectResult<T>(
  db: Db,
  idempotencyKey: string,
  effect: () => T,
): T {
  return db.transaction(() => {
    const result = effect();
    const changed = db.prepare(
      `UPDATE telegram_actions
       SET result = ?, updated_at = ?
       WHERE idempotency_key = ? AND state = 'effect_committed'`,
    ).run(JSON.stringify(result), new Date().toISOString(), idempotencyKey);
    if (changed.changes !== 1) {
      throw new Error(`telegram action ${idempotencyKey} cannot replace its result`);
    }
    return result;
  })();
}
