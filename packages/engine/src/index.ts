// @orc/engine — the brain of the orchestrator.
//
// OWNER: deepseek-pro  (see docs/specs/deepseek-pro-engine.md)
//
// Responsibility: decide what runs when (DAG), isolate each task in a git
// worktree, run the assigned model via an adapter, enforce the pre-merge gates
// + validator review with a bounded fix-loop, then merge to main or escalate.
//
// Everything below is an interface or a worked stub. Implement against these
// signatures. Depend ONLY on @orc/types and @orc/adapters — never on @orc/server.

import type {
  GateResult,
  LogEvent,
  MergeDecision,
  Project,
  Run,
  Settings,
  Task,
} from "@orc/types";

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
}

export interface Scheduler {
  start(project: Project, tasks: Task[]): Promise<void>;
  pause(project: Project): Promise<void>;
  /** Tasks whose dependsOn are all `done` and are still in `backlog`. */
  readyTasks(tasks: Task[]): Task[];
}

/** Tunables for killing runaway / looping runs. */
export const STUCK_DETECTION = {
  /** Hard wall-clock cap for a single run. */
  maxRunMs: 20 * 60 * 1000,
  /** Kill if no new log line within this window. */
  idleMs: 3 * 60 * 1000,
  /** Kill if the same command/tool repeats this many times consecutively. */
  maxRepeats: 8,
} as const;

/**
 * Reference implementation skeleton. `readyTasks` is fully implemented as a
 * worked example of the DAG semantics; the rest is for deepseek-pro to build.
 */
export class Orchestrator implements Scheduler {
  constructor(private readonly deps: SchedulerDeps) {}

  readyTasks(tasks: Task[]): Task[] {
    const done = new Set(
      tasks.filter((t) => t.status === "done").map((t) => t.id),
    );
    return tasks.filter(
      (t) =>
        t.status === "backlog" && t.dependsOn.every((dep) => done.has(dep)),
    );
  }

  async start(_project: Project, _tasks: Task[]): Promise<void> {
    // TODO(deepseek-pro): loop:
    //   1. readyTasks() -> respect per-model maxConcurrent
    //   2. worktrees.create -> adapter.run (assigned model) with stuck detection
    //   3. git.commitAll + push + openPr
    //   4. gates.run -> if fail, feed details back to the author model (retry <= maxAttempts)
    //   5. validator.review -> approve | request_changes (retry) | escalate (requestApproval)
    //   6. apply mergePolicy + riskyChangeRules -> git.mergePr OR requestApproval
    //   7. mark done; recompute readyTasks
    throw new Error("not implemented — see docs/specs/deepseek-pro-engine.md");
  }

  async pause(_project: Project): Promise<void> {
    throw new Error("not implemented — see docs/specs/deepseek-pro-engine.md");
  }
}
