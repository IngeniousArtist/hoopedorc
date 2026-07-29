import type { Task } from "@orc/types";

/** Effective author-invocation limit for the current logical run. */
export function effectiveAttemptLimit(
  task: Pick<Task, "maxAttempts" | "runExtraAttempts">,
): number {
  return task.maxAttempts + (task.runExtraAttempts ?? 0);
}

function runPrefix(
  task: Pick<Task, "id" | "runGeneration">,
): string {
  return (task.runGeneration ?? 0) === 0
    ? `run-${task.id}`
    : `run-${task.id}-g${task.runGeneration}`;
}

/** Stable identity for the current author/validator attempt. */
export function taskRunId(
  task: Pick<Task, "id" | "runGeneration" | "attempts">,
): string {
  return `${runPrefix(task)}-${task.attempts}`;
}

/** Stable identity for the current logical run's documenter invocation. */
export function docsRunId(
  task: Pick<Task, "id" | "runGeneration">,
): string {
  return `${runPrefix(task)}-docs`;
}
