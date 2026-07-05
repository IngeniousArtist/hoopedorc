// @orc/engine — the brain of the orchestrator.
//
// OWNER: deepseek-pro  (see docs/specs/deepseek-pro-engine.md)
//
// Responsibility: decide what runs when (DAG), isolate each task in a git
// worktree, run the assigned model via an adapter, enforce the pre-merge gates
// + validator review with a bounded fix-loop, then merge to main or escalate.
//
// Depend ONLY on @orc/types and @orc/adapters — never on @orc/server.

import type {
  GateResult,
  LogEvent,
  MergeDecision,
  ModelId,
  Project,
  Run,
  Settings,
  Task,
} from "@orc/types";
import type { AgentAdapter } from "@orc/adapters";

export { STUCK_DETECTION } from "./constants.js";
export { WorktreeManagerImpl } from "./worktree-manager.js";
export { GitServiceImpl } from "./git-service.js";
export { GateRunnerImpl } from "./gate-runner.js";
export { ValidatorImpl, SelfReviewError } from "./validator.js";
export type { ValidatorCostSink } from "./validator.js";
export { Orchestrator } from "./orchestrator.js";

/** Callbacks the engine uses to report progress + ask humans for decisions. */
export interface EngineEvents {
  onLog: (e: Omit<LogEvent, "id">) => void;
  onTaskUpdated: (t: Task) => void;
  onRunUpdated: (r: Run) => void;
  onMergeDecision: (d: MergeDecision) => void;
  /** Ask a human (UI/Telegram); resolves with the chosen option. */
  requestApproval: (args: {
    taskId: string;
    title: string;
    message: string;
    options: string[];
  }) => Promise<string>;
}

/** Creates/removes an isolated working directory per task. */
export interface WorktreeManager {
  create(project: Project, task: Task): Promise<{ branch: string; path: string }>;
  remove(project: Project, task: Task): Promise<void>;
  /** Paths changed in the task's worktree vs the project default branch. */
  changedFiles(project: Project, task: Task): Promise<string[]>;
  /** True if the task modified only files matching task.scopePaths. */
  changedFilesInScope(project: Project, task: Task): Promise<boolean>;
}

/** Thin wrapper over git + the `gh` CLI. */
export interface GitService {
  ensureClone(project: Project): Promise<void>;
  commitAll(worktreePath: string, message: string): Promise<void>;
  push(worktreePath: string, branch: string): Promise<void>;
  openPr(project: Project, task: Task): Promise<number>;
  mergePr(project: Project, prNumber: number): Promise<void>;
  revertMerge(project: Project, prNumber: number): Promise<void>;
  /**
   * Append a structured entry to CHANGELOG.md and push it straight to the
   * default branch. Called right after a successful merge. Deliberately
   * plain code, not an AI agent call — a changelog line from a task's own
   * title/description/PR number is mechanical, so spending a model run on
   * it would just add cost and latency for no quality benefit.
   */
  appendChangelogEntry(
    project: Project,
    task: Task,
    prNumber: number,
  ): Promise<void>;
  /**
   * Merge the latest default branch into the task's branch (in its worktree)
   * right before merging the PR, and push. A sibling task may have merged
   * overlapping files since this branch's no-conflict gate passed, leaving the
   * PR stale/conflicting at merge time. Git's 3-way merge auto-resolves
   * non-overlapping changes (the common case: different tasks appending
   * different lines to a shared entry file). Returns "conflict" only on a
   * genuine same-line conflict, which the caller handles by retrying.
   */
  syncBranchWithMain(
    project: Project,
    task: Task,
  ): Promise<"clean" | "conflict">;
}

/** Runs the objective, non-AI gates inside a worktree. */
export interface GateRunner {
  run(project: Project, task: Task): Promise<GateResult>;
}

/** The AI reviewer (deepseek-pro by default): grades against acceptance criteria. */
export interface Validator {
  /**
   * authorModel is the model that actually produced this attempt — pass the
   * orchestrator's currentModel, not task.assignedModel. They diverge once
   * fallback escalation has switched models mid-task, and the self-review
   * check below must compare against whoever actually wrote the code.
   */
  review(
    project: Project,
    task: Task,
    gate: GateResult,
    authorModel: ModelId,
    /** Stream the reviewer's output so a multi-minute review isn't silent
     *  (a silent validator phase makes a task look frozen). */
    onLog?: (line: string) => void,
  ): Promise<MergeDecision>;
}

export interface SchedulerDeps {
  worktrees: WorktreeManager;
  git: GitService;
  gates: GateRunner;
  validator: Validator;
  settings: Settings;
  events: EngineEvents;
  /** Resolves an author model id to the adapter that runs it. */
  adapterFor: (modelId: ModelId) => AgentAdapter;
  /** Base URL of the running `opencode serve` instance (for opencode adapters). */
  opencodeBaseUrl: string;
  /**
   * Re-fetches every task row for the project. Consulted at the top of each
   * pass of the autonomous loop so it reconciles against the DB: tasks
   * committed mid-run (e.g. via plan/commit while this project's loop is
   * already running — see B9) are picked up without restarting the run, and
   * field edits made through the UI (reassigning a model, editing scope,
   * PATCHing status) on any task this orchestrator isn't actively running are
   * adopted instead of silently ignored. Optional; if omitted, the loop only
   * ever sees the task list it was started with.
   */
  getTasks?: () => Task[];
  /**
   * Returns a reason string if running `modelId` would exceed a budget cap, or
   * `null` if within budget. Consulted before dispatching each task and before
   * each retry attempt so an unattended run stops once a cap is hit. Optional;
   * if omitted, no budget enforcement is applied.
   */
  checkBudget?: (modelId: ModelId) => string | null;
}

export interface Scheduler {
  start(project: Project, tasks: Task[]): Promise<void>;
  pause(project: Project): Promise<void>;
  /** Tasks whose dependsOn are all `done` and are still in `backlog`. */
  readyTasks(tasks: Task[]): Task[];
}
