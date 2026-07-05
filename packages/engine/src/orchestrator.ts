import type {
  Difficulty,
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
import type { AgentRunResult } from "@orc/adapters";
import { STUCK_DETECTION } from "./constants.js";
import { SelfReviewError } from "./validator.js";
import type { EngineEvents, Scheduler, SchedulerDeps } from "./index.js";

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
 * Empty arrays mean "no restriction" and are treated as non-overlapping so
 * unrestricted tasks don't block each other unnecessarily. An empty static
 * prefix on either side (e.g. from `**\/*`) means that side can't rule out
 * any file, so it overlaps with everything.
 */
export function scopesOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
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

/**
 * Build the auto-escalation fallback chain for a task. Starts with the
 * task's assigned model, then escalates through difficulty tiers (easy →
 * medium → hard) using the routing byDifficulty table. Duplicates are
 * skipped so the chain never retries the same model twice.
 */
function buildFallbackChain(
  assignedModel: ModelId,
  difficulty: Difficulty,
  routing: RoutingPolicy,
): ModelId[] {
  const chain: ModelId[] = [assignedModel];
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

  constructor(private readonly deps: SchedulerDeps) {}

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
    return tasks.filter(
      (t) =>
        (t.status === "backlog" || t.status === "ready") &&
        t.dependsOn.every((dep) => done.has(dep)),
    );
  }

  async start(project: Project, tasks: Task[]): Promise<void> {
    this.paused = false;
    this.draining = false;
    this.projectId = project.id;
    this.currentTasks = tasks;
    this.budgetBlockedWarned.clear();
    this.cooldownBlockedWarned.clear();

    // Orphan recovery: this Orchestrator instance starts with empty
    // activeTaskIds, so any task already "in_progress" or "in_review" was
    // left mid-run by a previous process (crash, restart, deploy) — nothing
    // is actually working on it. Requeue it as backlog so the scheduler
    // retries it instead of silently stalling forever (it would never appear
    // in readyTasks() and would permanently block every task that depends on
    // it).
    for (const task of tasks) {
      if (task.status === "in_progress" || task.status === "in_review") {
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
      // Draining: never pick up new work, but leave activeTaskIds alone so
      // whatever's already running finishes normally. Forcing `ready` empty
      // means `dispatched` stays 0 every pass below, which the existing
      // "nothing dispatched" branches already turn into a 250ms poll while
      // active tasks remain, then a break once the last one finishes.
      const ready = this.draining ? [] : this.readyTasks(tasks);

      if (ready.length === 0 && this.activeTaskIds.size === 0) {
        break;
      }

      // Scope paths of all currently running tasks, for overlap detection.
      // Mutable: appended to as each task is dispatched below so two
      // overlapping tasks considered in the SAME pass over `ready` can't
      // both slip through — the second must see the first's scope even
      // though this array started the pass before either was active.
      const activeScopePaths = [...this.activeTaskIds].flatMap(
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
      for (const task of ready) {
        if (this.paused) break;
        if (this.activeTaskIds.has(task.id)) continue;

        // Scope-overlap serialization: hold this task back if any active task
        // writes to the same files. It will be dispatched once the conflicting
        // task merges and the loop iterates again.
        if (scopesOverlap(task.scopePaths, activeScopePaths)) {
          this.emit(
            "info",
            "engine",
            `Holding "${task.title}" — scope overlaps with a running task`,
            task.id,
          );
          continue;
        }

        const cfg = this.deps.settings.models.find(
          (m) => m.id === task.assignedModel,
        );
        if (!cfg) {
          this.emit(
            "error",
            "engine",
            `No ModelConfig for ${task.assignedModel}`,
            task.id,
          );
          continue;
        }

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

        // F6: skip (don't fail) a task whose assigned model is cooling down
        // from a rate-limit-shaped failure — same "hold, don't burn an
        // attempt" treatment as the budget guard above.
        const cooldownMsg = this.deps.checkModelCooldown?.(task.assignedModel) ?? null;
        if (cooldownMsg) {
          if (!this.cooldownBlockedWarned.has(task.id)) {
            this.cooldownBlockedWarned.add(task.id);
            this.emit(
              "warn",
              "engine",
              `Model cooling down, not dispatching: ${cooldownMsg}`,
              task.id,
            );
          }
          continue;
        }
        this.cooldownBlockedWarned.delete(task.id);

        const active = this.getModelActive(task.assignedModel);
        if (active >= cfg.maxConcurrent) {
          blockedByCapacity = true;
          continue;
        }

        this.incModel(task.assignedModel);
        this.runningModel.set(task.id, task.assignedModel);
        this.activeTaskIds.add(task.id);
        activeScopePaths.push(...task.scopePaths);
        dispatched++;

        this.executeTask(project, task).finally(() => {
          // Decrement whichever model the task was last running on (fallback
          // escalation may have switched it from task.assignedModel).
          const ran = this.runningModel.get(task.id) ?? task.assignedModel;
          this.decModel(ran);
          this.runningModel.delete(task.id);
          this.activeTaskIds.delete(task.id);
        });
      }

      if (dispatched === 0 && (this.activeTaskIds.size > 0 || blockedByCapacity)) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }

      if (dispatched === 0 && this.activeTaskIds.size === 0) {
        break;
      }

      await new Promise((r) => setImmediate(r));
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
    this.taskAbortControllers.clear();

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
    this.emit("warn", "engine", "Stopped by user", task.id);
    this.deps.events.onTaskUpdated(task);
    return true;
  }

  /** Run a single task through the full pipeline (manual dispatch). */
  async runTask(project: Project, task: Task): Promise<void> {
    this.paused = false;
    this.projectId = project.id;
    // start()'s loop tracks this in activeTaskIds itself; runTask bypasses
    // that loop entirely, so stopTask()'s guard would never see this task as
    // stoppable without tracking it here too.
    this.activeTaskIds.add(task.id);
    try {
      await this.executeTask(project, task);
    } finally {
      this.activeTaskIds.delete(task.id);
    }
  }

  private async executeTask(
    project: Project,
    task: Task,
  ): Promise<void> {
    this.emit("info", "engine", `Starting: ${task.title}`, task.id);

    task.status = "in_progress";
    this.deps.events.onTaskUpdated(task);

    // Build the fallback escalation chain once per task execution.
    const fallbackChain = buildFallbackChain(
      task.assignedModel,
      task.difficulty,
      this.deps.settings.routing,
    );
    let fallbackIdx = 0;
    let currentModel = fallbackChain[0]!;

    try {
      const { branch, path } = await this.deps.worktrees.create(
        project,
        task,
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

        this.emit(
          "info",
          "engine",
          `Attempt ${task.attempts}/${task.maxAttempts} [model: ${currentModel}]`,
          task.id,
        );

        const authorResult = await this.runAuthor(
          project,
          task,
          fixInstructions,
          currentModel,
        );
        if (this.bailIfStopRequested(task)) return;
        if (authorResult === null) return; // paused

        if (!authorResult.ok) {
          this.emit(
            "error",
            "agent",
            `Author run failed: ${authorResult.exitReason}`,
            task.id,
          );
          // Immediately escalate to the next fallback model on adapter/stuck errors.
          const next = fallbackChain[fallbackIdx + 1];
          if (next) {
            fallbackIdx++;
            currentModel = next;
            this.switchRunningModel(task.id, next);
            if (task.attempts >= task.maxAttempts) task.maxAttempts++;
            this.emit(
              "warn",
              "engine",
              `Switching to fallback model: ${currentModel}`,
              task.id,
            );
            continue;
          }
          task.status = "failed";
          this.deps.events.onTaskUpdated(task);
          return;
        }

        await this.deps.git.commitAll(
          path,
          `feat: ${task.title} (attempt ${task.attempts})`,
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
          this.emit(
            "error",
            "engine",
            `Author produced no changes in the worktree (${path}). ` +
              `Nothing to commit/PR — check that the agent wrote into the worktree, not elsewhere.`,
            task.id,
          );
          fixInstructions =
            "Your previous attempt made no file changes (likely ran out of " +
            "steps before writing anything, or wrote outside the worktree). " +
            "This attempt must actually create/modify the files this task " +
            "requires — verify with `git status` before finishing.";

          if (task.attempts < task.maxAttempts) continue;

          const next = fallbackChain[fallbackIdx + 1];
          if (next) {
            fallbackIdx++;
            currentModel = next;
            this.switchRunningModel(task.id, next);
            task.maxAttempts++;
            this.emit(
              "warn",
              "engine",
              `No changes produced, switching to fallback model: ${currentModel}`,
              task.id,
            );
            continue;
          }

          task.status = "failed";
          this.deps.events.onTaskUpdated(task);
          return;
        }

        await this.deps.git.push(path, branch);

        // Open the PR the first time a push actually succeeds — not
        // hardcoded to attempt 1. An author-run failure (stuck detection,
        // adapter error) can consume attempt 1 before ever reaching this
        // line, e.g. via fallback escalation; gating on attempts === 1 then
        // skips openPr() forever and task.prNumber stays undefined, which
        // later crashes the merge step with `gh pr merge undefined`.
        if (task.prNumber == null) {
          task.prNumber = await this.deps.git.openPr(project, task);
          this.deps.events.onTaskUpdated(task);
        }

        // Gates + validator take minutes; without this the board shows
        // "In Progress" throughout review with no way to tell dispatch time
        // from review time. Reset back to "in_progress" at the top of the
        // next attempt if this one gets retried.
        task.status = "in_review";
        this.deps.events.onTaskUpdated(task);

        const gateResult = await this.deps.gates.run(project, task);
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
          const next = fallbackChain[fallbackIdx + 1];
          if (next) {
            fallbackIdx++;
            currentModel = next;
            this.switchRunningModel(task.id, next);
            task.maxAttempts++;
            this.emit(
              "warn",
              "engine",
              `Gates still failing, switching to fallback model: ${currentModel}`,
              task.id,
            );
            continue;
          }

          task.status = "failed";
          this.deps.events.onTaskUpdated(task);
          return;
        }

        if (this.bailIfStopRequested(task)) return;

        // Announce the review — it spawns a separate reviewer model and can run
        // for minutes; without this the board goes silent and looks frozen.
        this.emit(
          "info",
          "validator",
          `Reviewing changes with the validator model (this can take a few minutes)…`,
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
          );
        } catch (err) {
          if (!(err instanceof SelfReviewError)) throw err;
          // Routing misconfiguration (author/validator collide for this
          // difficulty, or escalation walked into the validator's model) —
          // recoverable by escalating same as a gate failure, not fatal.
          this.emit("warn", "validator", err.message, task.id);
          const next = fallbackChain[fallbackIdx + 1];
          if (next) {
            fallbackIdx++;
            currentModel = next;
            this.switchRunningModel(task.id, next);
            task.maxAttempts++;
            this.emit(
              "warn",
              "engine",
              `Switching to fallback model: ${currentModel}`,
              task.id,
            );
            continue;
          }
          this.emit(
            "error",
            "engine",
            "No remaining fallback model avoids the validator collision — fix routing in Settings (byDifficulty/byRole vs validatorByDifficulty).",
            task.id,
          );
          task.status = "failed";
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
          this.deps.events.onTaskUpdated(task);
          return;
        }

        break;
      }

      if (this.paused) return;
      if (this.bailIfStopRequested(task)) return;

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
        this.deps.events.onTaskUpdated(task);
        return;
      }

      // Bring the branch up to date with main before merging. A sibling task
      // may have merged overlapping files (commonly shared entry-point wiring
      // like index.html) since this branch's no-conflict gate passed, which
      // would make `gh pr merge` fail as CONFLICTING. Git auto-resolves
      // non-overlapping changes; a genuine conflict is recoverable by retrying
      // against the now-current main, so requeue rather than fail outright.
      const sync = await this.deps.git.syncBranchWithMain(project, task);
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
        this.deps.events.onTaskUpdated(task);
        return;
      }

      const canMerge = await this.canAutoMerge(project, task, finalGate!);
      if (canMerge) {
        await this.deps.git.mergePr(project, task.prNumber!);
        await this.deps.git.appendChangelogEntry(project, task, task.prNumber!);
        task.status = "done";
        this.emit("info", "engine", `Merged: ${task.title}`, task.id);
      } else {
        this.emit(
          "warn",
          "engine",
          `Risky change detected, requesting approval`,
          task.id,
        );
        const choice = await this.deps.events.requestApproval({
          taskId: task.id,
          title: `Risky changes in ${task.title}`,
          message: `Out-of-scope edits or risky changes detected. Approve merge?`,
          options: ["approve_merge", "reject"],
        });
        if (choice === "approve_merge") {
          await this.deps.git.mergePr(project, task.prNumber!);
          await this.deps.git.appendChangelogEntry(project, task, task.prNumber!);
          task.status = "done";
          this.emit("info", "engine", `Merged: ${task.title}`, task.id);
        } else {
          task.status = "failed";
          this.emit("warn", "engine", `Rejected: ${task.title}`, task.id);
        }
      }

      this.deps.events.onTaskUpdated(task);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit("error", "engine", `Fatal: ${message}`, task.id);
      task.status = "failed";
      this.deps.events.onTaskUpdated(task);
    } finally {
      this.stopRequested.delete(task.id);
      try {
        await this.deps.worktrees.remove(project, task);
      } catch {
        /* best effort */
      }
    }
  }

  private async runAuthor(
    _project: Project,
    task: Task,
    fixInstructions?: string,
    effectiveModel?: ModelId,
  ): Promise<AgentRunResult | null> {
    const model = effectiveModel ?? task.assignedModel;
    const adapter = this.deps.adapterFor(model);
    const prompt = this.buildAuthorPrompt(task, fixInstructions);

    const controller = new AbortController();
    this.taskAbortControllers.set(task.id, controller);

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
    this.emitRunEvent(task, null, "running", model, startedAt);

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

      // adapter.run() can resolve with ok:false (e.g. exitReason "killed" from
      // an internal timeout) without throwing — label the run row to match,
      // not unconditionally "passed".
      this.emitRunEvent(task, result, result.ok ? "passed" : "failed", model, startedAt);
      return result;
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
          this.emitRunEvent(task, null, "stopped", model, startedAt);
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
        this.emitRunEvent(task, stuckResult, "failed", model, startedAt);
        return stuckResult;
      }
      throw err;
    } finally {
      clearTimeout(maxRunTimer);
      clearInterval(idleTimer);
      this.taskAbortControllers.delete(task.id);
    }
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
  ): void {
    const run: Run = {
      id: `run-${task.id}-${task.attempts}`,
      projectId: this.projectId,
      taskId: task.id,
      model: model ?? task.assignedModel,
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
    };
    this.deps.events.onRunUpdated(run);
  }

  private buildAuthorPrompt(
    task: Task,
    fixInstructions?: string,
  ): string {
    let prompt = `## Task: ${task.title}\n\n${task.description}\n\n`;
    prompt +=
      `## Acceptance Criteria\n${task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}\n\n`;
    prompt +=
      `## Allowed Files\n${task.scopePaths.map((s) => `- ${s}`).join("\n") || "(no restrictions)"}\n`;

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

  private async canAutoMerge(
    project: Project,
    task: Task,
    gate: GateResult,
  ): Promise<boolean> {
    // F9: a project can override the global merge policy (e.g. "always_ask"
    // for a sensitive repo, or "fully_autonomous" for a low-stakes one).
    const mergePolicy = project.config?.mergePolicy ?? this.deps.settings.mergePolicy;
    const { riskyChangeRules } = this.deps.settings;

    if (mergePolicy === "fully_autonomous") return true;
    if (mergePolicy === "always_ask") return false;

    // hard_gate_flag_risky: auto-merge unless a risky-change rule trips.
    if (riskyChangeRules.outOfScopeEdits && !gate.inScope) return false;

    if (gate.vacuous && !this.deps.settings.allowVacuousGates) {
      this.emit(
        "warn",
        "engine",
        "Risky: no objective gates ran (repo has no typecheck/lint/build/test scripts)",
        task.id,
      );
      return false;
    }

    const files = await this.deps.worktrees.changedFiles(project, task);
    if (riskyChangeRules.dbSchema && files.some((f) => /\.sql$|migrations?\//i.test(f))) {
      this.emit("warn", "engine", "Risky: DB/schema change detected", task.id);
      return false;
    }
    if (
      riskyChangeRules.newDependencies &&
      files.some((f) => /(^|\/)package\.json$/.test(f))
    ) {
      this.emit("warn", "engine", "Risky: dependency change detected", task.id);
      return false;
    }
    if (
      riskyChangeRules.authOrSecrets &&
      files.some((f) => isAuthOrSecretFile(f))
    ) {
      this.emit("warn", "engine", "Risky: auth/secret change detected", task.id);
      return false;
    }

    return true;
  }
}
