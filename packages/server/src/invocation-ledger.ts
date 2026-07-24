import { InvocationLedgerError, type ModelInvocation } from "@orc/types";
import { defaultSettings } from "./config.js";
import type { Db } from "./db/index.js";
import * as repo from "./db/repo.js";
import { manualCostUsd } from "./pricing.js";

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
 */
export function persistInvocationEvent(
  db: Db,
  event: ModelInvocation,
): PersistedInvocationEvent {
  try {
    if (event.outcome === "running") {
      return {
        invocation: repo.createInvocation(db, event),
        transitioned: false,
      };
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

    const settings = repo.getSettings(db) ?? defaultSettings();
    const config = settings.models.find((model) => model.id === event.model);
    const manual = manualCostUsd(
      config,
      event.tokensIn,
      event.tokensOut,
      event.tokensCached,
    );
    const terminal = repo.terminalizeInvocation(db, event.id, {
      outcome: event.outcome,
      endedAt: event.endedAt ?? new Date().toISOString(),
      exitReason: event.exitReason,
      costUsd: manual ?? event.costUsd,
      tokensIn: event.tokensIn,
      tokensOut: event.tokensOut,
      tokensCached: event.tokensCached,
    });
    if (!terminal) throw new Error(`invocation ${event.id} disappeared`);
    return terminal;
  } catch (error) {
    if (error instanceof InvocationLedgerError) throw error;
    throw new InvocationLedgerError(
      `failed to persist invocation ${event.id}`,
      { cause: error },
    );
  }
}
