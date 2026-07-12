import type { ModelConfig } from "@orc/types";

/**
 * Manual per-model pricing (Settings → Models → the three $/1M-token
 * fields). The CLIs' own pricing tables — OpenCode's especially — go stale,
 * and Codex reports no cost at all, so every budget/analytics number
 * downstream inherits the error. When the operator sets any of the three
 * prices for a model, recorded costs for that model are recomputed from its
 * actual token counts instead of trusting the CLI's figure.
 *
 * Returns the recomputed USD cost, or `null` when no manual price is set
 * (caller keeps the CLI-reported cost). Unset fields count as $0 so e.g. a
 * free-input model only needs its output price filled in. `tokensIn` is
 * fresh (non-cached) input — the adapters normalize to that convention.
 */
export function manualCostUsd(
  cfg: Pick<
    ModelConfig,
    "costPerMInputUsd" | "costPerMCachedInputUsd" | "costPerMOutputUsd"
  > | undefined,
  tokensIn: number,
  tokensOut: number,
  tokensCached = 0,
): number | null {
  if (!cfg) return null;
  const { costPerMInputUsd, costPerMCachedInputUsd, costPerMOutputUsd } = cfg;
  if (
    costPerMInputUsd == null &&
    costPerMCachedInputUsd == null &&
    costPerMOutputUsd == null
  ) {
    return null;
  }
  return (
    (tokensIn / 1_000_000) * (costPerMInputUsd ?? 0) +
    (tokensCached / 1_000_000) * (costPerMCachedInputUsd ?? 0) +
    (tokensOut / 1_000_000) * (costPerMOutputUsd ?? 0)
  );
}
