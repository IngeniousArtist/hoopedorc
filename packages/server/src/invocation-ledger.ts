import {
  InvocationLedgerError,
  ResourceUnavailableError,
  type ModelInvocation,
  type Settings,
} from "@orc/types";
import { defaultSettings } from "./config.js";
import type { Db } from "./db/index.js";
import * as repo from "./db/repo.js";
import { manualCostUsd } from "./pricing.js";
import { ResourceManager, accountingSnapshot, invocationCost } from "./resources";

export interface PersistedInvocationEvent {
  invocation: ModelInvocation;
  /** True only for the first terminal event accepted for this id. */
  transitioned: boolean;
  cost?: ReturnType<typeof repo.createCost>;
}

/**
 * Persist one producer lifecycle event. Starts are idempotent; terminal
 * events use a compare-and-set transition, so a late adapter result, retrying
 * HTTP handler, or duplicated event cannot bill the same CLI call twice.
 *
 * B46: any failure here (a SQLite write/CAS problem, not a domain-level
 * verification result) surfaces as `InvocationLedgerError` so a caller that
 * wraps this inside a capability check (e.g. Figma preflight) can let it
 * propagate instead of mislabeling an accounting failure as that capability
 * being unavailable.
 *
 * A caller that already owns the validated settings snapshot for this event
 * can pass it through so terminal pricing does not re-read the same row.
 */
export function persistInvocationEvent(
  db: Db,
  event: ModelInvocation,
  settingsSnapshot?: Settings,
): PersistedInvocationEvent {
  try {
    const resources = new ResourceManager(db);
    if (event.outcome === "running") {
      return db.transaction(() => {
        const previous = repo.getInvocation(db, event.id);
        if (previous) return { invocation: previous, transitioned: false };
        const settings = settingsSnapshot ?? repo.getSettings(db) ?? defaultSettings();
        const model = settings.models.find((candidate) => candidate.id === event.model);
        const reserved = resources.activate(event);
        if (!reserved && (event.accounting?.poolId || model?.accountPoolId && !event.accounting)) throw new ResourceUnavailableError("This model invocation has not reserved shared account capacity.", false);
        const accounting = reserved ?? event.accounting ?? (model ? accountingSnapshot(model) : { billing: "metered" as const });
        return { invocation: repo.createInvocation(db, { ...event, accounting }), transitioned: false };
      })();
    }

    // Defensive compatibility for callers that only have a terminal callback:
    // synthesize the required pre-spawn row before applying the terminal CAS.
    if (!repo.getInvocation(db, event.id)) {
      repo.createInvocation(db, {
        ...event,
        endedAt: undefined,
        outcome: "running",
        exitReason: undefined,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        tokensCached: 0,
      });
    }

    const settings =
      settingsSnapshot ?? repo.getSettings(db) ?? defaultSettings();
    const config = settings.models.find((model) => model.id === event.model);
    const manual = manualCostUsd(
      config,
      event.tokensIn,
      event.tokensOut,
      event.tokensCached,
    );
    const accounting = repo.getInvocation(db, event.id)?.accounting;
    const reported = event.reportedCostUsd ?? event.costUsd;
    const terminal = db.transaction(() => {
      const saved = repo.terminalizeInvocation(db, event.id, {
        outcome: event.outcome,
        endedAt: event.endedAt ?? new Date().toISOString(),
        exitReason: event.exitReason,
        costUsd: accounting ? invocationCost(accounting, reported, event.tokensIn, event.tokensCached, event.tokensOut) : manual ?? event.costUsd,
        reportedCostUsd: reported,
        tokensIn: event.tokensIn,
        tokensOut: event.tokensOut,
        tokensCached: event.tokensCached,
      });
      if (saved?.transitioned) {
        resources.release(event.id);
        if (saved.invocation.exitReason === "rate_limited" && saved.invocation.accounting?.poolId) resources.cooldown(saved.invocation.accounting.poolId);
      }
      return saved;
    })();
    if (!terminal) throw new Error(`invocation ${event.id} disappeared`);
    return terminal;
  } catch (error) {
    if (error instanceof ResourceUnavailableError) throw error;
    if (error instanceof InvocationLedgerError) throw error;
    throw new InvocationLedgerError(
      `failed to persist invocation ${event.id}`,
      { cause: error },
    );
  }
}
