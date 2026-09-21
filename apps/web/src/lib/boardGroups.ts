import type { Task, TaskStatus } from "@orc/types";

/**
 * VW04: the board shows outcomes, not engine states. Five readable groups
 * are a presentation over the existing `TaskStatus` values — no status is
 * renamed or migrated, and every card keeps its exact status for the
 * inspector and the server rules. Mapping is exhaustive so a new status is a
 * compile error here until it has a home.
 */
export type BoardGroupKey = "planned" | "working" | "review" | "done" | "attention";

export interface BoardGroupDefinition {
  key: BoardGroupKey;
  label: string;
  /** One operator-facing sentence: why a card sits here. */
  description: string;
  statuses: readonly TaskStatus[];
  /** What dropping a card onto this group asks the engine to do, if anything. */
  dropAction: "run_next" | null;
}

export const BOARD_GROUPS: readonly BoardGroupDefinition[] = [
  {
    key: "planned",
    label: "Planned",
    description: "Ready to run, or waiting on dependencies. Drop a card here to run it next.",
    statuses: ["backlog", "ready"],
    dropAction: "run_next",
  },
  {
    key: "working",
    label: "Working",
    description: "An agent is implementing this task, or repairing it after review feedback.",
    statuses: ["in_progress", "changes_requested"],
    dropAction: null,
  },
  {
    key: "review",
    label: "Review",
    description: "Gates and the independent validator are checking the change.",
    statuses: ["in_review"],
    dropAction: null,
  },
  {
    key: "done",
    label: "Done",
    description: "Merged with passing evidence.",
    statuses: ["done"],
    dropAction: null,
  },
  {
    key: "attention",
    label: "Needs attention",
    description: "Blocked or failed. The exact reason is on the card; Retry or Stop from its actions.",
    statuses: ["blocked", "failed"],
    dropAction: null,
  },
];

const GROUP_BY_STATUS: Record<TaskStatus, BoardGroupKey> = {
  backlog: "planned",
  ready: "planned",
  in_progress: "working",
  changes_requested: "working",
  in_review: "review",
  done: "done",
  blocked: "attention",
  failed: "attention",
};

export function groupForStatus(status: TaskStatus): BoardGroupKey {
  return GROUP_BY_STATUS[status];
}

export function tasksInGroup(tasks: readonly Task[], key: BoardGroupKey): Task[] {
  return tasks.filter((task) => groupForStatus(task.status) === key);
}

export function groupCounts(tasks: readonly Task[]): Record<BoardGroupKey, number> {
  const counts: Record<BoardGroupKey, number> = {
    planned: 0,
    working: 0,
    review: 0,
    done: 0,
    attention: 0,
  };
  for (const task of tasks) counts[groupForStatus(task.status)] += 1;
  return counts;
}

/** The group a phone list opens on: what needs a decision first, then what is moving. */
export function defaultListGroup(tasks: readonly Task[]): BoardGroupKey {
  const counts = groupCounts(tasks);
  for (const key of ["attention", "working", "review", "planned", "done"] as const) {
    if (counts[key] > 0) return key;
  }
  return "planned";
}

export type ActivityTone = "waiting" | "ready" | "active" | "review" | "done" | "attention";

export interface CardActivity {
  /** Short current-state sentence shown under the title. */
  line: string;
  tone: ActivityTone;
  /** Dependency tasks that are not done yet. */
  blockedBy: Task[];
  /** There is a PR, diff, or gate/validator evidence worth opening. */
  reviewAvailable: boolean;
}

export function cardActivity(task: Task, allTasks: readonly Task[]): CardActivity {
  const blockedBy = task.dependsOn
    .map((id) => allTasks.find((candidate) => candidate.id === id))
    .filter((dependency): dependency is Task => Boolean(dependency) && dependency!.status !== "done");
  const reviewAvailable = Boolean(task.prNumber) || task.status === "done";
  const pr = task.prNumber ? ` · PR #${task.prNumber}` : "";
  switch (task.status) {
    case "backlog":
      return blockedBy.length > 0
        ? {
            line: `Waiting on ${blockedBy.length} task${blockedBy.length === 1 ? "" : "s"}`,
            tone: "waiting",
            blockedBy,
            reviewAvailable,
          }
        : { line: "Queued — the scheduler picks it up next", tone: "waiting", blockedBy, reviewAvailable };
    case "ready":
      return {
        line: task.dispatchRequestedAt ? "Run next — waiting for scheduler capacity" : "Ready to run",
        tone: "ready",
        blockedBy,
        reviewAvailable,
      };
    case "in_progress":
      return { line: "Working", tone: "active", blockedBy, reviewAvailable };
    case "changes_requested":
      return {
        line: `Repairing after review feedback${pr}`,
        tone: "active",
        blockedBy,
        reviewAvailable,
      };
    case "in_review":
      return { line: `In review${pr}`, tone: "review", blockedBy, reviewAvailable };
    case "done":
      return { line: task.prNumber ? `Merged${pr}` : "Done", tone: "done", blockedBy, reviewAvailable };
    case "blocked":
      return {
        line: task.statusReason ? `Blocked: ${task.statusReason}` : "Blocked — stopped or waiting for a decision",
        tone: "attention",
        blockedBy,
        reviewAvailable,
      };
    case "failed":
      return {
        line: task.statusReason ? `Failed: ${task.statusReason}` : "Failed",
        tone: "attention",
        blockedBy,
        reviewAvailable,
      };
  }
}

/** Card actions the server rules allow for this exact status — nothing else is offered. */
export interface AllowedActions {
  /** backlog → ready: prioritize without inventing progress. */
  runNext: boolean;
  /** ready → backlog: hold it back. */
  defer: boolean;
  /** Abort the live attempt (in_progress / in_review). */
  stop: boolean;
  /** failed / blocked / changes_requested → a fresh prioritized run. */
  retry: boolean;
}

export function allowedActions(task: Task): AllowedActions {
  return {
    runNext: task.status === "backlog",
    defer: task.status === "ready",
    stop: task.status === "in_progress" || task.status === "in_review",
    retry:
      task.status === "failed" ||
      task.status === "blocked" ||
      task.status === "changes_requested",
  };
}
