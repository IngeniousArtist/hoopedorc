import { createHash } from "node:crypto";
import { abortableDelay } from "@orc/adapters";
import { ResourceUnavailableError, type AccountPool, type InvocationAccounting, type InvocationStage, type ModelConfig, type PoolResourceStatus, type RecoverResourceRequest, type ResourceReservation, type ResourcesResponse, type Settings } from "@orc/types";
import type { Db } from "./db/index";
import * as repo from "./db/repo";
import { defaultSettings } from "./config";

export interface ResourceRequest { id: string; model: string; stage: InvocationStage; projectId?: string; taskId?: string; modelConfig?: ModelConfig }
interface ReservationRow { id: string; model: string; stage: InvocationStage; project_id: string | null; task_id: string | null; pool_id: string; state: ResourceReservation["state"]; accounting_json: string; created_at: string; updated_at: string }
const mapReservation = (row: ReservationRow): ResourceReservation => ({ id: row.id, model: row.model, stage: row.stage, projectId: row.project_id ?? undefined, taskId: row.task_id ?? undefined, poolId: row.pool_id, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at });

export function accountingSnapshot(model: ModelConfig, pool?: AccountPool): InvocationAccounting {
  const pricing = [model.costPerMInputUsd, model.costPerMCachedInputUsd, model.costPerMOutputUsd].some((value) => value !== undefined)
    ? { input: model.costPerMInputUsd ?? 0, cached: model.costPerMCachedInputUsd ?? 0, output: model.costPerMOutputUsd ?? 0 } : undefined;
  return { poolId: pool?.id, billing: pool?.billing ?? "metered", pricing };
}
export function invocationCost(accounting: InvocationAccounting, reported: number, input: number, cached: number, output: number): number {
  if (accounting.billing === "subscription") return 0;
  return accounting.pricing ? (input * accounting.pricing.input + cached * accounting.pricing.cached + output * accounting.pricing.output) / 1_000_000 : reported;
}

/** SQLite serializes admission across profiles/projects. Waiting here is a
 * semaphore, not a second task scheduler. No model prompt precedes admission. */
export class ResourceManager {
  constructor(readonly db: Db, private readonly now: () => number = Date.now) {}
  private settings(): Settings { return repo.getSettings(this.db) ?? defaultSettings(); }
  private row(id: string) { return this.db.prepare("SELECT * FROM resource_reservations WHERE id = ?").get(id) as ReservationRow | undefined; }
  snapshot(id: string): InvocationAccounting | undefined { const row = this.row(id); return row ? JSON.parse(row.accounting_json) as InvocationAccounting : undefined; }
  private status(pool: AccountPool, settings: Settings): PoolResourceStatus {
    const windowHours = pool.quota?.windowHours ?? 24; const since = new Date(this.now() - windowHours * 3_600_000).toISOString();
    const usage = this.db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(tokens_in + tokens_out + tokens_cached), 0) AS tokens,
      COALESCE(SUM(CASE WHEN outcome = 'interrupted' THEN 1 ELSE 0 END), 0) AS unknown_spend
      FROM model_invocations WHERE json_extract(accounting_json, '$.poolId') = ? AND started_at >= ?`).get(pool.id, since) as { calls: number; cost: number; tokens: number; unknown_spend: number };
    const counts = this.db.prepare(`SELECT
      COALESCE(SUM(state = 'active'), 0) AS active, COALESCE(SUM(state = 'reserved'), 0) AS reserved,
      COALESCE(SUM(state = 'unresolved'), 0) AS unresolved,
      COALESCE(SUM(state IN ('reserved', 'active', 'unresolved') AND stage != 'validator'), 0) AS authors,
      COALESCE(SUM(state = 'reserved' AND created_at >= ? AND NOT EXISTS (SELECT 1 FROM model_invocations i WHERE i.id = r.id)), 0) AS pending
      FROM resource_reservations r WHERE pool_id = ?`).get(since, pool.id) as { active: number; reserved: number; unresolved: number; authors: number; pending: number };
    const until = (this.db.prepare("SELECT until_at FROM resource_cooldowns WHERE pool_id = ?").get(pool.id) as { until_at: string } | undefined)?.until_at;
    const cooldownUntil = until && new Date(until).getTime() > this.now() ? until : undefined;
    const total = counts.active + counts.reserved + counts.unresolved;
    const observedCalls = usage.calls + counts.pending;
    const reason = cooldownUntil ? `${pool.name} is cooling down until ${cooldownUntil}.`
      : pool.quota?.maxCalls !== undefined && observedCalls >= pool.quota.maxCalls ? `${pool.name} call limit reached (${observedCalls}/${pool.quota.maxCalls} in ${windowHours}h).`
      : pool.quota?.maxCostUsd !== undefined && usage.cost >= pool.quota.maxCostUsd ? `${pool.name} observed cost limit reached ($${usage.cost.toFixed(2)} in ${windowHours}h).` : undefined;
    return { pool, models: settings.models.filter((model) => model.accountPoolId === pool.id).map((model) => model.id), active: counts.active, reserved: counts.reserved, unresolved: counts.unresolved,
      authorSlotsAvailable: Math.max(0, Math.min(pool.maxConcurrent - total, pool.maxConcurrent - pool.reviewSlots - counts.authors)), observedCalls, meteredCostUsd: usage.cost, tokens: usage.tokens, unknownSpendCalls: usage.unknown_spend, windowHours, cooldownUntil, reason };
  }
  check(modelId: string, stage: InvocationStage = "author", settings = this.settings()): string | null {
    const model = settings.models.find((item) => item.id === modelId);
    if (!model?.enabled) return `Model ${modelId} is unavailable.`;
    if (!model.accountPoolId) return null;
    const pool = settings.accountPools?.find((item) => item.id === model.accountPoolId);
    if (!pool) return `Account pool ${model.accountPoolId} is unavailable.`;
    const state = this.status(pool, settings); if (state.reason) return state.reason;
    if (state.active + state.reserved + state.unresolved >= pool.maxConcurrent || stage !== "validator" && state.authorSlotsAvailable === 0) return state.unresolved ? `${pool.name} has unresolved worker capacity. Confirm stopped workers in Settings → Resources.` : `${pool.name} has no free ${stage !== "validator" ? "worker " : ""}slot; review capacity is reserved.`;
    return null;
  }
  reserve(request: ResourceRequest, settings = this.settings()): InvocationAccounting {
    return this.db.transaction(() => {
      let existing = this.row(request.id);
      if (existing?.state === "released" && !this.db.prepare("SELECT 1 FROM model_invocations WHERE id = ?").get(request.id) && !this.db.prepare("SELECT 1 FROM resource_recoveries WHERE reservation_id = ?").get(request.id)) {
        this.db.prepare("DELETE FROM resource_reservations WHERE id = ?").run(request.id);
        existing = undefined;
      }
      if (existing) {
        if (existing.model !== request.model || existing.stage !== request.stage || existing.project_id !== (request.projectId ?? null) || existing.task_id !== (request.taskId ?? null)) throw new ResourceUnavailableError("Reservation identity changed. Start a new invocation.", false);
        if (existing.state !== "reserved" && existing.state !== "active") throw new ResourceUnavailableError("This invocation's capacity was already released or requires recovery. Start a new invocation.", false);
        return JSON.parse(existing.accounting_json) as InvocationAccounting;
      }
      const current = settings.models.find((item) => item.id === request.model);
      if (!current?.enabled) throw new ResourceUnavailableError(`Model ${request.model} is disabled or unavailable.`, false);
      const model = request.modelConfig ?? current;
      if (model.id !== request.model) throw new ResourceUnavailableError("Model snapshot does not match the invocation.", false);
      if (model.accountPoolId && !settings.accountPools?.some((pool) => pool.id === model.accountPoolId)) throw new ResourceUnavailableError("The invocation's account pool was removed. Retry with current settings.", false);
      const effective = { ...settings, models: settings.models.map((item) => item.id === request.model ? model : item) };
      const reason = this.check(request.model, request.stage, effective);
      if (reason) throw new ResourceUnavailableError(reason);
      const pool = settings.accountPools?.find((item) => item.id === model.accountPoolId);
      const snapshot = accountingSnapshot(model, pool);
      if (pool) {
        const now = new Date(this.now()).toISOString();
        this.db.prepare(`INSERT INTO resource_reservations (id, model, stage, project_id, task_id, pool_id, state, accounting_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`)
          .run(request.id, request.model, request.stage, request.projectId ?? null, request.taskId ?? null, pool.id, JSON.stringify(snapshot), now, now);
      }
      return snapshot;
    })();
  }
  async acquire(request: ResourceRequest, signal?: AbortSignal, wait = true, onWait?: (reason: string) => void): Promise<InvocationAccounting> {
    let lastReason: string | undefined;
    for (;;) {
      signal?.throwIfAborted();
      try { return this.reserve(request); }
      catch (error) {
        if (!(error instanceof ResourceUnavailableError) || !error.retryable || !wait) throw error;
        if (error.message !== lastReason) { onWait?.(error.message); lastReason = error.message; }
        await abortableDelay(500, signal);
      }
    }
  }
  async guard(request: ResourceRequest, signal?: AbortSignal, wait = true, onWait?: (reason: string) => void): Promise<{ accounting: InvocationAccounting; release: () => void }> {
    const accounting = await this.acquire(request, signal, wait, onWait);
    return { accounting, release: () => this.releaseUnstarted(request.id) };
  }
  /** Called in the same transaction as the durable running invocation. */
  activate(request: ResourceRequest): InvocationAccounting | undefined {
    const row = this.row(request.id); if (!row) return undefined;
    if (!["reserved", "active"].includes(row.state) || row.model !== request.model || row.stage !== request.stage || row.project_id !== (request.projectId ?? null) || row.task_id !== (request.taskId ?? null)) throw new ResourceUnavailableError("The invocation does not own this account reservation.", false);
    this.db.prepare("UPDATE resource_reservations SET state = 'active', updated_at = ? WHERE id = ? AND state = 'reserved'").run(new Date(this.now()).toISOString(), request.id);
    return JSON.parse(row.accounting_json) as InvocationAccounting;
  }
  /** Only the terminal ledger transaction may release a started invocation. */
  private workerUnsettled(id: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM execution_workers WHERE invocation_id = ? AND state != 'stopped'").get(id)); }
  release(id: string) { if (this.workerUnsettled(id)) { this.db.prepare("UPDATE resource_reservations SET state = 'unresolved', updated_at = ? WHERE id = ?").run(new Date(this.now()).toISOString(), id); return; } this.db.prepare("UPDATE resource_reservations SET state = 'released', updated_at = ? WHERE id = ? AND (state IN ('reserved', 'active') OR state = 'unresolved' AND EXISTS (SELECT 1 FROM execution_workers w WHERE w.invocation_id = resource_reservations.id AND w.state = 'stopped'))").run(new Date(this.now()).toISOString(), id); }
  releaseUnstarted(id: string) {
    if (this.workerUnsettled(id)) { this.db.prepare("UPDATE resource_reservations SET state = 'unresolved', updated_at = ? WHERE id = ?").run(new Date(this.now()).toISOString(), id); return; }
    this.db.prepare("UPDATE resource_reservations SET state = 'released', updated_at = ? WHERE id = ? AND state = 'reserved' AND NOT EXISTS (SELECT 1 FROM model_invocations WHERE id = ?)").run(new Date(this.now()).toISOString(), id, id);
  }
  cooldown(poolId: string) {
    const until = new Date(this.now() + 5 * 60_000).toISOString();
    this.db.prepare("INSERT INTO resource_cooldowns (pool_id, until_at) VALUES (?, ?) ON CONFLICT(pool_id) DO UPDATE SET until_at = MAX(until_at, excluded.until_at)").run(poolId, until);
  }
  coolingDownUntil(modelId: string): number | undefined {
    const poolId = this.settings().models.find((model) => model.id === modelId)?.accountPoolId;
    const row = poolId ? this.db.prepare("SELECT until_at FROM resource_cooldowns WHERE pool_id = ?").get(poolId) as { until_at: string } | undefined : undefined;
    const until = row ? new Date(row.until_at).getTime() : 0;
    return until > this.now() ? until : undefined;
  }
  hasActivity(projectId: string) { return Boolean(this.db.prepare("SELECT 1 FROM resource_reservations WHERE project_id = ? AND state != 'released' LIMIT 1").get(projectId)); }
  response(): ResourcesResponse {
    const settings = this.settings();
    return { pools: (settings.accountPools ?? []).map((pool) => this.status(pool, settings)), unresolved: (this.db.prepare("SELECT * FROM resource_reservations WHERE state = 'unresolved' ORDER BY created_at").all() as ReservationRow[]).map(mapReservation),
      unpooledModels: settings.models.filter((model) => !model.accountPoolId).map((model) => model.id), providerAllowance: "unknown" };
  }
  recover(id: string, request: RecoverResourceRequest): ResourceReservation {
    if (!request || typeof request.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(request.requestId) || typeof request.expectedUpdatedAt !== "string" || request.confirmWorkerStopped !== true || Object.keys(request).some((key) => !["requestId", "expectedUpdatedAt", "confirmWorkerStopped"].includes(key))) throw new ResourceUnavailableError("Confirm that the old worker is stopped using the current reservation version and a UUID request ID.", false);
    const hash = createHash("sha256").update(JSON.stringify({ id, requestId: request.requestId, expectedUpdatedAt: request.expectedUpdatedAt, confirmWorkerStopped: true })).digest("hex");
    return this.db.transaction(() => {
      const receipt = this.db.prepare("SELECT request_hash, result_json FROM resource_recoveries WHERE request_id = ?").get(request.requestId) as { request_hash: string; result_json: string } | undefined;
      if (receipt) { if (receipt.request_hash !== hash) throw new ResourceUnavailableError("Recovery request ID belongs to another action.", false); return JSON.parse(receipt.result_json) as ResourceReservation; }
      if (this.workerUnsettled(id)) throw new ResourceUnavailableError("The isolated worker must be stopped and verified before releasing its account slot.", false);
      const row = this.row(id);
      if (!row || row.state !== "unresolved" || row.updated_at !== request.expectedUpdatedAt) throw new ResourceUnavailableError("Reservation changed or is not awaiting recovery. Refresh resource status.", false);
      this.db.prepare("UPDATE resource_reservations SET state = 'released', updated_at = ? WHERE id = ? AND state = 'unresolved'").run(new Date(this.now()).toISOString(), id);
      const result = mapReservation(this.row(id)!);
      this.db.prepare("INSERT INTO resource_recoveries (request_id, reservation_id, request_hash, result_json) VALUES (?, ?, ?, ?)").run(request.requestId, id, hash, JSON.stringify(result));
      return result;
    })();
  }
}
