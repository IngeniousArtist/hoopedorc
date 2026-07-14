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
export {
  DEFAULT_GATE_IMAGE,
  detectDocker,
  isPlausibleImageRef,
  resolveSandboxMode,
} from "./sandbox.js";
export type { SandboxMode } from "./sandbox.js";

export interface GitAcquisition<T> {
  ok: boolean;
  value: T;
  error?: string;
  /** UTF-8 bytes observed before completion or the configured safety limit. */
  byteCount: number;
  /** True when output hit the safety limit and is therefore incomplete. */
  truncated: boolean;
}

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
  /**
   * F32: fired when a task's author model hits trouble worth telling a human
   * about — the *first* rate-limit wait for a task (not every wait, so it's
   * one ping, not spam), every fallback-model switch, and a terminal failure
   * with no fallback left. Optional; if omitted, the engine still does the
   * wait-and-retry/fallback logic itself, it just has no one to tell.
   *
   * B32: `"quota_wait"` fires once per stall when the WHOLE run is waiting
   * on a cooldown/quota window to clear (every ready task's fallback chain
   * currently blocked, nothing active) — distinct from `"fallback"`, which
   * fires per-task when dispatch actually lands on a fallback model instead
   * of waiting.
   */
  onModelTrouble?: (info: {
    taskId: string;
    taskTitle: string;
    model: ModelId;
    event: "rate_limit_wait" | "fallback" | "exhausted" | "quota_wait";
    detail: string;
  }) => void;
}

/** Creates/removes an isolated working directory per task. */
export interface WorktreeManager {
  create(
    project: Project,
    task: Task,
    signal?: AbortSignal,
  ): Promise<{ branch: string; path: string }>;
  remove(project: Project, task: Task): Promise<void>;
  /** Paths changed in the task's worktree vs the project default branch. */
  changedFiles(project: Project, task: Task): Promise<string[]>;
  /** True if the task modified only files matching task.scopePaths. */
  changedFilesInScope(project: Project, task: Task): Promise<boolean>;
  /**
   * F30: revert any UNCOMMITTED worktree changes outside `allowedPatterns`
   * (minimatch globs) and return the paths that were reverted. Used to
   * hard-enforce the per-task documentation stage's file scope — the
   * documenter model is prompted to touch only docs, but this is the actual
   * enforcement, not just an instruction. Tracked modifications are restored
   * to their last-committed content; untracked new files are deleted
   * outright. Scoped to whatever is uncommitted at call time (not the whole
   * branch), so call this right after the documenter's run finishes and
   * before committing its changes.
   */
  revertOutOfScope(task: Task, allowedPatterns: string[]): Promise<string[]>;
  /**
   * S8: like `changedFiles`, but pairs each path with its git status
   * (A/M/D/R100/C100/...) — destructive-change detection needs to know
   * WHICH changed files were DELETED, not just that they changed. Renames
   * report the path they were renamed TO (a rename isn't a deletion).
   */
  changedFilesWithStatus(
    project: Project,
    task: Task,
  ): Promise<GitAcquisition<{ path: string; status: string }[]>>;
  /**
   * S8/S9: the task's bounded diff vs the default branch for mechanical
   * destructive-change detection. Acquisition failure and truncation are
   * explicit so callers can fail closed instead of treating missing output
   * as a clean diff.
   */
  diffText(project: Project, task: Task): Promise<GitAcquisition<string>>;
  /** Non-ignored tracked/untracked changes currently present vs task HEAD. */
  worktreeChanges(task: Task): Promise<GitAcquisition<string[]>>;
  /** Restore only the disposable task worktree to its committed HEAD. */
  restoreToHead(task: Task): Promise<GitAcquisition<void>>;
  /**
   * B33: diagnostic-only — names of files currently dirty in the PRIMARY
   * clone's working tree, EXCLUDING package.json/lockfiles (B29's
   * worktree-manifest copy legitimately dirties those before an install,
   * so they're not a sign anything went wrong). Consulted when an author
   * produced zero changes in its own worktree, to tell "wrote to the wrong
   * directory" apart from "ran out of steps" — report-only, NEVER resets
   * anything (syncPrimary elsewhere self-heals; a reset here could race
   * it).
   */
  primaryDirtyFiles(project: Project): Promise<string[]>;
}

/** Thin wrapper over git + the `gh` CLI. */
export interface GitService {
  ensureClone(project: Project, signal?: AbortSignal): Promise<void>;
  commitAll(
    worktreePath: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<void>;
  push(worktreePath: string, branch: string, signal?: AbortSignal): Promise<void>;
  openPr(project: Project, task: Task, signal?: AbortSignal): Promise<number>;
  mergePr(project: Project, prNumber: number, signal?: AbortSignal): Promise<void>;
  revertMerge(project: Project, prNumber: number): Promise<void>;
  /**
   * Close a terminally-failed task's open PR (with a comment explaining why)
   * and delete its remote branch, so failed attempts don't pile dead orc/*
   * branches and open PRs on the target repo forever. Merged PRs already
   * clean up via `gh pr merge --delete-branch`; this covers the failure
   * path. Strictly best-effort — cleanup must never turn a handled failure
   * into a crash.
   */
  cleanupTaskBranch(project: Project, task: Task): Promise<void>;
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
    signal?: AbortSignal,
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
    signal?: AbortSignal,
  ): Promise<"clean" | "conflict">;
  /**
   * F15: poll the target repo's own CI/checks for `prNumber` (opt-in via
   * `ProjectConfig.requireGithubChecks`) — distinct from this app's local
   * gates, which can't see the target repo's configured checks at all.
   * Polls `gh pr checks` every ~15s. Returns:
   * - `"passed"`: every check succeeded (or was skipped/neutral)
   * - `"none"`: the repo has no checks configured for this PR at all —
   *   treated as nothing to wait for, not a failure
   * - `"failed"`: at least one check failed or was cancelled
   * - `"timeout"`: still pending when `timeoutMs` elapsed
   * `onPoll` fires once per poll attempt (including the first) so the
   * caller can emit a log line and keep the task's activity heartbeat fresh
   * during what can be a multi-minute wait.
   */
  waitForChecks(
    project: Project,
    prNumber: number,
    timeoutMs: number,
    onPoll?: (elapsedMs: number) => void,
    signal?: AbortSignal,
  ): Promise<"passed" | "failed" | "none" | "timeout">;
}

/** Runs the objective, non-AI gates inside a worktree. */
export interface GateRunner {
  run(project: Project, task: Task, signal?: AbortSignal): Promise<GateResult>;
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
    signal?: AbortSignal,
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
   * B30: newest-first persisted MergeDecisions for a task, used only at
   * start()'s orphan recovery to tell "was mid-authoring when this process
   * died" apart from "was only awaiting a human decision" — the latter
   * re-arms the pending approval instead of requeueing to backlog for a
   * full re-run. Optional; if omitted, every in_progress/in_review task on
   * boot is treated as orphaned exactly as before B30.
   */
  getMergeDecisions?: (taskId: string) => MergeDecision[];
  /**
   * F41: the project's oldest still-unresolved `requiresApproval`
   * notification, if any — consulted once per dispatch pass (not per task)
   * when `Settings.holdWhileAwaitingApproval` is true, to hold back new
   * dispatch while a decision is pending. Optional; if omitted (or the
   * setting is off), dispatch behavior is unaffected — a pending approval
   * still blocks only its own task, exactly as before F41.
   */
  getPendingApproval?: (projectId: string) => { title: string } | undefined;
  /**
   * Returns a reason string if running `modelId` would exceed a budget cap, or
   * `null` if within budget. Consulted before dispatching each task and before
   * each retry attempt so an unattended run stops once a cap is hit. Optional;
   * if omitted, no budget enforcement is applied.
   */
  checkBudget?: (modelId: ModelId) => string | null;
  /**
   * F6: returns a reason string if `modelId` is currently "cooling down"
   * after a rate-limit-shaped failure (see @orc/adapters' classifyFailure),
   * or `null` otherwise. Consulted only when picking a *new* task to
   * dispatch — like checkBudget, a ready task whose assigned model is
   * cooling down is skipped (not failed) so it dispatches once the window
   * passes, or once reassigned to a different model. Optional; if omitted,
   * no cooldown is applied.
   */
  checkModelCooldown?: (modelId: ModelId) => string | null;
  /**
   * F16: returns a reason string if `modelId`'s configured subscription
   * quota (a rolling window of run-count and/or cost) has been reached, or
   * `null` otherwise. Consulted at both places `checkBudget` is — the
   * dispatch loop (skip, don't fail, so it dispatches once the window
   * rolls) and the retry/attempt path (requeue to backlog, mirroring how
   * checkBudget itself is handled there). Optional; if omitted, no quota
   * enforcement is applied.
   */
  checkModelQuota?: (modelId: ModelId) => string | null;
  /**
   * F32: overrides `RATE_LIMIT_WAIT_MS` (the default 5-minute wait-and-retry
   * delay for a rate-limited author run). Production leaves this unset;
   * unit tests shrink it so a rate-limit retry test doesn't sleep for real.
   */
  rateLimitWaitMs?: number;
  /**
   * F12: shared per-model concurrency accounting, so `ModelConfig.maxConcurrent`
   * holds across every concurrently-running project, not just within one
   * Orchestrator instance. `EngineRunner` wires all three to one `Map` shared
   * by every project's Orchestrator; if omitted (e.g. unit tests), the
   * Orchestrator falls back to counting only its own dispatches.
   */
  getModelActive?: (modelId: ModelId) => number;
  incModelActive?: (modelId: ModelId) => void;
  decModelActive?: (modelId: ModelId) => void;
}

export interface OrchestratorStartOptions {
  /**
   * B34: dynamic dispatch filter used by EngineRunner's one per-project
   * runtime. A manual-only runtime admits persisted priority requests; if
   * Start promotes that runtime to autonomous mode, the closure immediately
   * begins admitting every ready task without creating another Orchestrator.
   */
  shouldDispatch?: (task: Task) => boolean;
}

export interface Scheduler {
  start(
    project: Project,
    tasks: Task[],
    opts?: OrchestratorStartOptions,
  ): Promise<void>;
  /** `{ drain: true }` (F3) lets already-active tasks finish instead of
   *  aborting them immediately. */
  pause(project: Project, opts?: { drain?: boolean }): Promise<void>;
  /** Tasks whose dependsOn are all `done` and are still in `backlog`. */
  readyTasks(tasks: Task[]): Task[];
}
