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
