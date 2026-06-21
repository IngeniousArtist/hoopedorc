import type { EstimateResponse, ModelId, Settings, Task } from "@orc/types";
import type { Db } from "./db/index";
import * as repo from "./db/repo";

// Pre-run cost estimate. We average each model's historical spend per run from
// the costs table; when a model has no history yet we fall back to a rough
// per-run default so a brand-new project still gets a number (flagged low
// confidence). Each task costs roughly one author run + one validator run;
// the "high" figure assumes every allowed attempt is used.

const FALLBACK_PER_RUN: Record<string, number> = {
  claude: 0.2, // Claude Code carries large cache-creation overhead
  "deepseek-pro": 0.02,
  "deepseek-flash": 0.006,
  glm: 0.02,
  grok: 0.02,
  nex: 0.0, // free tier
};
const GENERIC_FALLBACK = 0.02;

/** Tasks that still have work to do (everything except done/failed). */
const NON_TERMINAL: ReadonlySet<Task["status"]> = new Set([
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "changes_requested",
  "blocked",
]);

export function estimatePlan(
  db: Db,
  projectId: string,
  settings: Settings,
): EstimateResponse {
  const averages = repo.getModelRunAverages(db);
  const hasHistory = (m: string) => Boolean(averages[m]?.runs);
  const perRun = (m: string) =>
    averages[m]?.runs
      ? averages[m]!.avgCostPerRun
      : (FALLBACK_PER_RUN[m] ?? GENERIC_FALLBACK);

  const tasks = repo
    .getTasks(db, projectId)
    .filter((t) => NON_TERMINAL.has(t.status));

  let totalExpectedUsd = 0;
  let totalHighUsd = 0;
  let allHaveHistory = true;

  const estimates = tasks.map((t) => {
    const author = t.assignedModel;
    const validator: ModelId = settings.routing.validatorByDifficulty[t.difficulty];
    const authorRun = perRun(author);
    const validatorRun = perRun(validator);
    const attempts = Math.max(1, t.maxAttempts);

    const expectedUsd = authorRun + validatorRun;
    const highUsd = (authorRun + validatorRun) * attempts;
    const taskHasHistory = hasHistory(author) && hasHistory(validator);

    totalExpectedUsd += expectedUsd;
    totalHighUsd += highUsd;
    if (!taskHasHistory) allHaveHistory = false;

    return {
      taskId: t.id,
      title: t.title,
      model: author,
      validatorModel: validator,
      expectedUsd,
      highUsd,
      hasHistory: taskHasHistory,
    };
  });

  const confidence: "high" | "low" =
    tasks.length > 0 && allHaveHistory ? "high" : "low";
  const note =
    tasks.length === 0
      ? "No tasks left to run."
      : confidence === "high"
        ? "Based on your historical per-model spend per run."
        : "Low confidence: some models have no run history yet, so rough defaults were used.";

  return { tasks: estimates, totalExpectedUsd, totalHighUsd, confidence, note };
}
