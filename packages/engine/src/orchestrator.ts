import type {
  Difficulty,
  FigmaCapabilityIssue,
  GateResult,
  LogEvent,
  LogLevel,
  MergeDecision,
  ModelId,
  Project,
  RoutingPolicy,
  Run,
  RunStatus,
  Settings,
  Task,
} from "@orc/types";
import { abortableDelay, type AgentRunResult } from "@orc/adapters";
import {
  DOCS_STAGE_TIMEOUT_MS,
  RATE_LIMIT_RETRIES,
  RATE_LIMIT_WAIT_MS,
  STUCK_DETECTION,
} from "./constants.js";
import {
  buildAgentsMdBlock,
  buildEngineeringStandardsBlock,
  buildSkillsBlock,
  buildTaskHandoffBlock,
  SAFETY_GUARDRAILS_BLOCK,
  WORKING_DIRECTORY_BLOCK,
} from "./guidelines.js";
import { SelfReviewError } from "./validator.js";
import type {
  EngineEvents,
  FigmaAuthorCapabilityContext,
  OrchestratorStartOptions,
  Scheduler,
  SchedulerDeps,
} from "./index.js";

export const FIGMA_CAPABILITY_UNAVAILABLE_MARKER =
  "[HOOPEDORC_CAPABILITY_UNAVAILABLE:figma]";

const FIGMA_AUTHOR_RECOVERY_ACTIONS = [
  "Fix or re-authenticate Figma MCP for this runner, then Retry the task.",
  "Reassign the task to another Figma-capable model, then Retry it.",
];

export function figmaCapabilityStatusReason(
  issue: FigmaCapabilityIssue,
): string {
  const reference = issue.canonicalUrl ?? issue.nodeId ?? "referenced Figma node";
  const stage = issue.stage.replaceAll("_", " ");
  return (
    `${issue.message} Stage: ${stage}; model: ${issue.model}; runner: ${issue.runner}; ` +
    `reference: ${reference}. Recovery: ${issue.actions.join(" ")}`
  );
}

/**
 * Reduce a glob pattern to its static (non-wildcard) prefix, trailing slash
 * stripped: `src/**\/*.ts` -> "src", `**\/*` -> "", `docs/**` -> "docs". The
 * old approach only ever stripped a trailing `/**`, so any pattern with a
 * glob char *before* the end — `src/**\/*.ts`, `**\/*`, `*.md` — fell through
 * untouched and compared as a literal string, which almost never matches
 * anything. An empty prefix means "no determinable static root" (matches
 * everything), the correct conservative reading for the least-scoped
 * (riskiest) patterns like the planner's `**\/*` fallback. Exported for unit
 * tests.
 */
export function staticScopePrefix(pattern: string): string {
  const idx = pattern.search(/[*?[]/);
  const prefix = idx === -1 ? pattern : pattern.slice(0, idx);
  return prefix.replace(/\/$/, "");
}

/**
 * Returns true if the two scope-path arrays share at least one overlapping
 * file or directory prefix. Used to detect when concurrent tasks would write
 * to the same files and need to be serialized.
 * Empty arrays mean "no restriction" and therefore overlap everything: a
 * task allowed to write anywhere cannot safely run beside another writer.
 * An empty static
 * prefix on either side (e.g. from `**\/*`) means that side can't rule out
 * any file, so it overlaps with everything.
 */
export function scopesOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  for (const pa of a) {
    const na = staticScopePrefix(pa);
    for (const pb of b) {
      const nb = staticScopePrefix(pb);
      if (
        na === "" ||
        nb === "" ||
        na === nb ||
        na.startsWith(nb + "/") ||
        nb.startsWith(na + "/")
      )
        return true;
    }
  }
  return false;
}

// Matches path *segments*, not substrings: `(^|\/)` anchors the start of a
// segment and `(\/|\.|$)` anchors its end, so `src/author.ts`, `tokenizer.ts`,
// and `docs/authors.md` don't trip this (the words just happen to contain
// "auth"/"token" as a substring) while `auth.ts`, `src/auth/login.ts`, and
// `.env.local` do.
const RISKY_AUTH_OR_SECRET_FILE =
  /(^|\/)\.env(\.|$)|(^|\/)(auth|secrets?|credentials?|tokens?)(\/|\.|$)/i;

/** True if `path` looks like an auth/secrets file by path segment (not a
 *  substring match) — exported for unit tests. */
export function isAuthOrSecretFile(path: string): boolean {
  return RISKY_AUTH_OR_SECRET_FILE.test(path);
}

const SCHEMA_FILE = /(^|\/)(migrations?\/|db\/schema)|(^|\/)prisma\/schema\.prisma$|\.sql$/i;
const SENSITIVE_FILE =
  /(^|\/)\.env(\.|$)|(^|\/)\.github\/workflows\/|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const DESTRUCTIVE_SQL = /\b(DROP\s+TABLE|DROP\s+DATABASE|TRUNCATE)\b/i;
const DELETE_FROM = /\bDELETE\s+FROM\s+\S+/i;
const WHERE_CLAUSE = /\bWHERE\b/i;
const EMPTY_DELETE_MANY = /\.deleteMany\s*\(\s*\)/;
/**
 * Extracts the first target of an `rm` invocation that is both recursive and
 * forced — combined flags (-rf/-fr/-Rf/-frx), split flags (-r -f), or
 * long-form (--recursive --force), in any order and mix. Returns undefined
 * when the line has no such rm (including a plain `rm -r` or `rm -f` alone).
 * Flags placed AFTER the target (`rm /path -rf` — legal in GNU rm) are not
 * recognized, same as the combined-flag regex this replaced.
 */
function rmRfTarget(line: string): string | undefined {
  const m = line.match(/\brm\s+(\S.*)/);
  if (!m) return undefined;
  let recursive = false;
  let force = false;
  for (const tok of m[1]!.split(/\s+/)) {
    if (tok === "--") continue; // end-of-options marker, target follows
    if (tok.startsWith("--")) {
      if (tok === "--recursive") recursive = true;
      else if (tok === "--force") force = true;
      continue; // other long options (--verbose, …) don't affect the verdict
    }
    if (tok.startsWith("-") && tok.length > 1) {
      if (/[rR]/.test(tok)) recursive = true;
      if (/[fF]/.test(tok)) force = true;
      continue;
    }
    // First non-flag token is the target.
    return recursive && force ? tok : undefined;
  }
  return undefined;
}

/** True if an `rm -rf`-style target looks like it reaches outside the repo
 *  checkout or a scratch/tmp directory — a bare relative path (`dist`,
 *  `./build`, `node_modules`) is normal build-script cleanup and NOT risky;
 *  an absolute path outside /tmp, a `~`-relative path, `..` traversal, or a
 *  `$VAR`-expanded path could resolve to anything. */
function looksLikeRiskyRmTarget(target: string): boolean {
  if (target.startsWith("/tmp") || target.startsWith("/var/tmp")) return false;
  if (target.startsWith("/")) return true;
  return target.startsWith("~") || target.includes("..") || target.startsWith("$");
}

/**
 * S8: scans a task's changed files (with git status) and diff text for
 * changes risky enough that NO merge policy — not even fully_autonomous —
 * should auto-merge without a human looking first. Returns human-readable
 * reasons; empty means clean. Exported for unit tests. This list WILL grow
 * — keep every new pattern here, in one place, with its own test.
 */
export function detectDestructiveChanges(
  files: { path: string; status: string }[],
  diffText: string,
): string[] {
  const reasons: string[] = [];
  const deleted = files.filter((f) => f.status === "D").map((f) => f.path);

  if (deleted.length > 10) {
    reasons.push(`${deleted.length} files deleted — looks like a mass deletion`);
  } else if (files.length > 3 && deleted.length / files.length > 0.5) {
    reasons.push(`${deleted.length}/${files.length} changed files were deleted — more than half`);
  }

  // Every changed file under some top-level directory was deleted (e.g. an
  // `rm -rf src/`) — catches a directory wipe even in a small repo where the
  // absolute-count/share thresholds above wouldn't trip.
  const topDirs = new Map<string, { total: number; deleted: number }>();
  for (const f of files) {
    const slash = f.path.indexOf("/");
    if (slash === -1) continue; // a root-level file isn't "a directory"
    const top = f.path.slice(0, slash);
    const entry = topDirs.get(top) ?? { total: 0, deleted: 0 };
    entry.total++;
    if (f.status === "D") entry.deleted++;
    topDirs.set(top, entry);
  }
  for (const [dir, { total, deleted: delCount }] of topDirs) {
    if (total >= 2 && total === delCount) {
      reasons.push(`every changed file under "${dir}/" was deleted (${delCount} files)`);
    }
  }

  const deletedSchema = deleted.filter((p) => SCHEMA_FILE.test(p));
  if (deletedSchema.length > 0) {
    reasons.push(`deleted migration/schema file(s): ${deletedSchema.join(", ")}`);
  }

  const deletedSensitive = deleted.filter((p) => SENSITIVE_FILE.test(p));
  if (deletedSensitive.length > 0) {
    reasons.push(`deleted sensitive file(s): ${deletedSensitive.join(", ")}`);
  }

  // Scan one line at a time rather than building an array proportional to the
  // diff. Only added lines count (a leading `+`, excluding the `+++` header):
  // a destructive statement being removed is the opposite of risky.
  let lineStart = 0;
  while (lineStart <= diffText.length) {
    const newline = diffText.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? diffText.length : newline;
    const line = diffText.slice(lineStart, lineEnd);
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (DESTRUCTIVE_SQL.test(line)) {
        reasons.push(`added a destructive SQL statement: ${line.trim().slice(0, 200)}`);
      } else if (DELETE_FROM.test(line) && !WHERE_CLAUSE.test(line)) {
        reasons.push(`added a DELETE with no WHERE clause: ${line.trim().slice(0, 200)}`);
      } else if (EMPTY_DELETE_MANY.test(line)) {
        reasons.push(`added an empty-filter deleteMany(): ${line.trim().slice(0, 200)}`);
      }

      const target = rmRfTarget(line);
      if (target && looksLikeRiskyRmTarget(target)) {
        reasons.push(`added an rm -rf targeting a path outside the repo/tmp: ${line.trim().slice(0, 200)}`);
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }

  return reasons;
}

/** F30: the only paths the per-task documenter is allowed to touch. F38 adds
 *  AGENTS.md so a merged change that alters the project's structure can
 *  keep the generated project-context file current. */
const DOCS_ALLOWED_SCOPE = ["CHANGELOG.md", "README.md", "AGENTS.md", "docs/**"];

/** Names of the objective gates that failed, for one-line status reasons. */
function failedGateNames(gate: GateResult): string[] {
  const names: string[] = [];
  if (!gate.typecheck) names.push("typecheck");
  if (!gate.lint) names.push("lint");
  if (!gate.build) names.push("build");
  if (!gate.tests) names.push("tests");
  if (!gate.noConflicts) names.push("conflicts with main");
  return names;
}

/**
 * Build the auto-escalation fallback chain for a task, starting with the
 * task's assigned model. When `routing.fallbacks` is set (the Settings UI's
 * explicit "Fallback 1"/"Fallback 2" slots) those are used in order;
 * otherwise it escalates through the difficulty tiers (easy → medium →
 * hard) using the routing byDifficulty table. Duplicates are skipped so the
 * chain never retries the same model twice. Exported for unit tests.
 */
export function buildFallbackChain(
  assignedModel: ModelId,
  difficulty: Difficulty,
  routing: RoutingPolicy,
): ModelId[] {
  const chain: ModelId[] = [assignedModel];

  if (routing.fallbacks && routing.fallbacks.length > 0) {
    for (const m of routing.fallbacks) {
      if (m && !chain.includes(m)) chain.push(m);
    }
    return chain;
  }

  const tiers: Difficulty[] = ["easy", "medium", "hard"];
  const start = tiers.indexOf(difficulty);
  // Escalate upward first (cheaper -> stronger), same as before. A task
  // starting at "hard" has no higher tier to escalate to, though — with one
  // model per tier that left hard-tier tasks with a one-model chain and zero
  // fallback room. Wrap back through the remaining tiers in descending order
  // (next-best first) as a last-resort safety net, so every task always has
  // at least one fallback regardless of where it starts.
  const order = [
    ...tiers.slice(start),
    ...tiers.slice(0, start).reverse(),
  ];
  for (const tier of order) {
    const m = routing.byDifficulty[tier];
    if (m && !chain.includes(m)) chain.push(m);
  }
  return chain;
}

export class Orchestrator implements Scheduler {
  private paused = false;
  private readonly activeTaskIds = new Set<string>();
  /** Actual task promises, not just ids. B34 uses these to keep start() from
   * resolving (and EngineRunner from unregistering the runtime) while an
   * aborted pipeline is still unwinding through a later stage/finally. */
  private readonly activeTaskPromises = new Map<string, Promise<void>>();
  private readonly taskAbortControllers = new Map<string, AbortController>();
  /**
   * F12: falls back to a per-instance count only when `deps` doesn't supply
   * a shared registry (e.g. unit tests). In production, `EngineRunner` wires
   * `deps.getModelActive`/`incModelActive`/`decModelActive` to ONE shared
   * `Map` reused by every project's Orchestrator, so `maxConcurrent` is a
   * true global cap — before this, each project's own Orchestrator counted
   * independently, so two projects could each run `maxConcurrent` copies of
   * the same model at once.
   */
  private readonly localModelActiveCount = new Map<ModelId, number>();
  /** The model each active task is CURRENTLY running on (tracks fallback
   *  escalation so the active count reflects the model actually in use, not
   *  just the originally-assigned one). */
  private readonly runningModel = new Map<string, ModelId>();
  /** Tasks already logged as budget-blocked this run, to avoid log spam. */
  private readonly budgetBlockedWarned = new Set<string>();
  /** Tasks already logged as cooldown-blocked this run, to avoid log spam. */
  private readonly cooldownBlockedWarned = new Set<string>();
  /** Tasks already logged as capacity-blocked this run, to avoid log spam. */
  private readonly capacityBlockedWarned = new Set<string>();
  /** F16: tasks already logged as quota-blocked this run, to avoid log spam. */
  private readonly quotaBlockedWarned = new Set<string>();
  /** B28: tasks already logged as having a dangling assignedModel this run,
   *  to avoid log spam. */
  private readonly missingModelWarned = new Set<string>();
  /** F32: how many rate-limit wait-and-retries a task has used on its
   *  CURRENT model, so it falls back after RATE_LIMIT_RETRIES instead of
   *  waiting forever; cleared per-task in executeTask's finally. */
  private readonly rateLimitWaits = new Map<string, number>();
  /** How many times each task has been requeued for a merge-time conflict,
   *  so a perpetually-conflicting task can't loop forever. */
  private readonly mergeConflicts = new Map<string, number>();
  /** Task ids a human asked to stop. Checked at every stage boundary in
   *  executeTask so a Stop press can't be silently overtaken by gates
   *  finishing -> validator -> auto-merge; cleared in executeTask's finally. */
  private readonly stopRequested = new Set<string>();
  private currentTasks: Task[] = [];
  /** Set at the top of start()/runTask() — this Orchestrator instance only
   *  ever drives one project for its whole lifetime (EngineRunner builds a
   *  fresh one per project), so this is threaded onto every LogEvent/Run
   *  emitted from here instead of needing a project param everywhere. */
  private projectId = "";
  /** F3's "Pause (finish current tasks)" mode: stop dispatching new ready
   *  tasks but let whatever is already in activeTaskIds run to completion,
   *  instead of pause()'s usual immediate abort. Reset at the top of start(). */
  private draining = false;
  /** F41: true once this pass's "holding for approval" state has been
   *  logged, so a multi-second hold doesn't re-emit the same warn on every
   *  ~250ms poll. Reset the moment the pending approval clears. */
  private holdForApprovalWarned = false;
  /** B32: true once the run has fired its one onModelTrouble("quota_wait")
   *  notification for the CURRENT stall — every ready task's whole fallback
   *  chain is cooldown/quota-blocked (both time-bounded; they clear on
   *  their own) and nothing is active, so the loop is polling instead of
   *  winding down. Reset the moment dispatch succeeds again, so a later,
   *  separate stall still gets its own notification. */
  private quotaWaitNotified = false;
  /** B42: populated only after the assigned runner proves exact Figma access. */
  private readonly figmaCapabilityByTask = new Map<
    string,
    FigmaAuthorCapabilityContext
  >();
  /** Ordinary tasks are classified once; Figma tasks reconsult the server cache. */
  private readonly noFigmaReferenceTasks = new Set<string>();
  /** Capability-blocked executions need the same remote retry cleanup as failures. */
  private readonly figmaBlockedTasks = new Set<string>();

  constructor(private readonly deps: SchedulerDeps) {}

  /** Operational policy is live (B37). An adapter/model/effort is resolved
   * immediately before each call and then remains stable for that in-flight
   * invocation; later retries and merge decisions see the newest settings. */
  private settings(): Settings {
    return this.deps.getSettings?.() ?? this.deps.settings;
  }

  private nextEnabledFallback(
    task: Task,
    excluded: ReadonlySet<ModelId>,
  ): ModelId | undefined {
    const settings = this.settings();
    const chain = buildFallbackChain(
      task.assignedModel,
      task.difficulty,
      settings.routing,
    );
    for (const model of chain) {
      if (
        !excluded.has(model) &&
        settings.models.some((candidate) => candidate.id === model && candidate.enabled)
      ) {
        return model;
      }
    }
    return undefined;
  }

  private getModelActive(model: ModelId): number {
    if (this.deps.getModelActive) return this.deps.getModelActive(model);
    return this.localModelActiveCount.get(model) ?? 0;
  }

  private incModel(model: ModelId): void {
    if (this.deps.incModelActive) {
      this.deps.incModelActive(model);
      return;
    }
    this.localModelActiveCount.set(model, (this.localModelActiveCount.get(model) ?? 0) + 1);
  }

  private decModel(model: ModelId): void {
    if (this.deps.decModelActive) {
      this.deps.decModelActive(model);
      return;
    }
    this.localModelActiveCount.set(
      model,
      Math.max(0, (this.localModelActiveCount.get(model) ?? 0) - 1),
    );
  }

  private blockForFigmaCapability(
    task: Task,
    issue: FigmaCapabilityIssue,
    unstartedAttempt = false,
  ): void {
    if (unstartedAttempt) {
      task.attempts = Math.max(0, task.attempts - 1);
    }
    task.status = "blocked";
    task.statusReason = figmaCapabilityStatusReason(issue);
    if (task.branch || task.prNumber != null) {
      this.figmaBlockedTasks.add(task.id);
    }
    this.emit("warn", "engine", task.statusReason, task.id);
    this.deps.events.onTaskUpdated(task);
    this.deps.events.onFigmaCapabilityBlocked?.({
      taskId: task.id,
      taskTitle: task.title,
      issue,
    });
  }

  private async preflightFigma(
    project: Project,
    task: Task,
    model: ModelId,
    signal: AbortSignal,
    unstartedAttempt = false,
  ): Promise<boolean> {
    if (!this.deps.preflightFigma) return true;
    if (this.noFigmaReferenceTasks.has(task.id)) return true;
    const config = this.settings().models.find((candidate) => candidate.id === model);
    if (!config?.enabled) return true;

    try {
      const result = await this.deps.preflightFigma({
        project,
        task,
        model,
        signal,
      });
      if (
        signal.aborted &&
        (this.paused || this.stopRequested.has(task.id))
      ) {
        if (this.stopRequested.has(task.id)) {
          this.bailIfStopRequested(task);
        }
        return false;
      }
      if (!result.required) {
        this.figmaCapabilityByTask.delete(task.id);
        this.noFigmaReferenceTasks.add(task.id);
        return true;
      }
      if (result.issue) {
        this.blockForFigmaCapability(task, result.issue, unstartedAttempt);
        return false;
      }
      this.figmaCapabilityByTask.set(task.id, result.context);
      return true;
    } catch {
      if (
        signal.aborted &&
        (this.paused || this.stopRequested.has(task.id))
      ) {
        if (this.stopRequested.has(task.id)) {
          this.bailIfStopRequested(task);
        }
        return false;
      }
      const issue: FigmaCapabilityIssue = {
        stage: "author_preflight",
        code: "figma_unavailable",
        model,
        runner: config.runner,
        message: "The assigned runner could not complete the Figma access check.",
        actions: FIGMA_AUTHOR_RECOVERY_ACTIONS,
      };
      this.blockForFigmaCapability(task, issue, unstartedAttempt);
      return false;
    }
  }

  /** Move a task's concurrency accounting from its old model to a new one
   *  when fallback escalation switches the model mid-run. */
  private switchRunningModel(taskId: string, next: ModelId): void {
    const prev = this.runningModel.get(taskId);
    if (prev === next) return;
    if (prev) this.decModel(prev);
    this.incModel(next);
    this.runningModel.set(taskId, next);
  }

  /**
   * B32: when a ready task's assigned model is cooldown- or quota-blocked —
   * both are TIME-BOUNDED (a cooldown clears in minutes, a quota window
   * rolls over on its own) — walk the task's fallback chain for a model
   * that's dispatchable RIGHT NOW rather than just holding the task until
   * its own assigned model frees up. Every candidate (including the
   * assigned model itself, skipped as already known-blocked) is checked
   * against budget/cooldown/quota/capacity exactly like the normal dispatch
   * path — a fallback that's ALSO blocked is not a real fallback. Returns
   * `undefined` when nothing in the chain is currently dispatchable, so the
   * caller falls through to the existing hold-and-wait behavior. Budget is
   * deliberately excluded as a TRIGGER for this search (only consulted
   * per-candidate) — a spend cap is a human decision, and project/global
   * budgets block every model equally, so there's nothing to fall back to.
   */
  private resolveDispatchModel(task: Task): ModelId | undefined {
    const settings = this.settings();
    const chain = buildFallbackChain(
      task.assignedModel,
      task.difficulty,
      settings.routing,
    );
    for (const model of chain) {
      if (model === task.assignedModel) continue; // already known blocked
      const cfg = settings.models.find((m) => m.id === model);
      if (!cfg?.enabled) continue;
      if (this.deps.checkBudget?.(model)) continue;
      if (this.deps.checkModelCooldown?.(model)) continue;
      if (this.deps.checkModelQuota?.(model)) continue;
      if (this.getModelActive(model) >= cfg.maxConcurrent) continue;
      return model;
    }
    return undefined;
  }

  /**
   * Sync `currentTasks` (the same array `start()`'s loop iterates) against
   * the DB: append any task committed there that this orchestrator has never
   * seen (B9 — `plan/commit` while the loop is running previously wrote task
   * rows the loop's fixed array never grew to include), and adopt field
   * changes — including status — for any task NOT in `activeTaskIds`. Active
   * tasks are skipped: `executeTask` is concurrently mutating that exact Task
   * object in memory, and a DB read here can lag behind it, so overwriting
   * would clobber in-progress state (attempts, worktreePath, mid-run status
   * transitions) with a stale snapshot.
   */
  private reconcileTasks(): void {
    const fresh = this.deps.getTasks?.();
    if (!fresh) return;

    const freshById = new Map(fresh.map((t) => [t.id, t]));
    for (const f of fresh) {
      if (!this.currentTasks.some((t) => t.id === f.id)) {
        this.currentTasks.push(f);
        this.emit(
          "info",
          "engine",
          `Picked up new task added mid-run: ${f.title}`,
          f.id,
        );
      }
    }

    for (const t of this.currentTasks) {
      if (this.activeTaskIds.has(t.id)) continue;
      const f = freshById.get(t.id);
      if (!f) continue; // deleted from the DB since we last saw it — keep as-is
      Object.assign(t, f);
    }
  }

  readyTasks(tasks: Task[]): Task[] {
    const done = new Set(
      tasks.filter((t) => t.status === "done").map((t) => t.id),
    );
    const terminal = new Set(
      tasks
        .filter((t) => t.status === "done" || t.status === "failed")
        .map((t) => t.id),
    );
    return tasks.filter((t) => {
      if (t.status !== "backlog" && t.status !== "ready") return false;
      // A docs task documents whatever actually got built: it waits for
      // every dependency to reach a terminal state (done OR failed) and
      // then runs as long as at least one dependency landed. Requiring
      // all-done here would mean one flaky failed task = no documentation
      // at all, with the docs task stuck in backlog forever.
      if (t.role === "docs" && t.dependsOn.length > 0) {
        return (
          t.dependsOn.every((dep) => terminal.has(dep)) &&
          t.dependsOn.some((dep) => done.has(dep))
        );
      }
      return t.dependsOn.every((dep) => done.has(dep));
    });
  }

  async start(
    project: Project,
    tasks: Task[],
    opts: OrchestratorStartOptions = {},
  ): Promise<void> {
    this.paused = false;
    this.draining = false;
    this.projectId = project.id;
    this.currentTasks = tasks;
    this.budgetBlockedWarned.clear();
    this.cooldownBlockedWarned.clear();
    this.capacityBlockedWarned.clear();
    this.quotaBlockedWarned.clear();
    this.missingModelWarned.clear();
    this.holdForApprovalWarned = false;
    this.quotaWaitNotified = false;

    // Orphan recovery: this Orchestrator instance starts with empty
    // activeTaskIds, so any task already "in_progress" or "in_review" was
    // left mid-run by a previous process (crash, restart, deploy) — nothing
    // is actually working on it. Requeue it as backlog so the scheduler
    // retries it instead of silently stalling forever (it would never appear
    // in readyTasks() and would permanently block every task that depends on
    // it) — UNLESS (B30) it was only sitting at a requestApproval() await:
    // findResumableDecision recognizes that case (in_review, an open PR, and
    // a MergeDecision already persisted for this attempt) and re-arms the
    // pending decision instead, so a restart during an approval doesn't
    // throw away a task that already passed gates + validation. Kicked off
    // fire-and-forget (not awaited here) exactly like a normal dispatch —
    // it can wait indefinitely on a human, and siblings must not block on
    // it — with the task id tracked in activeTaskIds purely so this loop's
    // own "nothing left to do" check below doesn't fire while it's pending.
    for (const task of tasks) {
      if (task.status === "in_progress" || task.status === "in_review") {
        if (task.status === "in_review") {
          const decision = this.findResumableDecision(task);
          if (decision) {
            this.emit(
              "info",
              "engine",
              `Restart recovery: re-requesting the pending decision instead of re-running (${task.title})`,
              task.id,
            );
            this.activeTaskIds.add(task.id);
            const recovery = this.recoverPendingApproval(project, task, decision);
            this.activeTaskPromises.set(task.id, recovery);
            const clearRecovery = () => {
              this.activeTaskIds.delete(task.id);
              this.activeTaskPromises.delete(task.id);
            };
            void recovery.then(clearRecovery, clearRecovery);
            continue;
          }
        }
        this.emit(
          "warn",
          "engine",
          `Recovering orphaned task (was ${task.status} with no active run): ${task.title}`,
          task.id,
        );
        task.status = "backlog";
        this.deps.events.onTaskUpdated(task);
      }
    }

    this.emit("info", "engine", "Orchestrator starting", "");

    while (!this.paused) {
      this.reconcileTasks();

      // F41: same drain-not-abort semantics as `draining` above, but
      // driven by an unresolved approval instead of a human pause — only
      // consulted when the project opted in, and re-checked every pass so
      // dispatch resumes the moment the approval clears (no restart needed).
      const pendingApproval = this.settings().holdWhileAwaitingApproval
        ? this.deps.getPendingApproval?.(this.projectId)
        : undefined;
      if (pendingApproval) {
        if (!this.holdForApprovalWarned) {
          this.holdForApprovalWarned = true;
          this.emit(
            "warn",
            "engine",
            `Holding new dispatch — pending approval: "${pendingApproval.title}"`,
            "",
          );
        }
      } else {
        this.holdForApprovalWarned = false;
      }

      // Draining: never pick up new work, but leave activeTaskIds alone so
      // whatever's already running finishes normally. Forcing `ready` empty
      // means `dispatched` stays 0 every pass below, which the existing
      // "nothing dispatched" branches already turn into a 250ms poll while
      // active tasks remain, then a break once the last one finishes.
      const ready = this.draining || pendingApproval
        ? []
        : this.readyTasks(tasks)
            .filter((task) => opts.shouldDispatch?.(task) ?? true)
            .sort((a, b) => {
              // Manual requests are priority work even after a manual runtime
              // is promoted to autonomous mode. Oldest request wins; the sort
              // is stable for ordinary autonomous tasks.
              if (a.dispatchRequestedAt && b.dispatchRequestedAt) {
                return a.dispatchRequestedAt.localeCompare(b.dispatchRequestedAt);
              }
              if (a.dispatchRequestedAt) return -1;
              if (b.dispatchRequestedAt) return 1;
              return 0;
            });

      // A pendingApproval hold must never look like "nothing left to do" —
      // it can be genuinely true even with activeTaskIds empty (e.g. the
      // task that raised it was dispatched manually, under a different
      // Orchestrator instance sharing this same project id) — the loop
      // should keep polling, not exit, until the approval clears.
      if (ready.length === 0 && this.activeTaskIds.size === 0 && !pendingApproval) {
        break;
      }

      // Scope paths of all currently running tasks, for overlap detection.
      // Mutable: appended to as each task is dispatched below so two
      // overlapping tasks considered in the SAME pass over `ready` can't
      // both slip through — the second must see the first's scope even
      // though this array started the pass before either was active.
      // Keep each task's scope array separate. Flattening loses the
      // distinction between "there are no active tasks" and "an active task
      // has an empty (unrestricted) scope" — B34 deliberately treats the
      // latter as overlapping everything.
      const activeTaskScopes = [...this.activeTaskIds].map(
        (id) => this.currentTasks.find((t) => t.id === id)?.scopePaths ?? [],
      );

      let dispatched = 0;
      // F12: true if a ready task was held back purely by the shared
      // per-model concurrency cap (not budget/cooldown/scope). Unlike a
      // budget or cooldown block — which only clears via an external action
      // (raising a cap, waiting out a timer) and is fine to wind the run down
      // for — a concurrency block can clear the moment ANOTHER project's
      // Orchestrator finishes its own dispatch of the same model, entirely
      // outside this instance's `activeTaskIds`. Without this, the "nothing
      // dispatched and nothing of mine is active" break below would end the
      // run right when the other project's task is about to free up the slot.
      let blockedByCapacity = false;
      // B32: true if a ready task (and its ENTIRE fallback chain) was held
      // back purely by TIME-BOUNDED blocks — cooldown or quota, both of
      // which clear on their own — with no dispatchable fallback found.
      // Like blockedByCapacity, this keeps the loop polling instead of
      // winding the run down: a run that hits a subscription's usage window
      // should wait the few minutes/hours for it to clear, not silently end
      // for the night. `timeBoundedExample` names one such task/model so the
      // one-time onModelTrouble notification below has something concrete
      // to report.
      let blockedByTimeBounded = false;
      let timeBoundedExample: { task: Task; model: ModelId; detail: string } | undefined;
      for (const task of ready) {
        if (this.paused) break;
        if (this.activeTaskIds.has(task.id)) continue;

        // Scope-overlap serialization: hold this task back if any active task
        // writes to the same files. It will be dispatched once the conflicting
        // task merges and the loop iterates again.
        if (activeTaskScopes.some((scope) => scopesOverlap(task.scopePaths, scope))) {
          this.emit(
            "info",
            "engine",
            `Holding "${task.title}" — scope overlaps with a running task`,
            task.id,
          );
          continue;
        }

        const cfg = this.settings().models.find(
          (m) => m.id === task.assignedModel,
        );
        if (!cfg || !cfg.enabled) {
          // B28: don't just hold this forever in "ready" — requeue it to
          // backlog (same shape as the budget/cooldown/quota guards below)
          // once, so the Board reflects that it needs a human to reassign
          // the model rather than that it's about to run. Both the log and
          // the status/broadcast are gated on the warned-set so a task
          // that's already backlogged for this reason doesn't re-emit or
          // re-broadcast on every ~250ms poll.
          if (!this.missingModelWarned.has(task.id)) {
            this.missingModelWarned.add(task.id);
            this.emit(
              "error",
              "engine",
              !cfg
                ? `Assigned model "${task.assignedModel}" no longer configured — reassign it`
                : `Assigned model "${task.assignedModel}" is disabled — reassign it or enable it`,
              task.id,
            );
            task.status = "backlog";
            this.deps.events.onTaskUpdated(task);
          }
          continue;
        }
        this.missingModelWarned.delete(task.id);

        // Budget guard: refuse to dispatch new work once a cap is hit. Once
        // every ready task is budget-blocked and nothing is in flight, the loop
        // below winds the run down (dispatched === 0 && no active tasks → break).
        const budgetMsg = this.deps.checkBudget?.(task.assignedModel) ?? null;
        if (budgetMsg) {
          if (!this.budgetBlockedWarned.has(task.id)) {
            this.budgetBlockedWarned.add(task.id);
            this.emit(
              "error",
              "engine",
              `Budget cap reached, not dispatching: ${budgetMsg}`,
              task.id,
            );
          }
          continue;
        }
        this.budgetBlockedWarned.delete(task.id);

        // F6/F16: a task whose assigned model is cooling down (rate-limit
        // shaped failure) or has hit its configured subscription quota is
        // held, not failed — but B32: unlike the budget guard above, both
        // of these are TIME-BOUNDED (a cooldown clears in minutes, a quota
        // window rolls over on its own), so before just holding the task,
        // try the rest of its fallback chain for a model that's
        // dispatchable RIGHT NOW.
        const cooldownMsg = this.deps.checkModelCooldown?.(task.assignedModel) ?? null;
        const quotaMsg = this.deps.checkModelQuota?.(task.assignedModel) ?? null;
        let dispatchModel = task.assignedModel;

        if (cooldownMsg || quotaMsg) {
          const fallback = this.resolveDispatchModel(task);
          if (fallback) {
            dispatchModel = fallback;
            const reason = cooldownMsg ?? quotaMsg!;
            this.emit(
              "warn",
              "engine",
              `Assigned model "${task.assignedModel}" blocked (${reason}) — dispatching on fallback ${fallback}`,
              task.id,
            );
            this.notifyModelTrouble(
              task,
              fallback,
              "fallback",
              `Switched to fallback model at dispatch time (${reason})`,
            );
          } else {
            blockedByTimeBounded = true;
            if (cooldownMsg && !this.cooldownBlockedWarned.has(task.id)) {
              this.cooldownBlockedWarned.add(task.id);
              this.emit(
                "warn",
                "engine",
                `Model cooling down, not dispatching: ${cooldownMsg}`,
                task.id,
              );
            }
            if (quotaMsg && !this.quotaBlockedWarned.has(task.id)) {
              this.quotaBlockedWarned.add(task.id);
              this.emit(
                "warn",
                "engine",
                `Model quota reached, not dispatching: ${quotaMsg}`,
                task.id,
              );
            }
            timeBoundedExample ??= { task, model: task.assignedModel, detail: cooldownMsg ?? quotaMsg! };
            continue;
          }
        }
        if (!cooldownMsg) this.cooldownBlockedWarned.delete(task.id);
        if (!quotaMsg) this.quotaBlockedWarned.delete(task.id);

        // The shared per-model concurrency cap only needs checking here for
        // the ORIGINAL assigned model — a fallback candidate chosen by
        // resolveDispatchModel above has already passed this same check
        // against its own maxConcurrent.
        if (dispatchModel === task.assignedModel) {
          const active = this.getModelActive(task.assignedModel);
          if (active >= cfg.maxConcurrent) {
            blockedByCapacity = true;
            if (!this.capacityBlockedWarned.has(task.id)) {
              this.capacityBlockedWarned.add(task.id);
              this.emit(
                "warn",
                "engine",
                `Model at capacity (in use by another task or project), holding: ${task.assignedModel}`,
                task.id,
              );
            }
            continue;
          }
          this.capacityBlockedWarned.delete(task.id);
        }

        this.incModel(dispatchModel);
        this.runningModel.set(task.id, dispatchModel);
        this.activeTaskIds.add(task.id);
        activeTaskScopes.push(task.scopePaths);
        dispatched++;

        // The persisted request is queue state, not run state. Clear it only
        // now that all dependency/scope/cap/budget guards have passed and the
        // task is genuinely being dispatched.
        task.dispatchRequestedAt = undefined;
        const execution = this.executeTask(project, task, dispatchModel);
        this.activeTaskPromises.set(task.id, execution);
        const clearExecution = () => {
          // Decrement whichever model the task was last running on (fallback
          // escalation may have switched it further from dispatchModel).
          const ran = this.runningModel.get(task.id) ?? dispatchModel;
          this.decModel(ran);
          this.runningModel.delete(task.id);
          this.activeTaskIds.delete(task.id);
          this.activeTaskPromises.delete(task.id);
        };
        void execution.then(clearExecution, clearExecution);
      }

      // B32: fire the one-time "run is waiting on a model's cooldown/quota
      // window" notification exactly when the run would otherwise be about
      // to wind down for this reason alone (nothing active, no capacity/
      // approval hold also in play) — not on every ~250ms poll while it
      // keeps waiting.
      if (
        blockedByTimeBounded &&
        dispatched === 0 &&
        this.activeTaskIds.size === 0 &&
        !blockedByCapacity &&
        !pendingApproval &&
        !this.quotaWaitNotified &&
        timeBoundedExample
      ) {
        this.quotaWaitNotified = true;
        this.notifyModelTrouble(
          timeBoundedExample.task,
          timeBoundedExample.model,
          "quota_wait",
          `Run is waiting for ${timeBoundedExample.model}'s cooldown/quota window — ${timeBoundedExample.detail}`,
        );
      }
      if (!blockedByTimeBounded) this.quotaWaitNotified = false;

      if (
        dispatched === 0 &&
        (this.activeTaskIds.size > 0 ||
          blockedByCapacity ||
          blockedByTimeBounded ||
          pendingApproval)
      ) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }

      if (dispatched === 0 && this.activeTaskIds.size === 0) {
        break;
      }

      await new Promise((r) => setImmediate(r));
    }

    // Hard pause changes the loop condition immediately, but task pipelines
    // can still be unwinding. Do not let the owning runtime settle until every
    // promise present at this boundary has actually finished.
    if (this.activeTaskPromises.size > 0) {
      await Promise.allSettled([...this.activeTaskPromises.values()]);
    }

    this.emit("info", "engine", "Orchestrator finished", "");
  }

  async pause(
    _project: Project,
    opts: { drain?: boolean } = {},
  ): Promise<void> {
    if (opts.drain) {
      // Let whatever's already running finish: don't touch paused, abort
      // controllers, or active tasks' status — just stop the dispatch loop
      // from picking up new work (see the `ready` computation in start()).
      // The loop keeps iterating and start()'s promise doesn't resolve until
      // activeTaskIds actually empties out.
      this.draining = true;
      this.emit(
        "info",
        "engine",
        "Draining — finishing active tasks, no new work will be dispatched",
        "",
      );
      return;
    }

    this.paused = true;

    for (const [, ctrl] of this.taskAbortControllers) {
      try {
        ctrl.abort();
      } catch {
        /* ignore */
      }
    }
    for (const task of this.currentTasks) {
      if (
        (task.status === "in_progress" || task.status === "in_review") &&
        this.activeTaskIds.has(task.id)
      ) {
        task.status = "backlog";
        this.deps.events.onTaskUpdated(task);
      }
    }

    this.emit("info", "engine", "Orchestrator paused", "");
  }

  /**
   * Request that one active task stop as soon as possible: aborts its live
   * agent process if the author phase is currently running (the idle/max-run
   * timers already wire SIGTERM->SIGKILL through AbortController), and marks
   * it so executeTask bails at the next stage boundary — after the author
   * run, after gates, before the validator, before merge — instead of
   * finishing the pipeline and auto-merging behind the user's back. Returns
   * false if this task isn't active in this orchestrator, so the caller can
   * fall back to a DB-only stop (nothing was actually running).
   */
  stopTask(taskId: string): boolean {
    if (!this.activeTaskIds.has(taskId)) return false;
    this.stopRequested.add(taskId);
    this.taskAbortControllers.get(taskId)?.abort();
    return true;
  }

  /** Checked at each stage boundary in executeTask. If a stop was requested
   *  for this task, mark it blocked and return true so the caller returns
   *  immediately. */
  private bailIfStopRequested(task: Task): boolean {
    if (!this.stopRequested.has(task.id)) return false;
    task.status = "blocked";
    task.statusReason = "Stopped by user";
    this.emit("warn", "engine", "Stopped by user", task.id);
    this.deps.events.onTaskUpdated(task);
    return true;
  }

  /** F32: tiny wrapper around the optional onModelTrouble hook, so every
   *  call site is one line instead of a repeated `this.deps.events
   *  .onModelTrouble?.({ taskId: task.id, taskTitle: task.title, ... })`. */
  private notifyModelTrouble(
    task: Task,
    model: ModelId,
    event: "rate_limit_wait" | "fallback" | "exhausted" | "quota_wait",
    detail: string,
  ): void {
    this.deps.events.onModelTrouble?.({
      taskId: task.id,
      taskTitle: task.title,
      model,
      event,
      detail,
    });
  }

  /**
   * F32: wait out a rate limit in short slices, checking `paused`/
   * `stopRequested` each slice so a Pause or Stop press mid-wait bails
   * promptly instead of sleeping the whole `waitMs` regardless (same
   * reasoning as F15's post-wait bail check). Returns `"aborted"` the
   * moment either fires; the caller distinguishes Stop (bailIfStopRequested)
   * from Pause (falls through to the existing `return;` pattern).
   */
  private async waitOutRateLimit(
    task: Task,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<"done" | "aborted"> {
    const SLICE_MS = 5000;
    let elapsed = 0;
    while (elapsed < waitMs) {
      if (this.paused || this.stopRequested.has(task.id)) return "aborted";
      const slice = Math.min(SLICE_MS, waitMs - elapsed);
      try {
        await abortableDelay(slice, signal);
      } catch {
        return "aborted";
      }
      elapsed += slice;
    }
    return this.paused || this.stopRequested.has(task.id) ? "aborted" : "done";
  }

  /** Run a single task through the full pipeline (manual dispatch). */
  async runTask(project: Project, task: Task): Promise<void> {
    this.paused = false;
    this.projectId = project.id;
    // start()'s loop tracks this in activeTaskIds itself; runTask bypasses
    // that loop entirely, so stopTask()'s guard would never see this task as
    // stoppable without tracking it here too.
    this.activeTaskIds.add(task.id);
    // B19: a manual dispatch must not be BLOCKED by the shared per-model cap
    // (an explicit human action shouldn't silently queue) but it must be
    // VISIBLE to it — otherwise the autonomous loop happily piles
    // maxConcurrent more copies of the same model on top of this one. Count
    // it here, same bookkeeping as start()'s dispatch (incModel + track which
    // model is actually running for fallback-escalation accounting), just
    // without the capacity check that start() applies before dispatching.
    this.incModel(task.assignedModel);
    this.runningModel.set(task.id, task.assignedModel);
    const execution = this.executeTask(project, task);
    this.activeTaskPromises.set(task.id, execution);
    try {
      await execution;
    } finally {
      // Mirrors start()'s per-task dispatch-finally exactly: decrement
      // whichever model the task was last running on, since fallback
      // escalation may have switched it away from task.assignedModel.
      const ran = this.runningModel.get(task.id) ?? task.assignedModel;
      this.decModel(ran);
      this.runningModel.delete(task.id);
      this.activeTaskIds.delete(task.id);
      this.activeTaskPromises.delete(task.id);
    }
  }

  private async executeTask(
    project: Project,
    task: Task,
    // B32: dispatch-time fallback (start()'s dispatch loop already found
    // this model dispatchable when task.assignedModel was cooldown/quota-
    // blocked) — the in-run escalation chain below continues from wherever
    // this model sits in the chain instead of always starting at index 0.
    // Defaults to task.assignedModel (today's behavior) for every other
    // caller (runTask's manual dispatch, and the normal no-block path).
    startModel: ModelId = task.assignedModel,
  ): Promise<void> {
    const taskController = new AbortController();
    this.taskAbortControllers.set(task.id, taskController);
    const signal = taskController.signal;
    this.emit("info", "engine", `Starting: ${task.title}`, task.id);

    task.status = "in_progress";
    // A requeued/retried task carries its previous terminal outcome here —
    // clear it so intermediate updates don't keep re-persisting a stale one.
    task.statusReason = undefined;
    this.deps.events.onTaskUpdated(task);

    // Seed which earlier models dispatch already skipped. Every later
    // fallback choice rebuilds the chain from live settings (B37).
    const initialFallbackChain = buildFallbackChain(
      task.assignedModel,
      task.difficulty,
      this.settings().routing,
    );
    const startIndex = Math.max(0, initialFallbackChain.indexOf(startModel));
    const exhaustedModels = new Set<ModelId>(initialFallbackChain.slice(0, startIndex));
    let currentModel = startModel;

    try {
      // B42: this first proof is deliberately before worktree creation and
      // before the attempt loop mutates `attempts`.
      if (!(await this.preflightFigma(project, task, currentModel, signal))) {
        return;
      }

      const { branch, path } = await this.deps.worktrees.create(
        project,
        task,
        signal,
      );
      task.branch = branch;
      task.worktreePath = path;
      this.deps.events.onTaskUpdated(task);

      let fixInstructions: string | undefined;
      let finalGate: GateResult | undefined;

      for (
        task.attempts = 1;
        task.attempts <= task.maxAttempts;
        task.attempts++
      ) {
        if (this.paused) return;
        if (this.bailIfStopRequested(task)) return;

        // Every new attempt starts a fresh author run — reset from
        // "in_review" (set below, right before gates) back to
        // "in_progress" so the board reflects reality instead of leaving a
        // retry looking like a review is still in progress. A no-op on the
        // very first attempt (already "in_progress" from before this loop).
        task.status = "in_progress";
        this.deps.events.onTaskUpdated(task);

        // B28: currentModel (task.assignedModel on the first attempt, a
        // fallback-chain entry after an escalation) may no longer be
        // configured — removed or renamed out from under this task since it
        // was created/assigned. Requeue-to-backlog here, same shape as the
        // budget/quota checks below, instead of letting runAuthor's
        // adapterFor throw surface as a cryptic "Fatal:" failure. Manual
        // dispatch (runTask) has no earlier dispatch-time guard for this at
        // all, so this is the only check standing between a dangling
        // reference and that crash on that path.
        const currentConfig = this.settings().models.find((m) => m.id === currentModel);
        if (!currentConfig) {
          this.emit(
            "error",
            "engine",
            `Assigned model "${currentModel}" no longer configured — reassign it`,
            task.id,
          );
          task.status = "backlog";
          this.deps.events.onTaskUpdated(task);
          return;
        }
        if (!currentConfig.enabled) {
          exhaustedModels.add(currentModel);
          const fallback = this.nextEnabledFallback(task, exhaustedModels);
          if (fallback) {
            currentModel = fallback;
            this.switchRunningModel(task.id, currentModel);
            this.emit(
              "warn",
              "engine",
              `Model disabled before the next attempt — switching to fallback ${currentModel}`,
              task.id,
            );
            this.notifyModelTrouble(
              task,
              currentModel,
              "fallback",
              "Previous model was disabled before a new attempt",
            );
          } else {
            this.emit(
              "error",
              "engine",
              `Model "${currentModel}" is disabled and no enabled fallback remains — reassign it`,
              task.id,
            );
            task.status = "backlog";
            this.deps.events.onTaskUpdated(task);
            return;
          }
        }

        // Stop spending mid-task if a budget cap has since been hit. Checked
        // against currentModel (which may be a fallback by this point), not
        // task.assignedModel — the two can differ once escalation kicks in,
        // and budget must gate whichever model is about to actually run.
        const budgetMsg = this.deps.checkBudget?.(currentModel) ?? null;
        if (budgetMsg) {
          this.emit(
            "error",
            "engine",
            `Budget cap reached, stopping task: ${budgetMsg}`,
            task.id,
          );
          task.status = "backlog";
          this.deps.events.onTaskUpdated(task);
          return;
        }

        // F16: same requeue-not-fail treatment as the budget check above,
        // for whichever model is about to actually run this attempt.
        const quotaMsg = this.deps.checkModelQuota?.(currentModel) ?? null;
        if (quotaMsg) {
          this.emit(
            "warn",
            "engine",
            `Model quota reached, requeuing task: ${quotaMsg}`,
            task.id,
          );
          task.status = "backlog";
          this.deps.events.onTaskUpdated(task);
          return;
        }

        // The initial model hits the per-runtime positive cache populated
        // above. A later fallback model must prove its own access before its
        // author attempt begins; if it cannot, do not count that attempt.
        if (
          !(await this.preflightFigma(
            project,
            task,
            currentModel,
            signal,
            true,
          ))
        ) {
          return;
        }

        const attemptEffort =
          this.settings().models.find((model) => model.id === currentModel)?.effort ??
          "default";
        this.emit(
          "info",
          "engine",
          `Attempt ${task.attempts}/${task.maxAttempts} [model: ${currentModel}] [effort: ${attemptEffort}]`,
          task.id,
        );

        const authorResult = await this.runAuthor(
          project,
          task,
          fixInstructions,
          currentModel,
          signal,
        );
        if (this.bailIfStopRequested(task)) return;
        if (authorResult === null) return; // paused

        if (!authorResult.ok) {
          const figmaContext = this.figmaCapabilityByTask.get(task.id);
          if (
            figmaContext &&
            (authorResult.summary ?? "").includes(
              FIGMA_CAPABILITY_UNAVAILABLE_MARKER,
            )
          ) {
            this.blockForFigmaCapability(task, {
              stage: "author",
              code: "figma_unavailable",
              model: currentModel,
              runner: figmaContext.runner,
              message:
                "Figma access disappeared during the author run; no implementation result was accepted.",
              actions: FIGMA_AUTHOR_RECOVERY_ACTIONS,
              canonicalUrl: figmaContext.canonicalUrl,
              nodeId: figmaContext.nodeId,
            });
            return;
          }
          this.emit(
            "error",
            "agent",
            `Author run failed: ${authorResult.exitReason}`,
            task.id,
          );

          // F32: a rate limit is often a five-minute problem, not a
          // this-model-can't-do-it problem — wait and retry the SAME model a
          // couple of times before burning a fallback's slot on it. Only
          // rate_limited gets this treatment; stuck/error still escalate
          // immediately below (a hung or crashing model won't be fixed by
          // waiting).
          if (authorResult.exitReason === "rate_limited") {
            const waits = this.rateLimitWaits.get(task.id) ?? 0;
            if (waits < RATE_LIMIT_RETRIES) {
              this.rateLimitWaits.set(task.id, waits + 1);
              const waitMs = this.deps.rateLimitWaitMs ?? RATE_LIMIT_WAIT_MS;
              this.emit(
                "warn",
                "engine",
                `Rate-limited — waiting ${Math.round(waitMs / 60_000)}m before retrying ` +
                  `${currentModel} (${waits + 1}/${RATE_LIMIT_RETRIES})`,
                task.id,
              );
              if (waits === 0) {
                this.notifyModelTrouble(
                  task,
                  currentModel,
                  "rate_limit_wait",
                  `Rate-limited — waiting before retrying the same model`,
                );
              }
              // The wait/retry must not consume a real attempt — the for
              // loop's own `attempts++` on `continue` below is compensated
              // by this bump.
              task.maxAttempts++;
              const outcome = await this.waitOutRateLimit(task, waitMs, signal);
              if (outcome === "aborted") {
                if (this.bailIfStopRequested(task)) return;
                return; // paused
              }
              continue;
            }
          }

          // Immediately escalate to the next fallback model on adapter/stuck
          // errors, or once rate-limit wait-and-retries on the same model
          // are exhausted.
          exhaustedModels.add(currentModel);
          const fallback = this.nextEnabledFallback(task, exhaustedModels);
          if (fallback) {
            currentModel = fallback;
            this.switchRunningModel(task.id, currentModel);
            this.rateLimitWaits.delete(task.id);
            if (task.attempts >= task.maxAttempts) task.maxAttempts++;
            this.emit(
              "warn",
              "engine",
              `Switching to fallback model: ${currentModel}`,
              task.id,
            );
            this.notifyModelTrouble(
              task,
              currentModel,
              "fallback",
              `Switched to fallback model after ${authorResult.exitReason}`,
            );
            continue;
          }
          this.notifyModelTrouble(
            task,
            currentModel,
            "exhausted",
            `No fallback model left after ${authorResult.exitReason}`,
          );
          task.status = "failed";
          task.statusReason = `Author run kept failing (${authorResult.exitReason}) and no fallback model was left (last tried: ${currentModel})`;
          this.deps.events.onTaskUpdated(task);
          return;
        }

        await this.deps.git.commitAll(
          path,
          `feat: ${task.title} (attempt ${task.attempts})`,
          signal,
        );

        // Guard: if the author produced no committed changes, there's nothing to
        // open a PR for. `gh pr create` would fail with a cryptic "No commits
        // between main and <branch>". This can mean the agent wrote outside its
        // worktree, but just as often it means a weaker/cheaper model ran out
        // of steps on a large task (e.g. a scaffold task that needs a dozen
        // files) and exited cleanly having only run `npm install`. Treat it
        // like any other recoverable failure — retry, then escalate the
        // fallback chain — rather than failing outright on the first miss.
        const changed = await this.deps.worktrees.changedFiles(project, task);
        if (changed.length === 0) {
          // B33: diagnose WHERE the agent actually wrote, instead of just
          // reporting that the worktree is empty. If the primary clone is
          // dirty, that's a strong signal the agent wrote there instead of
          // its own worktree — B38 creates no legitimate primary-manifest
          // dirt —
          // name it explicitly rather than leaving "ran out of steps" as
          // the only explanation. Report-only: never resets the primary
          // clone here (syncPrimary elsewhere self-heals; racing it would
          // be worse than leaving the dirt for the next diagnosis).
          const primaryDirty = await this.deps.worktrees.primaryDirtyFiles(project);
          const wroteToWrongPlace = primaryDirty.length > 0;
          this.emit(
            "error",
            "engine",
            wroteToWrongPlace
              ? `Author produced no changes in the worktree (${path}) — but the agent ` +
                `appears to have written into the primary clone at ${project.localPath} instead: ` +
                `${primaryDirty.join(", ")}.`
              : `Author produced no changes in the worktree (${path}). ` +
                `Nothing to commit/PR — check that the agent wrote into the worktree, not elsewhere.`,
            task.id,
          );
          fixInstructions = wroteToWrongPlace
            ? `Your previous attempt wrote to the WRONG directory — changes landed in the ` +
              `primary clone (${primaryDirty.join(", ")}) instead of your actual working ` +
              `directory. You are always started in a dedicated git worktree for this task; ` +
              "never `cd` out of it or write with an absolute path elsewhere. This attempt " +
              "must make its changes in the current working directory — verify with " +
              "`git status` before finishing."
            : "Your previous attempt made no file changes (likely ran out of " +
              "steps before writing anything, or wrote outside the worktree). " +
              "This attempt must actually create/modify the files this task " +
              "requires — verify with `git status` before finishing.";

          if (task.attempts < task.maxAttempts) continue;

          exhaustedModels.add(currentModel);
          const fallback = this.nextEnabledFallback(task, exhaustedModels);
          if (fallback) {
            currentModel = fallback;
            this.switchRunningModel(task.id, currentModel);
            this.rateLimitWaits.delete(task.id);
            task.maxAttempts++;
            this.emit(
              "warn",
              "engine",
              `No changes produced, switching to fallback model: ${currentModel}`,
              task.id,
            );
            this.notifyModelTrouble(
              task,
              currentModel,
              "fallback",
              "Switched to fallback model after no changes were produced",
            );
            continue;
          }

          this.notifyModelTrouble(
            task,
            currentModel,
            "exhausted",
            "No fallback model left after no changes were produced",
          );
          task.status = "failed";
          task.statusReason = wroteToWrongPlace
            ? `Every attempt wrote to the primary clone instead of its worktree (${primaryDirty.join(", ")}) — no fallback model left (last tried: ${currentModel})`
            : `Every attempt produced no file changes (models ran out of steps or wrote outside the worktree; last tried: ${currentModel})`;
          this.deps.events.onTaskUpdated(task);
          return;
        }

        await this.deps.git.push(path, branch, signal);

        // Open the PR the first time a push actually succeeds — not
        // hardcoded to attempt 1. An author-run failure (stuck detection,
        // adapter error) can consume attempt 1 before ever reaching this
        // line, e.g. via fallback escalation; gating on attempts === 1 then
        // skips openPr() forever and task.prNumber stays undefined, which
        // later crashes the merge step with `gh pr merge undefined`.
        if (task.prNumber == null) {
          task.prNumber = await this.deps.git.openPr(project, task, signal);
          this.deps.events.onTaskUpdated(task);
        }

        // Gates + validator take minutes; without this the board shows
        // "In Progress" throughout review with no way to tell dispatch time
        // from review time. Reset back to "in_progress" at the top of the
        // next attempt if this one gets retried.
        task.status = "in_review";
        this.deps.events.onTaskUpdated(task);

        const gateResult = await this.deps.gates.run(project, task, signal);
        // Defense in depth: GateRunner restores after every individual gate
        // so later gates cannot consume generated source. This final reset is
        // the stage boundary guarantee before retry, validator, docs, or merge.
        const gateCleanup = await this.deps.worktrees.restoreToHead(task);
        if (!gateCleanup.ok) {
          gateResult.tests = false;
          gateResult.details.tests =
            `${gateResult.details.tests ?? ""}\nCould not restore the disposable worktree ` +
            `after gates: ${gateCleanup.error ?? "unknown git error"}`;
        }
        finalGate = gateResult;
        if (this.bailIfStopRequested(task)) return;

        // inScope is deliberately NOT a hard gate. Wiring a new file into an
        // entry point (e.g. adding <script src="js/game.js"> to index.html) is
        // legitimate work that often falls outside a task's narrow scopePaths,
        // and hard-failing it stalls the whole run. Out-of-scope edits are
        // instead handled as a risky-change flag in canAutoMerge: auto-merged
        // under fully_autonomous, sent for approval under hard_gate_flag_risky.
        // The truly objective checks below stay hard gates.
        const gatesPassed =
          gateResult.typecheck &&
          gateResult.lint &&
          gateResult.build &&
          gateResult.tests &&
          gateResult.noConflicts;
        if (!gateResult.inScope) {
          this.emit(
            "info",
            "engine",
            "Task modified files outside its declared scope — allowed by merge policy, flagged for review.",
            task.id,
          );
        }

        if (!gatesPassed) {
          fixInstructions = this.buildGateFixInstructions(gateResult);
          this.emit(
            "warn",
            "gate",
            `Gates failed:\n${fixInstructions}`,
            task.id,
          );

          if (task.attempts < task.maxAttempts) continue;

          // All attempts on this model exhausted — try the next fallback model
          // before giving up entirely.
          exhaustedModels.add(currentModel);
          const fallback = this.nextEnabledFallback(task, exhaustedModels);
          if (fallback) {
            currentModel = fallback;
            this.switchRunningModel(task.id, currentModel);
            this.rateLimitWaits.delete(task.id);
            task.maxAttempts++;
            this.emit(
              "warn",
              "engine",
              `Gates still failing, switching to fallback model: ${currentModel}`,
              task.id,
            );
            this.notifyModelTrouble(
              task,
              currentModel,
              "fallback",
              "Switched to fallback model after gates kept failing",
            );
            continue;
          }

          this.notifyModelTrouble(
            task,
            currentModel,
            "exhausted",
            "No fallback model left after gates kept failing",
          );
          task.status = "failed";
          task.statusReason = `Gates kept failing after ${task.attempts} attempts (${failedGateNames(gateResult).join(", ")}) — no fallback model left`;
          this.deps.events.onTaskUpdated(task);
          return;
        }

        if (this.bailIfStopRequested(task)) return;

        // Announce the review — it spawns a separate reviewer model and can run
        // for minutes; without this the board goes silent and looks frozen.
        const validatorId =
          this.settings().routing.validatorByDifficulty[task.difficulty];
        const validatorEffort =
          this.settings().models.find((model) => model.id === validatorId)?.effort ??
          "default";
        this.emit(
          "info",
          "validator",
          `Reviewing changes with ${validatorId} [effort: ${validatorEffort}] (this can take a few minutes)…`,
          task.id,
        );

        let decision: MergeDecision;
        try {
          decision = await this.deps.validator.review(
            project,
            task,
            gateResult,
            currentModel,
            (line) =>
              this.deps.events.onLog({
                projectId: this.projectId,
                runId: `run-${task.id}-${task.attempts}`,
                taskId: task.id,
                ts: new Date().toISOString(),
                level: "debug",
                source: "validator",
                message: line,
              }),
            signal,
          );
        } catch (err) {
          if (!(err instanceof SelfReviewError)) throw err;
          // Routing misconfiguration (author/validator collide for this
          // difficulty, or escalation walked into the validator's model) —
          // recoverable by escalating same as a gate failure, not fatal.
          this.emit("warn", "validator", err.message, task.id);
          exhaustedModels.add(currentModel);
          const fallback = this.nextEnabledFallback(task, exhaustedModels);
          if (fallback) {
            currentModel = fallback;
            this.switchRunningModel(task.id, currentModel);
            this.rateLimitWaits.delete(task.id);
            task.maxAttempts++;
            this.emit(
              "warn",
              "engine",
              `Switching to fallback model: ${currentModel}`,
              task.id,
            );
            this.notifyModelTrouble(
              task,
              currentModel,
              "fallback",
              "Switched to fallback model after a validator/author routing collision",
            );
            continue;
          }
          this.emit(
            "error",
            "engine",
            "No remaining fallback model avoids the validator collision — fix routing in Settings (byDifficulty/byRole vs validatorByDifficulty).",
            task.id,
          );
          this.notifyModelTrouble(
            task,
            currentModel,
            "exhausted",
            "No fallback model left avoiding a validator/author routing collision",
          );
          task.status = "failed";
          task.statusReason =
            "Author and validator resolve to the same model for this task — fix routing in Settings (byDifficulty/byRole vs validatorByDifficulty)";
          this.deps.events.onTaskUpdated(task);
          return;
        }
        this.deps.events.onMergeDecision(decision);

        if (decision.verdict === "request_changes") {
          fixInstructions = decision.reasons.join("\n");
          this.emit(
            "warn",
            "validator",
            `Changes requested:\n${fixInstructions}`,
            task.id,
          );
          if (task.attempts < task.maxAttempts) continue;

          const choice = await this.deps.events.requestApproval({
            taskId: task.id,
            title: `Task exhausted ${task.maxAttempts} attempts`,
            message:
              `Validator still requests changes:\n${decision.reasons.join("\n")}`,
            options: ["approve_anyway", "reject"],
          });
          if (choice === "approve_anyway") {
            break;
          }
          task.status = "failed";
          task.statusReason = `Validator still requested changes after ${task.attempts} attempts and you rejected it${decision.reasons[0] ? `: ${decision.reasons[0]}` : ""}`;
          this.deps.events.onTaskUpdated(task);
          return;
        }

        if (decision.verdict === "escalate") {
          const choice = await this.deps.events.requestApproval({
            taskId: task.id,
            title: `Task ${task.id} escalated for human review`,
            message: decision.reasons.join("\n"),
            options: ["approve", "reject"],
          });
          if (choice === "approve") {
            break;
          }
          task.status = "failed";
          task.statusReason = `Escalated for review and rejected${decision.reasons[0] ? `: ${decision.reasons[0]}` : ""}`;
          this.deps.events.onTaskUpdated(task);
          return;
        }

        break;
      }

      if (this.paused) return;
      if (this.bailIfStopRequested(task)) return;

      // B30: the rest of this (docs stage -> sync -> GitHub checks -> merge
      // decision) is factored out into resolveMergeOutcome so restart
      // recovery can re-enter the exact same tail for a task whose validator
      // verdict already persisted (see recoverPendingApproval below) without
      // duplicating this logic.
      await this.resolveMergeOutcome(project, task, path, branch, finalGate!, signal);
    } catch (err: unknown) {
      if (signal.aborted) {
        if (this.stopRequested.has(task.id)) this.bailIfStopRequested(task);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.emit("error", "engine", `Fatal: ${message}`, task.id);
      task.status = "failed";
      task.statusReason = `Fatal error: ${message}`;
      this.deps.events.onTaskUpdated(task);
    } finally {
      if (this.taskAbortControllers.get(task.id) === taskController) {
        this.taskAbortControllers.delete(task.id);
      }
      this.stopRequested.delete(task.id);
      this.rateLimitWaits.delete(task.id);
      this.figmaCapabilityByTask.delete(task.id);
      this.noFigmaReferenceTasks.delete(task.id);
      try {
        await this.deps.worktrees.remove(project, task);
      } catch (err) {
        this.emit(
          "warn",
          "engine",
          `Optional worktree cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
          task.id,
        );
      }
      // A terminal failure, or a B42 block after an earlier attempt already
      // pushed, must not leave a remote branch that makes Retry fail with a
      // non-fast-forward. Initial preflight blocks never reach this call.
      if (task.status === "failed" || this.figmaBlockedTasks.has(task.id)) {
        try {
          await this.deps.git.cleanupTaskBranch(project, task);
        } catch (err) {
          this.emit(
            "warn",
            "engine",
            `Optional failed-branch cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
            task.id,
          );
        }
      }
      this.figmaBlockedTasks.delete(task.id);
    }
  }

  /**
   * Everything after the validator has already produced a MergeDecision for
   * this attempt: per-task docs, sync-with-main, the optional GitHub-checks
   * wait, and the final auto-merge-or-ask decision. Split out of
   * executeTask so B30's restart recovery (recoverPendingApproval below) can
   * re-enter this exact tail — using the PERSISTED decision's gate — instead
   * of re-running the author or the validator.
   */
  private async resolveMergeOutcome(
    project: Project,
    task: Task,
    path: string,
    branch: string,
    finalGate: GateResult,
    signal?: AbortSignal,
  ): Promise<void> {
    if (task.prNumber == null) {
      this.emit(
        "error",
        "engine",
        "Reached the merge step with no PR number — the author never " +
          "produced a pushable change on any attempt. Failing instead of " +
          'calling gh with an undefined PR ("gh pr merge undefined").',
        task.id,
      );
      task.status = "failed";
      task.statusReason = "No PR was ever opened — the author never produced a pushable change";
      this.deps.events.onTaskUpdated(task);
      return;
    }

    // F30: document the change in the same worktree/PR right after
    // validator approval — branch → PR → merge stays sacred, and the docs
    // land atomically with the code they describe. Strictly best-effort:
    // never blocks a validated merge, so no bailout on failure here — only
    // a Stop press (checked right after) can still cut it off.
    await this.runDocsStage(project, task, path, branch, signal);
    if (this.bailIfStopRequested(task)) return;

    // Bring the branch up to date with main before merging. A sibling task
    // may have merged overlapping files (commonly shared entry-point wiring
    // like index.html) since this branch's no-conflict gate passed, which
    // would make `gh pr merge` fail as CONFLICTING. Git auto-resolves
    // non-overlapping changes; a genuine conflict is recoverable by retrying
    // against the now-current main, so requeue rather than fail outright.
    const sync = await this.deps.git.syncBranchWithMain(project, task, signal);
    if (this.bailIfStopRequested(task)) return;
    if (sync === "conflict") {
      const n = (this.mergeConflicts.get(task.id) ?? 0) + 1;
      this.mergeConflicts.set(task.id, n);
      const MAX_MERGE_RETRIES = 2;
      if (n <= MAX_MERGE_RETRIES) {
        this.emit(
          "warn",
          "engine",
          `PR conflicts with ${project.defaultBranch} (a sibling task changed overlapping ` +
            `files) — requeuing for a fresh attempt against current ${project.defaultBranch} (${n}/${MAX_MERGE_RETRIES}).`,
          task.id,
        );
        // Fresh PR next time; the new worktree branches off current main, so
        // the work is redone on top of the sibling's changes and merges clean.
        task.status = "backlog";
        task.prNumber = undefined;
        this.deps.events.onTaskUpdated(task);
        return;
      }
      // Exhausted retries — hand to a human instead of looping or silently
      // failing. (Rare: requires repeated overlapping merges across attempts.)
      this.emit(
        "error",
        "engine",
        `PR still conflicts with ${project.defaultBranch} after ${MAX_MERGE_RETRIES} retries — needs manual resolution.`,
        task.id,
      );
      const choice = await this.deps.events.requestApproval({
        taskId: task.id,
        title: `Merge conflict in ${task.title}`,
        message:
          `This task repeatedly conflicts with ${project.defaultBranch} because other tasks ` +
          `changed the same files. Resolve the PR manually, then reject this to clear it.`,
        options: ["reject"],
      });
      void choice;
      task.status = "failed";
      task.statusReason = `Repeatedly conflicted with ${project.defaultBranch} (sibling tasks changed the same files) — needs manual resolution`;
      this.deps.events.onTaskUpdated(task);
      return;
    }

    // F15: opt-in per-project gate — hold the merge until the target
    // repo's own CI (its GitHub-side checks) passes, not just this app's
    // local gates. "passed"/"none" fall through to the normal canAutoMerge
    // risk check below; "failed"/"timeout" skip straight to a human
    // decision instead, since there's nothing more for canAutoMerge to add.
    if (project.config?.requireGithubChecks) {
      const timeoutMin = project.config.githubChecksTimeoutMin ?? 15;
      this.emit("info", "engine", "Waiting for GitHub checks before merging…", task.id);
      const checksResult = await this.deps.git.waitForChecks(
        project,
        task.prNumber!,
        timeoutMin * 60_000,
        (elapsedMs) => {
          this.emit(
            "info",
            "engine",
            `Waiting for GitHub checks (${Math.round(elapsedMs / 60_000)}m)…`,
            task.id,
          );
        },
        signal,
      );
      if (this.bailIfStopRequested(task)) return;
      if (checksResult === "failed" || checksResult === "timeout") {
        const reason =
          checksResult === "failed"
            ? "GitHub checks failed"
            : `GitHub checks timed out after ${timeoutMin}m`;
        this.emit(
          "warn",
          "engine",
          `${reason} — requesting approval instead of auto-merging`,
          task.id,
        );
        const choice = await this.deps.events.requestApproval({
          taskId: task.id,
          title: `GitHub checks ${checksResult} for ${task.title}`,
          message: `${reason}. Approve merge anyway?`,
          options: ["approve_merge", "reject"],
        });
        if (this.bailIfStopRequested(task)) return;
        if (choice === "approve_merge") {
          await this.deps.git.mergePr(project, task.prNumber!, signal);
          await this.appendChangelogBestEffort(project, task, signal);
          task.status = "done";
          task.statusReason = `Merged PR #${task.prNumber} after you approved it despite ${reason.toLowerCase()}`;
          this.emit("info", "engine", `Merged: ${task.title}`, task.id);
        } else {
          task.status = "failed";
          task.statusReason = `${reason} and you rejected the merge`;
          this.emit("warn", "engine", `Rejected: ${task.title}`, task.id);
        }
        this.deps.events.onTaskUpdated(task);
        return;
      }
    }

    const { canMerge, riskyReasons, safetyInspectionFailed } =
      await this.canAutoMerge(project, task, finalGate);
    if (this.bailIfStopRequested(task)) return;
    if (canMerge) {
      await this.deps.git.mergePr(project, task.prNumber!, signal);
      await this.appendChangelogBestEffort(project, task, signal);
      task.status = "done";
      task.statusReason = `Merged PR #${task.prNumber} after ${task.attempts} attempt${task.attempts === 1 ? "" : "s"} — gates and validator passed`;
      this.emit("info", "engine", `Merged: ${task.title}`, task.id);
    } else {
      // S8: a destructive-change trip carries specific reasons — surface
      // them verbatim in the approval message instead of the generic
      // "risky changes detected" copy every other risky-rule trip still
      // uses (those already log their own specific reason; this message
      // being generic for them is unchanged from before S8).
      const hasSafetyReasons = riskyReasons.length > 0;
      this.emit(
        "warn",
        "engine",
        `Risky change detected, requesting approval`,
        task.id,
      );
      const choice = await this.deps.events.requestApproval({
        taskId: task.id,
        title: `Risky changes in ${task.title}`,
        message: hasSafetyReasons
          ? `${safetyInspectionFailed ? "Safety inspection could not complete" : "Destructive change detected"} — ` +
            `this requires approval regardless of merge policy:\n${riskyReasons.map((r) => `- ${r}`).join("\n")}`
          : `Out-of-scope edits or risky changes detected. Approve merge?`,
        options: ["approve_merge", "reject"],
      });
      if (this.bailIfStopRequested(task)) return;
      if (choice === "approve_merge") {
        await this.deps.git.mergePr(project, task.prNumber!, signal);
        await this.appendChangelogBestEffort(project, task, signal);
        task.status = "done";
        task.statusReason = hasSafetyReasons
          ? safetyInspectionFailed
            ? `Merged PR #${task.prNumber} after you approved an incomplete safety inspection (${riskyReasons[0]})`
            : `Merged PR #${task.prNumber} after you approved a flagged destructive change (${riskyReasons[0]})`
          : `Merged PR #${task.prNumber} after you approved a risky/out-of-scope change`;
        this.emit("info", "engine", `Merged: ${task.title}`, task.id);
      } else {
        task.status = "failed";
        task.statusReason = hasSafetyReasons
          ? safetyInspectionFailed
            ? `Safety inspection was incomplete (${riskyReasons[0]}) and you rejected the merge`
            : `Flagged as a destructive change (${riskyReasons[0]}) and you rejected the merge`
          : "Flagged as risky (out-of-scope edits or a risky change class) and you rejected the merge";
        this.emit("warn", "engine", `Rejected: ${task.title}`, task.id);
      }
    }

    this.deps.events.onTaskUpdated(task);
  }

  /** Changelog publication is cosmetic after the PR itself is durable. Keep
   * it non-blocking, but never invisible: B39 requires every optional failure
   * to leave an operator-facing log entry. */
  private async appendChangelogBestEffort(
    project: Project,
    task: Task,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.deps.git.appendChangelogEntry(
        project,
        task,
        task.prNumber!,
        signal,
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      this.emit(
        "warn",
        "engine",
        `Optional changelog publication failed: ${err instanceof Error ? err.message : String(err)}`,
        task.id,
      );
    }
  }

  /**
   * B30: a task `in_review` with an open PR and a MergeDecision already
   * persisted for its CURRENT attempt (runId matches `run-<taskId>-<attempts>`)
   * was — before whatever restarted this process — sitting at one of
   * executeTask's `requestApproval` calls, not mid-authoring. Returns that
   * decision so start()'s orphan recovery can re-arm it instead of
   * requeueing the whole task back to backlog for a full re-run. Returns
   * undefined for anything else (no PR yet, no worktree, or the decision on
   * file predates the current attempt), which keeps today's requeue-and-
   * rerun behavior for genuinely orphaned mid-authoring tasks.
   */
  private findResumableDecision(task: Task): MergeDecision | undefined {
    if (task.prNumber == null || !task.worktreePath || !task.branch) {
      return undefined;
    }
    const decision = this.deps.getMergeDecisions?.(task.id)?.[0];
    if (!decision || decision.runId !== `run-${task.id}-${task.attempts}`) {
      return undefined;
    }
    return decision;
  }

  /**
   * B30: re-arm a task recovered by findResumableDecision — re-ask whichever
   * human decision it was last waiting on (using the persisted verdict/
   * reasons, never re-running the validator) and, once answered, resolve
   * the merge exactly like executeTask's own tail. Mirrors executeTask's
   * own try/catch/finally shape since this covers the same span of work.
   *
   * Note on repeated restarts: if the process restarts again while THIS
   * re-ask (or the merge tail it leads to) is itself pending, the next
   * boot's orphan recovery finds the same still-current decision and re-
   * arms again — safe (nothing here ever re-authors or re-validates), but a
   * human who already answered once mid-flight may see one extra prompt.
   */
  private async recoverPendingApproval(
    project: Project,
    task: Task,
    decision: MergeDecision,
  ): Promise<void> {
    const path = task.worktreePath!;
    const branch = task.branch!;
    const taskController = new AbortController();
    this.taskAbortControllers.set(task.id, taskController);
    const signal = taskController.signal;
    try {
      if (decision.verdict === "request_changes") {
        const choice = await this.deps.events.requestApproval({
          taskId: task.id,
          title: `Task exhausted ${task.maxAttempts} attempts`,
          message: `Validator still requests changes:\n${decision.reasons.join("\n")}`,
          options: ["approve_anyway", "reject"],
        });
        if (this.bailIfStopRequested(task)) return;
        if (choice !== "approve_anyway") {
          task.status = "failed";
          task.statusReason = `Validator still requested changes and you rejected it${decision.reasons[0] ? `: ${decision.reasons[0]}` : ""}`;
          this.deps.events.onTaskUpdated(task);
          return;
        }
      } else if (decision.verdict === "escalate") {
        const choice = await this.deps.events.requestApproval({
          taskId: task.id,
          title: `Task ${task.id} escalated for human review`,
          message: decision.reasons.join("\n"),
          options: ["approve", "reject"],
        });
        if (this.bailIfStopRequested(task)) return;
        if (choice !== "approve") {
          task.status = "failed";
          task.statusReason = `Escalated for review and rejected${decision.reasons[0] ? `: ${decision.reasons[0]}` : ""}`;
          this.deps.events.onTaskUpdated(task);
          return;
        }
      }

      if (this.bailIfStopRequested(task)) return;
      await this.resolveMergeOutcome(project, task, path, branch, decision.gate, signal);
    } catch (err: unknown) {
      if (signal.aborted) {
        if (this.stopRequested.has(task.id)) this.bailIfStopRequested(task);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.emit("error", "engine", `Fatal: ${message}`, task.id);
      task.status = "failed";
      task.statusReason = `Fatal error: ${message}`;
      this.deps.events.onTaskUpdated(task);
    } finally {
      if (this.taskAbortControllers.get(task.id) === taskController) {
        this.taskAbortControllers.delete(task.id);
      }
      this.stopRequested.delete(task.id);
      try {
        await this.deps.worktrees.remove(project, task);
      } catch (err) {
        this.emit(
          "warn",
          "engine",
          `Optional worktree cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
          task.id,
        );
      }
      // Same failed-branch cleanup as executeTask's finally.
      if (task.status === "failed") {
        try {
          await this.deps.git.cleanupTaskBranch(project, task);
        } catch (err) {
          this.emit(
            "warn",
            "engine",
            `Optional failed-branch cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
            task.id,
          );
        }
      }
    }
  }

  private async runAuthor(
    project: Project,
    task: Task,
    fixInstructions?: string,
    effectiveModel?: ModelId,
    taskSignal?: AbortSignal,
  ): Promise<AgentRunResult | null> {
    const model = effectiveModel ?? task.assignedModel;
    const config = this.settings().models.find((candidate) => candidate.id === model);
    if (!config?.enabled) {
      throw new Error(`model ${model} is ${config ? "disabled" : "not configured"}`);
    }
    const effort = config.effort ?? "default";
    const adapter = this.deps.adapterFor(model);
    const prompt = this.buildAuthorPrompt(project, task, fixInstructions);

    const controller = new AbortController();
    const onTaskAbort = () => controller.abort();
    if (taskSignal?.aborted) onTaskAbort();
    else taskSignal?.addEventListener("abort", onTaskAbort, { once: true });

    let lastLogTime = Date.now();
    let lastLine = "";
    let repeatCount = 0;

    const maxRunTimer = setTimeout(() => {
      controller.abort();
    }, STUCK_DETECTION.maxRunMs);

    const idleTimer = setInterval(() => {
      if (Date.now() - lastLogTime > STUCK_DETECTION.idleMs) {
        controller.abort();
      }
    }, 1000);

    // Surface the run the instant it starts, not just when it ends —
    // without this there's no run row at all while the agent works (the
    // board can't show a "running" attempt, and durations always read 0
    // since start/end were previously stamped from the same Date.now()
    // after the fact). Held here so every terminal emit below reports the
    // true elapsed time instead of a fresh (and wrong) timestamp.
    const startedAt = new Date().toISOString();
    this.emitRunEvent(task, null, "running", model, startedAt, undefined, effort);

    try {
      const result = await adapter.run({
        model,
        prompt,
        cwd: task.worktreePath!,
        signal: controller.signal,
        onLog: (line: string) => {
          lastLogTime = Date.now();
          if (line === lastLine) {
            repeatCount++;
          } else {
            repeatCount = 0;
            lastLine = line;
          }
          if (repeatCount >= STUCK_DETECTION.maxRepeats) {
            controller.abort();
          }

          this.deps.events.onLog({
            projectId: this.projectId,
            runId: `run-${task.id}-${task.attempts}`,
            taskId: task.id,
            ts: new Date().toISOString(),
            level: "debug",
            source: "agent",
            message: line,
          });
        },
      });

      if (controller.signal.aborted) {
        if (this.paused || this.stopRequested.has(task.id) || taskSignal?.aborted) {
          this.emitRunEvent(task, result, "stopped", model, startedAt, undefined, effort);
          return null;
        }
        const stuckResult: AgentRunResult = {
          ...result,
          ok: false,
          exitReason: "stuck",
          summary: result.summary || "Run killed by stuck detection",
        };
        this.emitRunEvent(task, stuckResult, "failed", model, startedAt, undefined, effort);
        return stuckResult;
      }

      // B42: the prompt requires this stable marker if Figma disappears after
      // preflight. Normalize it before emitting the run so it cannot be
      // persisted as a pass and later mistaken for a no-change result.
      const figmaContext = this.figmaCapabilityByTask.get(task.id);
      const normalizedResult =
        figmaContext &&
        (result.summary ?? "").includes(FIGMA_CAPABILITY_UNAVAILABLE_MARKER)
          ? {
              ...result,
              ok: false,
              exitReason: "error" as const,
            }
          : result;

      // adapter.run() can resolve with ok:false (e.g. exitReason "killed" from
      // an internal timeout) without throwing — label the run row to match,
      // not unconditionally "passed".
      this.emitRunEvent(
        task,
        normalizedResult,
        normalizedResult.ok ? "passed" : "failed",
        model,
        startedAt,
        undefined,
        effort,
      );
      return normalizedResult;
    } catch (err: unknown) {
      if (
        (err as Error).name === "AbortError" ||
        controller.signal.aborted
      ) {
        // Pause and user-stop both abort via this same controller — without
        // this check a Stop press would be misread as stuck detection and
        // fed straight into fallback-model escalation instead of actually
        // stopping the task.
        if (this.paused || this.stopRequested.has(task.id)) {
          this.emitRunEvent(task, null, "stopped", model, startedAt, undefined, effort);
          return null;
        }

        const stuckResult: AgentRunResult = {
          ok: false,
          exitReason: "stuck",
          costUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          summary: "Run killed by stuck detection",
        };
        this.emitRunEvent(task, stuckResult, "failed", model, startedAt, undefined, effort);
        return stuckResult;
      }
      throw err;
    } finally {
      clearTimeout(maxRunTimer);
      clearInterval(idleTimer);
      taskSignal?.removeEventListener("abort", onTaskAbort);
    }
  }

  /**
   * F30: after validator approval, run a docs-role-routed model in the same
   * worktree to update CHANGELOG.md (and README/docs/** only if this change
   * makes them wrong), then commit + push so the docs ride the same PR.
   * Strictly best-effort — every failure path here warn-logs and returns
   * without throwing, so a documentation hiccup can never block a validated
   * merge. `path`/`branch` are the task's worktree path and branch (already
   * resolved by the caller — same values `runAuthor`/`commitAll`/`push` use).
   */
  private async runDocsStage(
    project: Project,
    task: Task,
    path: string,
    branch: string,
    taskSignal?: AbortSignal,
  ): Promise<void> {
    if (project.config?.perTaskDocs === false) return;

    const settings = this.settings();
    const docsModel = settings.routing.byRole.updates ?? settings.routing.byRole.docs;
    const docsConfig = settings.models.find((model) => model.id === docsModel);
    if (!docsModel || !docsConfig?.enabled) {
      this.emit(
        "warn",
        "engine",
        "No documenter model routed (byRole.updates/docs) — skipping per-task docs stage",
        task.id,
      );
      return;
    }

    this.emit("info", "engine", `Documenting merged change with ${docsModel}…`, task.id);

    const runId = `run-${task.id}-docs`;
    const startedAt = new Date().toISOString();
    const effort = docsConfig.effort ?? "default";
    const controller = new AbortController();
    const onTaskAbort = () => controller.abort();
    if (taskSignal?.aborted) onTaskAbort();
    else taskSignal?.addEventListener("abort", onTaskAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), DOCS_STAGE_TIMEOUT_MS);
    this.emitRunEvent(task, null, "running", docsModel, startedAt, runId, effort);

    let result: AgentRunResult;
    try {
      result = await this.deps.adapterFor(docsModel).run({
        model: docsModel,
        prompt: this.buildDocsPrompt(project, task),
        cwd: path,
        signal: controller.signal,
        onLog: (line) =>
          this.deps.events.onLog({
            projectId: this.projectId,
            runId,
            taskId: task.id,
            ts: new Date().toISOString(),
            level: "debug",
            source: "agent",
            message: line,
          }),
      });
    } catch (err: unknown) {
      if (taskSignal?.aborted) {
        this.emitRunEvent(task, null, "stopped", docsModel, startedAt, runId, effort);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.emit(
        "warn",
        "engine",
        `Documentation stage errored (${message}) — merging without a docs update`,
        task.id,
      );
      this.emitRunEvent(task, null, "failed", docsModel, startedAt, runId, effort);
      return;
    } finally {
      clearTimeout(timer);
      taskSignal?.removeEventListener("abort", onTaskAbort);
    }

    if (taskSignal?.aborted) {
      this.emitRunEvent(task, result, "stopped", docsModel, startedAt, runId, effort);
      return;
    }
    this.emitRunEvent(
      task,
      result,
      result.ok ? "passed" : "failed",
      docsModel,
      startedAt,
      runId,
      effort,
    );
    if (!result.ok) {
      this.emit(
        "warn",
        "engine",
        `Documentation stage failed (${result.exitReason}) — merging without a docs update`,
        task.id,
      );
      return;
    }

    try {
      // The documenter is prompted to touch only docs, but this is the
      // actual enforcement — it never gets to change code, regardless of
      // what it was told.
      const reverted = await this.deps.worktrees.revertOutOfScope(task, DOCS_ALLOWED_SCOPE);
      if (reverted.length > 0) {
        this.emit(
          "warn",
          "engine",
          `Documenter edited files outside its allowed scope — reverted: ${reverted.join(", ")}`,
          task.id,
        );
      }
      await this.deps.git.commitAll(path, `docs: ${task.title}`, taskSignal);
      await this.deps.git.push(path, branch, taskSignal);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit(
        "warn",
        "engine",
        `Documentation stage's commit/push failed (${message}) — merging without a docs update`,
        task.id,
      );
    }
  }

  private buildDocsPrompt(project: Project, task: Task): string {
    let prompt = `## Document this merged change: ${task.title}\n\n${task.description}\n\n`;
    prompt +=
      `This task (attempt ${task.attempts}, authored by ${task.assignedModel}) has ` +
      `already been implemented and approved by the validator — do not change any code. ` +
      `Inspect what actually changed yourself (\`git diff ${project.defaultBranch}...HEAD --stat\` ` +
      `and targeted diffs as needed), then:\n` +
      `- Update CHANGELOG.md with an entry for this change (create it if it doesn't exist).\n` +
      `- Touch README.md or docs/** ONLY if this change makes something there wrong or incomplete.\n` +
      `- Touch AGENTS.md ONLY if this change alters the project's structure, commands, or ` +
      `conventions (it may not exist — only touch it if it does).\n` +
      `- Modify nothing else.\n`;
    prompt += buildEngineeringStandardsBlock(this.settings().guidelines, false, true);
    return prompt;
  }

  private emit(
    level: LogLevel,
    source: LogEvent["source"],
    message: string,
    taskId: string,
  ): void {
    this.deps.events.onLog({
      projectId: this.projectId,
      runId: "",
      taskId,
      ts: new Date().toISOString(),
      level,
      source,
      message,
    });
  }

  private emitRunEvent(
    task: Task,
    result: AgentRunResult | null,
    status: RunStatus,
    model: ModelId | undefined,
    startedAt: string,
    // F30: the docs stage passes its own `run-<taskId>-docs` id since it
    // isn't tied to an attempt number the way author runs are.
    runId: string = `run-${task.id}-${task.attempts}`,
    effort = "default",
  ): void {
    const run: Run = {
      id: runId,
      projectId: this.projectId,
      taskId: task.id,
      model: model ?? task.assignedModel,
      effort,
      attempt: task.attempts,
      status,
      startedAt,
      // Only a terminal status has actually ended — leaving this unset on
      // the initial "running" emit is what lets GET /api/tasks/:id/runs show
      // a live in-progress row instead of one that looks instantly finished.
      endedAt: status === "running" ? undefined : new Date().toISOString(),
      exitReason: result?.exitReason,
      costUsd: result?.costUsd ?? 0,
      tokensIn: result?.tokensIn ?? 0,
      tokensOut: result?.tokensOut ?? 0,
      tokensCached: result?.tokensCached ?? 0,
    };
    this.deps.events.onRunUpdated(run);
  }

  private buildAuthorPrompt(
    project: Project,
    task: Task,
    fixInstructions?: string,
  ): string {
    let prompt = `## Task: ${task.title}\n\n${task.description}\n\n`;
    prompt += buildTaskHandoffBlock(task.description);
    prompt +=
      `## Acceptance Criteria\n${task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}\n\n`;
    prompt += WORKING_DIRECTORY_BLOCK;
    prompt +=
      `## Allowed Files\n${task.scopePaths.map((s) => `- ${s}`).join("\n") || "(no restrictions)"}\n` +
      `Stay within these paths. If completing the task genuinely requires touching another file ` +
      `(e.g. wiring an entry point), keep that edit minimal — files outside this list are flagged ` +
      `for human review and can hold up the merge.\n`;
    prompt += buildEngineeringStandardsBlock(
      this.settings().guidelines,
      task.role === "frontend",
      task.role === "docs",
    );
    prompt += SAFETY_GUARDRAILS_BLOCK;
    prompt += buildSkillsBlock(project.config?.skillHints);
    if (task.worktreePath) prompt += buildAgentsMdBlock(task.worktreePath);
    if (this.figmaCapabilityByTask.has(task.id)) {
      prompt +=
        `\n## Figma capability continuity\n` +
        `The assigned runner proved access to this task's exact Figma reference before this ` +
        `attempt. Use the configured Figma MCP/tool for the implementation. If that access ` +
        `disappears, stop instead of guessing or claiming inspection, and end your final ` +
        `response with this exact marker on its own line:\n` +
        `${FIGMA_CAPABILITY_UNAVAILABLE_MARKER}\n`;
    }

    if (fixInstructions) {
      prompt += `\n## Issues to Fix\n${fixInstructions}\n`;
    }

    return prompt;
  }

  private buildGateFixInstructions(gate: GateResult): string {
    const failures: string[] = [];
    if (!gate.typecheck)
      failures.push(
        `- typecheck failed: ${gate.details.typecheck || "unknown error"}`,
      );
    if (!gate.lint)
      failures.push(
        `- lint failed: ${gate.details.lint || "unknown error"}`,
      );
    if (!gate.build)
      failures.push(
        `- build failed: ${gate.details.build || "unknown error"}`,
      );
    if (!gate.tests)
      failures.push(
        `- tests failed: ${gate.details.tests || "unknown error"}`,
      );
    if (!gate.noConflicts)
      failures.push(`- conflicts with default branch detected`);
    if (!gate.inScope)
      failures.push(
        `- files modified outside allowed scope (${gate.details.inScope})`,
      );
    return failures.join("\n");
  }

  /**
   * Returns `canMerge: false` with populated `riskyReasons` whenever a
   * destructive change is detected or its safety inspection cannot complete.
   * Every other risky-rule trip returns `riskyReasons: []` and relies on its
   * own warning log for detail. The populated reasons let the human-facing
   * approval message name exactly what tripped.
   */
  private async canAutoMerge(
    project: Project,
    task: Task,
    gate: GateResult,
  ): Promise<{
    canMerge: boolean;
    riskyReasons: string[];
    safetyInspectionFailed?: boolean;
  }> {
    const settings = this.settings();
    const { riskyChangeRules } = settings;

    // S8: runs BEFORE any merge-policy branch below, including
    // fully_autonomous's "always merge" — a destructive change forces
    // human review in EVERY policy, not just the default one. That's the
    // whole point: non-bypassable. `!== false` (not a plain truthy check)
    // so settings persisted before this field existed — which lack the key
    // entirely — default to enabled, the safe reading of "absent".
    if (riskyChangeRules.destructiveChanges !== false) {
      const [filesWithStatus, diff] = await Promise.all([
        this.deps.worktrees.changedFilesWithStatus(project, task),
        this.deps.worktrees.diffText(project, task),
      ]);
      const acquisitionReasons: string[] = [];
      if (!filesWithStatus.ok && !filesWithStatus.truncated) {
        acquisitionReasons.push(
          `Could not inspect changed-file statuses: ${filesWithStatus.error ?? "unknown git error"}`,
        );
      }
      if (filesWithStatus.truncated) {
        acquisitionReasons.push(
          `Changed-file status output exceeded the ${filesWithStatus.byteCount}-byte safety limit`,
        );
      }
      if (!diff.ok && !diff.truncated) {
        acquisitionReasons.push(
          `Could not inspect the complete diff: ${diff.error ?? "unknown git error"}`,
        );
      }
      if (diff.truncated) {
        acquisitionReasons.push(
          `Diff exceeded the ${diff.byteCount}-byte safety limit and could not be fully scanned`,
        );
      }
      if (acquisitionReasons.length > 0) {
        this.emit(
          "warn",
          "engine",
          `Safety inspection incomplete — ${acquisitionReasons.join("; ")}`,
          task.id,
        );
        return {
          canMerge: false,
          riskyReasons: acquisitionReasons,
          safetyInspectionFailed: true,
        };
      }
      const reasons = detectDestructiveChanges(
        filesWithStatus.value,
        diff.value,
      );
      if (reasons.length > 0) {
        this.emit(
          "warn",
          "engine",
          `Risky: destructive change detected — ${reasons.join("; ")}`,
          task.id,
        );
        return { canMerge: false, riskyReasons: reasons };
      }
    }

    // F9: a project can override the global merge policy (e.g. "always_ask"
    // for a sensitive repo, or "fully_autonomous" for a low-stakes one).
    const mergePolicy = project.config?.mergePolicy ?? settings.mergePolicy;

    if (mergePolicy === "fully_autonomous") return { canMerge: true, riskyReasons: [] };
    if (mergePolicy === "always_ask") return { canMerge: false, riskyReasons: [] };

    // hard_gate_flag_risky: auto-merge unless a risky-change rule trips.
    if (riskyChangeRules.outOfScopeEdits && !gate.inScope) {
      return { canMerge: false, riskyReasons: [] };
    }

    if (gate.vacuous && !settings.allowVacuousGates) {
      this.emit(
        "warn",
        "engine",
        "Risky: no objective gates ran (repo has no typecheck/lint/build/test scripts)",
        task.id,
      );
      return { canMerge: false, riskyReasons: [] };
    }

    const files = await this.deps.worktrees.changedFiles(project, task);
    if (riskyChangeRules.dbSchema && files.some((f) => /\.sql$|migrations?\//i.test(f))) {
      this.emit("warn", "engine", "Risky: DB/schema change detected", task.id);
      return { canMerge: false, riskyReasons: [] };
    }
    if (
      riskyChangeRules.newDependencies &&
      files.some((f) => /(^|\/)package\.json$/.test(f))
    ) {
      this.emit("warn", "engine", "Risky: dependency change detected", task.id);
      return { canMerge: false, riskyReasons: [] };
    }
    if (
      riskyChangeRules.authOrSecrets &&
      files.some((f) => isAuthOrSecretFile(f))
    ) {
      this.emit("warn", "engine", "Risky: auth/secret change detected", task.id);
      return { canMerge: false, riskyReasons: [] };
    }

    return { canMerge: true, riskyReasons: [] };
  }
}
