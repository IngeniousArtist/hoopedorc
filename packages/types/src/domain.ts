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
export type RunnerKind = "claude-code" | "opencode" | "codex";

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
  /**
   * For runner === "codex": the `codex exec -m/--model` id to target (e.g.
   * "gpt-5.2-codex"). Omitted => CLI default, mirroring `claudeModel`.
   */
  codexModel?: string;
  roles: Role[];
  enabled: boolean;
  /**
   * Manual pricing overrides (USD per 1M tokens), editable in Settings.
   * When ANY of the three is set, every recorded run/validator cost for this
   * model is recomputed from its token counts using these prices (unset
   * fields count as $0) instead of trusting the CLI's own reported cost —
   * the CLIs' built-in pricing tables (especially OpenCode's) go stale and
   * then every budget/analytics number downstream is wrong. Leave all three
   * unset to keep the CLI-reported cost.
   */
  costPerMInputUsd?: number;
  costPerMCachedInputUsd?: number;
  costPerMOutputUsd?: number;
  monthlyBudgetUsd?: number;
  /** How many tasks this model may run at once. */
  maxConcurrent: number;
  /**
   * F16: subscription quota awareness — declare a subscription's known
   * usage window (e.g. Claude Pro's rolling cap) so the scheduler routes
   * around exhaustion *before* burning attempts, instead of only reacting
   * after a run fails rate-limited (F6's cooldown). At least one of
   * `maxRuns`/`maxCostUsd` must be set for the quota to mean anything
   * (validated on `PUT /api/settings`).
   */
  quota?: {
    windowHours: number;
    maxRuns?: number;
    maxCostUsd?: number;
  };
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
  /**
   * B34: a persisted request to prioritize this task through the project's
   * one shared scheduler. It is cleared only when the scheduler actually
   * dispatches the task, so a queued manual request survives a restart and
   * never needs a competing one-off Orchestrator.
   */
  dispatchRequestedAt?: string;
  /**
   * One human-readable line explaining the task's latest terminal outcome —
   * "Merged PR #4" / "Gates kept failing after 3 attempts: tests" / "Stopped
   * by user". Set by the orchestrator at every done/failed/blocked
   * transition; surfaced on the Audit page and task drawer so "why did this
   * fail" doesn't require digging through logs.
   */
  statusReason?: string;
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
  /** Per-project overrides (F9) — gate scripts, retry budget, merge policy.
   *  All optional; omitted fields keep the global/default behavior. */
  config?: ProjectConfig;
  /**
   * F19: when the scheduler (see `config.schedule`) last auto-started this
   * project, so it knows not to fire again until the next interval/day is
   * due. System-managed — set only by the scheduler itself, never by the
   * config-edit UI (kept off `ProjectConfig` specifically to avoid a save
   * from the Advanced accordion racing with the scheduler's own write).
   */
  lastScheduledRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Per-project overrides (F9). Exists because repos vary: a non-npm stack
 * needs a different test invocation, a monorepo might name its scripts
 * "type-check" instead of "typecheck", and some projects want a stricter
 * (or looser) merge policy / attempt budget than the operator's global
 * defaults. Every field is optional — an unset project keeps behaving
 * exactly as it did before F9.
 */
export interface ProjectConfig {
  gates?: {
    /**
     * npm script name to run for each gate slot; falls back to the slot's
     * own name ("typecheck"/"lint"/"build"/"test") when unset. Set to
     * `false` to skip that gate entirely — it also won't count toward
     * `GateResult.vacuous` (a deliberately-skipped gate isn't "nothing ran").
     */
    typecheckScript?: string | false;
    lintScript?: string | false;
    buildScript?: string | false;
    testScript?: string | false;
    /**
     * Free-form command for the test gate on non-npm stacks (e.g.
     * "pytest -q", "cargo test"). Split on whitespace and run directly via
     * `execFile` — no shell, so quoting/pipes aren't supported. Takes
     * priority over `testScript` when set.
     */
    testCommand?: string;
  };
  /** Default Task.maxAttempts for tasks created in this project. Falls back
   *  to the engine-wide default (3) when unset. */
  maxAttempts?: number;
  /** Overrides Settings.mergePolicy for this project's auto-merge decisions. */
  mergePolicy?: MergePolicy;
  /**
   * F15: hold an auto-merge until the PR's GitHub-side checks (the target
   * repo's own CI, e.g. its own GitHub Actions) pass — distinct from this
   * app's local gates, which only see the worktree, not the target repo's
   * configured checks. Opt-in since not every repo has any configured.
   */
  requireGithubChecks?: boolean;
  /** Minutes to wait for GitHub checks before treating them as timed out.
   *  Only meaningful when `requireGithubChecks` is true; default 15. */
  githubChecksTimeoutMin?: number;
  /**
   * F19: cron-style auto-start for maintenance tasks — "run this project's
   * backlog every night" without a human pressing Start. A timer in the
   * server checks every project's schedule roughly once a minute and calls
   * the same `EngineRunner.start()` the UI's Start button does; it does
   * not add a new dispatch mechanism, just triggers the existing one.
   */
  schedule?: ProjectSchedule;
  /**
   * F30: after the validator approves a task (including the approve_anyway /
   * escalate-approve paths) and before the merge, run a docs-role-routed
   * model in the same worktree to update CHANGELOG.md (and README.md/docs/**
   * only if this change makes them wrong) so the docs commit rides the same
   * PR as the code it describes. Default true (the owner's requested
   * standard workflow); set false to opt a project out entirely. Strictly
   * best-effort — a documentation failure never blocks a validated merge.
   */
  perTaskDocs?: boolean;
  /**
   * F34: free-text nudges naming skills the author model should reach for
   * in this project — each line is "skill name — when to use it" (e.g.
   * "frontend-design-guidelines — read before building any UI component").
   * Only `claude` (Claude Code) has a real skills mechanism (discovered from
   * `~/.claude/skills/` or the target repo's own `.claude/skills/`); for
   * other runners this just reads as ordinary prompt instructions. Bounded
   * like other free-text prompt inputs: each entry <=200 chars, <=20 entries.
   */
  skillHints?: string[];
  /**
   * F13-P1: Docker image gate scripts and `ensureDeps`'s `npm ci|install` run
   * inside when `Settings.sandboxGates` isn't "off". Defaults to `"node:22"`
   * (`DEFAULT_GATE_IMAGE` in `@orc/engine`'s sandbox.ts). Only matters for
   * non-Node stacks (e.g. a `testCommand` like "pytest -q" needs an image
   * that actually has pytest) — most projects never need to touch this.
   */
  gateImage?: string;
}

/**
 * F19: deliberately simple recurrence, not real cron syntax — "every N
 * hours" or "once a day at HH:MM" covers the stated use case (nightly
 * maintenance runs) without a parser dependency. Times are the *server's*
 * local clock, not UTC — simplest to reason about for a single-operator,
 * single-box tool.
 */
export interface ProjectSchedule {
  enabled: boolean;
  mode: "interval" | "daily";
  /** Required when `mode === "interval"`. */
  intervalHours?: number;
  /** Required when `mode === "daily"` (24h, server-local time). */
  hour?: number;
  minute?: number;
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
  /** Cached/read-from-cache input tokens (billed cheaper than fresh input).
   *  Optional — older rows and runners that don't report it read as 0. */
  tokensCached?: number;
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
  /**
   * F22: the same PR link + top validator reasons Telegram's approval
   * message already carries (`ApprovalContext` in `packages/server/src/
   * telegram.ts`) — one source, both channels — so deciding from the web
   * UI doesn't mean hunting the Board for the task's drawer. Absent on
   * notifications that aren't a merge approval, and on any row that
   * predates this field.
   */
  context?: {
    prUrl?: string;
    reasons?: string[];
  };
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
  /** Cached input tokens — see Run.tokensCached. Optional on older rows. */
  tokensCached?: number;
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

/**
 * The structured shape of AuditEntry.detail when kind === "run_summary"
 * (F8) — one autonomous-loop start-to-finish cycle's report card. Rendered
 * specially at the top of AuditView; also what gets turned into the
 * Telegram end-of-run digest.
 */
export interface RunSummaryDetail {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  finalStatus: string;
  tasksDone: number;
  tasksFailed: number;
  totalCostUsd: number;
  prLinks: { taskId: string; title: string; prNumber: number; url: string }[];
  approvalsRequired: number;
  /** One line per failed task, newest-relevant-reason-first; capped short. */
  topFailureReasons: string[];
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
  /**
   * Deconstructs the agreed plan into the task DAG (the one high-leverage
   * call at the end of planning chat). Unset => same model as `planner`.
   */
  deconstructor?: ModelId;
  /** Default author model by task difficulty (the fallback when no role fits). */
  byDifficulty: Record<Difficulty, ModelId>;
  /**
   * Role-specific author overrides (e.g. frontend->glm, docs->nex, updates->grok).
   * Optional per role; wins over `byDifficulty` when a task's `role` matches.
   */
  byRole: Partial<Record<Role, ModelId>>;
  /** Reviewer/merger by difficulty. Must differ from the author at run time. */
  validatorByDifficulty: Record<Difficulty, ModelId>;
  /**
   * Explicit fallback escalation chain, tried in order when a task's
   * assigned model keeps failing (author errors, gates, rate limits). The
   * Settings UI exposes two ordered slots ("Fallback 1" / "Fallback 2").
   * Unset/empty => the legacy behavior: escalate through the byDifficulty
   * tiers (easy → medium → hard, wrapping down as a last resort).
   */
  fallbacks?: ModelId[];
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
    /**
     * S8: whether mass deletions, destructive DB/data operations, or other
     * changes matching the engine's detectDestructiveChanges patterns force
     * human approval. Defaults to true and — unlike the other
     * riskyChangeRules flags — is enforced in EVERY merge policy, including
     * fully_autonomous: a destructive change is never silently auto-merged
     * regardless of how permissive the operator's policy is. Optional (not
     * a plain boolean) because settings persisted before this field existed
     * lack the key entirely; `!== false` at the enforcement site treats
     * that absence as enabled, the safe reading.
     */
    destructiveChanges?: boolean;
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
    /**
     * How much task-status chatter Telegram sees. "terminal" (default, unset
     * counts as this) pushes only done/failed transitions; "all" also pushes
     * every intermediate status change (in_progress, in_review, etc.); "off"
     * suppresses task-status pushes entirely. Approval requests always go out
     * regardless of this setting — they're action-required, not chatter.
     */
    digest?: "off" | "terminal" | "all";
    /**
     * F32: push a Telegram message whenever a task's author model hits
     * trouble — the first rate-limit wait, every fallback-model switch, and
     * a terminal failure with no fallback left. Default true (unset counts
     * as enabled) since the owner explicitly asked to be alerted on these;
     * independent of `digest`, which only covers task-status chatter.
     */
    modelAlerts?: boolean;
  };
  /**
   * Bearer token required on every /api/* request (and as a `?token=` query
   * param on the /ws upgrade) when set. `API_TOKEN` env wins over this if
   * both are present. Required whenever HOST is bound to a non-loopback
   * address unless ALLOW_UNAUTHENTICATED=1. Redacted on GET /api/settings.
   */
  apiToken?: string;
  /**
   * F31: operator-editable engineering standards injected into both the
   * author prompt (buildAuthorPrompt) and the validator's review prompt, so
   * "meets the standards" is a checkable claim on both sides of the loop
   * instead of vibes. Each field is optional text (capped at 4000 chars on
   * `PUT /api/settings`); `defaultSettings()` ships real ~15-20 line
   * defaults for all three. Global only — no per-project override yet.
   */
  guidelines?: {
    coding?: string;
    ux?: string;
    security?: string;
  };
  /**
   * F13-P1 (phase 1 of docs/specs/sandbox.md): run gate scripts and
   * `ensureDeps`'s `npm ci|install` inside a Docker container instead of
   * directly on the host — closes most of B11's "repo's own scripts execute
   * arbitrary code on the host" gap for that surface. The *author agent*
   * still runs on the host regardless of this setting (phase 2/3, future
   * wave — see the spec doc's CLI-auth-in-a-container problem).
   * - `"off"`: byte-identical to pre-F13-P1 behavior — always host.
   * - `"auto"` (default): sandbox when a Docker daemon responds to
   *   `docker version`, otherwise fall back to host with a warn-once log.
   * - `"required"`: no daemon => the gate fails loudly instead of silently
   *   running unsandboxed. Meant for a box (e.g. the EC2 deploy target)
   *   where Docker's presence has already been verified.
   */
  sandboxGates?: "off" | "auto" | "required";
  /**
   * F41: when true, a project's dispatch loop skips picking up new `ready`
   * tasks while any of its notifications is an unresolved
   * `requiresApproval` one — active tasks still finish naturally (the same
   * drain semantics F3's pause uses), dispatch resumes on the next pass
   * once the approval is resolved. Trades slower overall runs for zero
   * unsupervised spend while a decision is pending. Default false (unset)
   * — today's behavior, where a pending approval blocks only its own task.
   */
  holdWhileAwaitingApproval?: boolean;
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
