// Core domain model for the Hoopedorc orchestrator.
//
// THIS FILE IS THE SHARED CONTRACT. The engine, server, adapters, and web app
// all build against these types. A change here is a breaking change that must be
// coordinated across every module — treat it accordingly.

/**
 * The models available to the orchestrator. The named ids are the shipped
 * defaults (autocompleted everywhere); `(string & {})` keeps the union open so
 * the user can add/remove arbitrary models from the Settings UI.
 */
export type ModelId =
  | "claude" // planner + optional reviewer — runs via Claude Code (Pro sub)
  | "glm" // frontend specialist + frontend reviewer — via OpenCode
  | "deepseek-pro" // hard tasks + primary validator/merger — via OpenCode
  | "deepseek-flash" // medium tasks — via OpenCode
  | "grok" // status summaries / Telegram updates — via OpenCode
  | "nex" // documentation — via OpenCode (OpenRouter, free tier)
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

/** What a model is allowed/expected to do. */
export type Role =
  | "planner"
  | "frontend"
  | "hard"
  | "medium"
  | "docs"
  | "validator"
  | "updates";

/** How the orchestrator actually executes a model. */
export type RunnerKind = "claude-code" | "opencode";

export interface ModelConfig {
  id: ModelId;
  displayName: string;
  runner: RunnerKind;
  /**
   * For runner === "opencode": the provider/model string OpenCode expects.
   * Get the exact values from `opencode models`. The defaults shipped in the
   * scaffold are placeholders and must be verified against your OpenCode setup.
   */
  opencodeModel?: string;
  /**
   * For runner === "claude-code": the `claude --model` alias or id to target
   * (e.g. "sonnet" / "opus" / "claude-opus-4-8"). Lets the same Claude runner
   * back both a cheap model and a high-leverage one. Omitted => CLI default.
   */
  claudeModel?: string;
  roles: Role[];
  enabled: boolean;
  /** Cost accounting + budget caps (USD). */
  costPer1kInputUsd?: number;
  costPer1kOutputUsd?: number;
  monthlyBudgetUsd?: number;
  /** How many tasks this model may run at once. */
  maxConcurrent: number;
}

export type Difficulty = "easy" | "medium" | "hard";

export type TaskStatus =
  | "backlog" // planned, not yet runnable (deps unmet)
  | "ready" // deps satisfied, can be dispatched
  | "in_progress" // a model is actively working in a worktree
  | "in_review" // implementation done; gates + validator running
  | "changes_requested" // validator asked for fixes; will retry
  | "blocked" // waiting on a dependency or a human decision
  | "done" // merged to main
  | "failed"; // exhausted retries / hard failure

/** Every value of TaskStatus, in kanban column order. Single source of truth
 *  for validating PATCH /api/tasks/:id's status field and for building the
 *  Board's column list, so the two can't silently drift apart. */
export const TASK_STATUSES: TaskStatus[] = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "changes_requested",
  "blocked",
  "done",
  "failed",
];

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  difficulty: Difficulty;
  status: TaskStatus;
  /** DAG edges: task ids that must be `done` before this one is `ready`. */
  dependsOn: string[];
  /** Objective, checkable statements the validator grades the work against. */
  acceptanceCriteria: string[];
  /** The model assigned to implement this task (resolved via the RoutingPolicy). */
  assignedModel: ModelId;
  /** Optional category for role-based routing, e.g. "frontend" or "docs". */
  role?: Role;
  /**
   * Glob patterns this task is allowed to modify. Edits outside this set trip
   * the "out-of-scope" rail and force a human approval before merge.
   */
  scopePaths: string[];
  /** Git/GitHub state, populated as the task runs. */
  branch?: string;
  worktreePath?: string;
  prNumber?: number;
  attempts: number;
  maxAttempts: number;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export type ProjectStatus =
  | "created"
  | "planning"
  | "planned"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export interface Project {
  id: string;
  name: string;
  repoUrl: string; // GitHub remote
  defaultBranch: string; // usually "main"
  localPath: string; // primary clone on disk
  status: ProjectStatus;
  prdPath?: string; // path to the generated PRD within the repo (e.g. docs/PRD.md)
  /** The last committed PRD markdown. Persisted so a later planning iteration
   *  (v2) can be given what the project already set out to build. */
  prd?: string;
  budgetUsd?: number; // hard cap for the whole project run
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = "running" | "passed" | "failed" | "stopped";

/** A single execution of one task by one model. */
export interface Run {
  id: string;
  /** Which project this run belongs to — lets the WS hub scope run.updated
   *  broadcasts to clients subscribed to this project (see B15). */
  projectId: string;
  taskId: string;
  model: ModelId;
  attempt: number;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  /** "completed" | "stuck" | "budget" | "error" | "killed" */
  exitReason?: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  id: string;
  /** Which project this log line belongs to — lets the WS hub scope log
   *  broadcasts to clients subscribed to this project (see B15). */
  projectId: string;
  runId: string;
  taskId: string;
  ts: string;
  level: LogLevel;
  /** "agent" | "engine" | "git" | "gate" | "validator" */
  source: string;
  message: string;
}

/** Objective pre-merge gates. ALL must pass for an auto-merge. */
export interface GateResult {
  typecheck: boolean;
  lint: boolean;
  build: boolean;
  tests: boolean;
  noConflicts: boolean;
  /** True only if the run modified files within task.scopePaths. */
  inScope: boolean;
  /**
   * True when typecheck/lint/build/tests all had no script to run (a
   * script-less repo, e.g. a brand-new scaffold) — every gate "passed" only
   * because nothing objective ran. Treated as risky by canAutoMerge unless
   * `Settings.allowVacuousGates` is on.
   */
  vacuous?: boolean;
  /** gate name -> output/summary, for logs + the audit trail. */
  details: Record<string, string>;
}

export type MergeVerdict = "approve" | "request_changes" | "escalate";

export interface MergeDecision {
  id: string;
  /** Which project this decision belongs to — lets the WS hub scope
   *  merge.decision broadcasts to clients subscribed to this project (see
   *  B15). */
  projectId: string;
  taskId: string;
  runId: string;
  validatorModel: ModelId;
  verdict: MergeVerdict;
  /** Why. For `request_changes`, these become the fix instructions. */
  reasons: string[];
  /** 0..1; below Settings.confidenceThreshold => escalate to a human. */
  confidence: number;
  gate: GateResult;
  ts: string;
}

export type NotificationSeverity = "info" | "warn" | "action_required";

/**
 * Surfaced in the UI and over Telegram. `action_required` notifications with
 * `requiresApproval` block the related decision until answered.
 */
export interface Notification {
  id: string;
  projectId: string;
  taskId?: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  requiresApproval: boolean;
  /** Choices to present, e.g. ["approve", "reject"]. */
  options?: string[];
  respondedWith?: string;
  createdAt: string;
}

export interface CostRecord {
  id: string;
  projectId: string;
  model: ModelId;
  taskId?: string;
  runId?: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  ts: string;
}

/** One entry in the append-only audit trail. */
export interface AuditEntry {
  id: string;
  projectId: string;
  taskId?: string;
  ts: string; // ISO 8601
  /** merge_decision | approval_requested | approval_resolved | task_done | task_failed | rollback | ... */
  kind: string;
  /** Who/what triggered it: "validator:<model>" | "human" | "engine". */
  actor: string;
  summary: string;
  detail?: Record<string, unknown>;
}

export type MergePolicy =
  | "hard_gate_flag_risky" // gates + validator pass, ask only for risky changes (DEFAULT)
  | "fully_autonomous" // gates + validator pass => merge, never ask
  | "always_ask"; // build everything, but require a human tap to merge

/**
 * Which model fills each job. This is exactly what the Settings UI exposes as a
 * set of dropdowns, so jobs can be re-routed freely — e.g. point `byRole.docs`
 * at `grok` if `nex` becomes unavailable. Only `enabled` models are selectable.
 */
export interface RoutingPolicy {
  /** Plans the project and writes the PRD + task DAG. */
  planner: ModelId;
  /** Default author model by task difficulty (the fallback when no role fits). */
  byDifficulty: Record<Difficulty, ModelId>;
  /**
   * Role-specific author overrides (e.g. frontend->glm, docs->nex, updates->grok).
   * Optional per role; wins over `byDifficulty` when a task's `role` matches.
   */
  byRole: Partial<Record<Role, ModelId>>;
  /** Reviewer/merger by difficulty. Must differ from the author at run time. */
  validatorByDifficulty: Record<Difficulty, ModelId>;
}

/**
 * Placeholder the server substitutes for a secret's real value on read
 * (GET/PUT /api/settings), so a settings payload never round-trips it back
 * over the wire. Sending this value back on save leaves the stored secret
 * untouched instead of overwriting it with the literal sentinel.
 */
export const SECRET_SENTINEL = "__SET__";

/** Global, persisted settings. */
export interface Settings {
  models: ModelConfig[];
  /** Role/difficulty -> model assignment. Edited via the Settings selectors. */
  routing: RoutingPolicy;
  mergePolicy: MergePolicy;
  /** Change classes that always require human approval, regardless of gates. */
  riskyChangeRules: {
    dbSchema: boolean;
    newDependencies: boolean;
    authOrSecrets: boolean;
    outOfScopeEdits: boolean;
  };
  /**
   * When false (default), a gate result where typecheck/lint/build/tests all
   * had no script to run (nothing objective actually ran) is treated as risky
   * — auto-merge is refused and the task escalates to human approval.
   */
  allowVacuousGates?: boolean;
  /** Set once the first-run onboarding wizard (Welcome) completes. Absence
   *  (combined with zero projects) is what routes a fresh install there. */
  onboardedAt?: string;
  globalMonthlyBudgetUsd?: number;
  /** Validator confidence below this => escalate to a human. */
  confidenceThreshold: number;
  /**
   * Base directory new project clones live under by default (e.g. ~/projects).
   * A project's own `localPath` can still override this at creation time.
   * Falls back to ENV.reposDir (~/.hoopedorc/repos) when unset.
   */
  defaultProjectsDir?: string;
  telegram?: {
    enabled: boolean;
    /** Name of the env var holding the token (fallback if botToken is unset). */
    botTokenRef?: string;
    /**
     * Raw bot token, stored locally. Takes precedence over botTokenRef. Fine for
     * a solo box behind Tailscale; prefer botTokenRef if you'd rather not persist
     * the token in the DB.
     */
    botToken?: string;
    chatId?: string;
  };
  /**
   * Bearer token required on every /api/* request (and as a `?token=` query
   * param on the /ws upgrade) when set. `API_TOKEN` env wins over this if
   * both are present. Required whenever HOST is bound to a non-loopback
   * address unless ALLOW_UNAUTHENTICATED=1. Redacted on GET /api/settings.
   */
  apiToken?: string;
}

/**
 * Resolve which model should author a task. A role override (e.g. docs->grok)
 * wins over the difficulty default. Engine, server, and the planner should all
 * route through this helper so assignment stays consistent.
 */
export function pickAssignedModel(
  routing: RoutingPolicy,
  difficulty: Difficulty,
  role?: Role,
): ModelId {
  if (role) {
    const override = routing.byRole[role];
    if (override) return override;
  }
  return routing.byDifficulty[difficulty];
}
