import type { Settings } from "@orc/types";
import type { Db } from "./db/index";
import * as repo from "./db/repo";

/**
 * Returns a human-readable reason string if dispatching `model` for `projectId`
 * would exceed any configured budget cap, or `null` if it's within budget.
 *
 * Checks three independent caps:
 *  - project budget (all-time spend on this project),
 *  - per-model monthly budget,
 *  - global monthly budget (all projects, this calendar month).
 *
 * Used by both the manual single-task dispatch route and the autonomous
 * orchestrator loop, so budget enforcement is identical on both paths.
 */
export function checkBudget(
  db: Db,
  projectId: string,
  model: string,
  settings: Settings,
): string | null {
  // Project budget check
  const project = repo.getProject(db, projectId);
  if (project?.budgetUsd) {
    const { totalUsd } = repo.getCostSummary(db, projectId);
    if (totalUsd >= project.budgetUsd) {
      return `Project budget $${project.budgetUsd} exceeded ($${totalUsd.toFixed(2)} used)`;
    }
  }

  // Model monthly budget check
  const modelCfg = settings.models.find((m) => m.id === model);
  if (modelCfg?.monthlyBudgetUsd) {
    const monthly = repo.getModelMonthlyCost(db, model);
    if (monthly >= modelCfg.monthlyBudgetUsd) {
      return `Model ${model} monthly budget $${modelCfg.monthlyBudgetUsd} exceeded ($${monthly.toFixed(2)} used)`;
    }
  }

  // Global monthly budget check (all projects, this calendar month)
  if (settings.globalMonthlyBudgetUsd) {
    const globalMonthly = repo.getGlobalMonthlyCost(db);
    if (globalMonthly >= settings.globalMonthlyBudgetUsd) {
      return `Global monthly budget $${settings.globalMonthlyBudgetUsd} exceeded ($${globalMonthly.toFixed(2)} used)`;
    }
  }

  return null;
}

/**
 * F16: returns a reason string if `model`'s configured subscription quota
 * (a rolling window of invocation-count and/or cost, e.g. Claude Pro's usage cap)
 * has been reached, or `null` if there's no quota configured or it's within
 * bounds. Cross-project by design — a subscription's window applies to the
 * model's API key/plan, not any one project (mirrors checkModelCooldown's
 * cross-project reasoning). Used by both dispatch-loop and retry-path
 * consultation sites in the orchestrator, same as checkBudget.
 */
export function checkModelQuota(
  db: Db,
  model: string,
  settings: Settings,
): string | null {
  const quota = settings.models.find((m) => m.id === model)?.quota;
  if (!quota) return null;

  const sinceIso = new Date(
    Date.now() - quota.windowHours * 60 * 60 * 1000,
  ).toISOString();
  const { runs, costUsd } = repo.getModelUsageSince(db, model, sinceIso);

  if (quota.maxRuns != null && runs >= quota.maxRuns) {
    return `Model ${model} quota reached: ${runs}/${quota.maxRuns} calls in the last ${quota.windowHours}h`;
  }
  if (quota.maxCostUsd != null && costUsd >= quota.maxCostUsd) {
    return `Model ${model} quota reached: $${costUsd.toFixed(2)}/$${quota.maxCostUsd.toFixed(2)} spent in the last ${quota.windowHours}h`;
  }
  return null;
}

/** F7's soft-rail thresholds — checked independently, so both can fire for
 *  the same cost event (e.g. a run that pushes spend past 80% also crossed
 *  50% if it hadn't already). */
export const BUDGET_ALERT_THRESHOLDS = [50, 80] as const;

export interface BudgetAlert {
  scope: string;
  threshold: (typeof BUDGET_ALERT_THRESHOLDS)[number];
  message: string;
}

/**
 * Returns every soft threshold newly crossed since the last check — the
 * caller pushes each (WS + Telegram) and only then calls
 * repo.recordBudgetAlert, so a failed push can be retried on the next cost
 * event instead of being silently marked as sent. Pure read: never records
 * anything itself.
 */
export function checkBudgetThresholds(
  db: Db,
  projectId: string,
  settings: Settings,
): BudgetAlert[] {
  const alerts: BudgetAlert[] = [];

  const project = repo.getProject(db, projectId);
  if (project?.budgetUsd) {
    const { totalUsd } = repo.getCostSummary(db, projectId);
    const pct = (totalUsd / project.budgetUsd) * 100;
    const scope = `project:${projectId}`;
    for (const threshold of BUDGET_ALERT_THRESHOLDS) {
      if (pct >= threshold && !repo.hasBudgetAlert(db, scope, threshold)) {
        alerts.push({
          scope,
          threshold,
          message: `${project.name}: ${threshold}% of its $${project.budgetUsd} budget spent ($${totalUsd.toFixed(2)})`,
        });
      }
    }
  }

  if (settings.globalMonthlyBudgetUsd) {
    const globalMonthly = repo.getGlobalMonthlyCost(db);
    const pct = (globalMonthly / settings.globalMonthlyBudgetUsd) * 100;
    // Baking the calendar month into the scope key re-arms both thresholds
    // automatically at the start of each month, matching how the budget
    // itself is month-scoped (getGlobalMonthlyCost) — no explicit reset needed.
    const scope = `global:${new Date().toISOString().slice(0, 7)}`;
    for (const threshold of BUDGET_ALERT_THRESHOLDS) {
      if (pct >= threshold && !repo.hasBudgetAlert(db, scope, threshold)) {
        alerts.push({
          scope,
          threshold,
          message: `${threshold}% of this month's $${settings.globalMonthlyBudgetUsd} global budget spent ($${globalMonthly.toFixed(2)})`,
        });
      }
    }
  }

  return alerts;
}
