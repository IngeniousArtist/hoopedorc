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
export { ValidatorImpl } from "./validator.js";
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
}

/** Runs the objective, non-AI gates inside a worktree. */
export interface GateRunner {
  run(project: Project, task: Task): Promise<GateResult>;
}

/** The AI reviewer (deepseek-pro by default): grades against acceptance criteria. */
export interface Validator {
  review(project: Project, task: Task, gate: GateResult): Promise<MergeDecision>;
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
}

export interface Scheduler {
  start(project: Project, tasks: Task[]): Promise<void>;
  pause(project: Project): Promise<void>;
  /** Tasks whose dependsOn are all `done` and are still in `backlog`. */
  readyTasks(tasks: Task[]): Task[];
}
