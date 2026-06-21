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
import type { EngineEvents, Scheduler, SchedulerDeps } from "./index.js";

/**
 * Returns true if the two scope-path arrays share at least one overlapping
 * file or directory prefix. Used to detect when concurrent tasks would write
 * to the same files and need to be serialized.
 * Empty arrays mean "no restriction" and are treated as non-overlapping so
 * unrestricted tasks don't block each other unnecessarily.
 */
function scopesOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  for (const pa of a) {
    const na = pa.replace(/\/?\*\*$/, "").replace(/\/$/, "");
    for (const pb of b) {
      const nb = pb.replace(/\/?\*\*$/, "").replace(/\/$/, "");
      if (na === nb || na.startsWith(nb + "/") || nb.startsWith(na + "/"))
        return true;
    }
  }
  return false;
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
  for (let i = start; i < tiers.length; i++) {
    const m = routing.byDifficulty[tiers[i]!];
    if (m && !chain.includes(m)) chain.push(m);
  }
  return chain;
}

export class Orchestrator implements Scheduler {
  private paused = false;
  private readonly activeTaskIds = new Set<string>();
  private readonly taskAbortControllers = new Map<string, AbortController>();
  private readonly modelActiveCount = new Map<ModelId, number>();
  /** Tasks already logged as budget-blocked this run, to avoid log spam. */
  private readonly budgetBlockedWarned = new Set<string>();
  private currentTasks: Task[] = [];

  constructor(private readonly deps: SchedulerDeps) {}

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
    this.currentTasks = tasks;
    this.budgetBlockedWarned.clear();

    // Orphan recovery: this Orchestrator instance starts with empty
    // activeTaskIds, so any task already in "in_progress" was left mid-run by
    // a previous process (crash, restart, deploy) — nothing is actually
    // working on it. Requeue it as backlog so the scheduler retries it
    // instead of silently stalling forever (it would never appear in
    // readyTasks() and would permanently block every task that depends on it).
    for (const task of tasks) {
      if (task.status === "in_progress") {
        this.emit(
          "warn",
          "engine",
          `Recovering orphaned task (was in_progress with no active run): ${task.title}`,
          task.id,
        );
        task.status = "backlog";
        this.deps.events.onTaskUpdated(task);
      }
    }

    this.emit("info", "engine", "Orchestrator starting", "");

    while (!this.paused) {
      const ready = this.readyTasks(tasks);

      if (ready.length === 0 && this.activeTaskIds.size === 0) {
        break;
      }

      // Collect scope paths of all currently running tasks for overlap detection.
      const activeScopePaths = [...this.activeTaskIds].flatMap(
        (id) => this.currentTasks.find((t) => t.id === id)?.scopePaths ?? [],
      );

      let dispatched = 0;
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

        const active =
          this.modelActiveCount.get(task.assignedModel) ?? 0;
        if (active >= cfg.maxConcurrent) continue;

        this.modelActiveCount.set(task.assignedModel, active + 1);
        this.activeTaskIds.add(task.id);
        dispatched++;

        this.executeTask(project, task).finally(() => {
          this.modelActiveCount.set(
            task.assignedModel,
            (this.modelActiveCount.get(task.assignedModel) ?? 1) - 1,
          );
          this.activeTaskIds.delete(task.id);
        });
      }

      if (dispatched === 0 && this.activeTaskIds.size > 0) {
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

  async pause(_project: Project): Promise<void> {
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
        task.status === "in_progress" &&
        this.activeTaskIds.has(task.id)
      ) {
        task.status = "backlog";
        this.deps.events.onTaskUpdated(task);
      }
    }

    this.emit("info", "engine", "Orchestrator paused", "");
  }

  /** Run a single task through the full pipeline (manual dispatch). */
  async runTask(project: Project, task: Task): Promise<void> {
    this.paused = false;
    await this.executeTask(project, task);
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

        // Stop spending mid-task if a budget cap has since been hit.
        const budgetMsg = this.deps.checkBudget?.(task.assignedModel) ?? null;
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
        if (authorResult === null) return;

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
        // between main and <branch>". The usual cause is the agent writing files
        // outside its worktree (e.g. resolving the wrong project root).
        const changed = await this.deps.worktrees.changedFiles(project, task);
        if (changed.length === 0) {
          this.emit(
            "error",
            "engine",
            `Author produced no changes in the worktree (${path}). ` +
              `Nothing to commit/PR — check that the agent wrote into the worktree, not elsewhere.`,
            task.id,
          );
          task.status = "failed";
          this.deps.events.onTaskUpdated(task);
          return;
        }

        await this.deps.git.push(path, branch);

        if (task.attempts === 1 && task.prNumber == null) {
          task.prNumber = await this.deps.git.openPr(project, task);
          this.deps.events.onTaskUpdated(task);
        }

        const gateResult = await this.deps.gates.run(project, task);
        finalGate = gateResult;

        const gatesPassed =
          gateResult.typecheck &&
          gateResult.lint &&
          gateResult.build &&
          gateResult.tests &&
          gateResult.noConflicts &&
          gateResult.inScope;

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

        const decision = await this.deps.validator.review(
          project,
          task,
          gateResult,
        );
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

      const canMerge = await this.canAutoMerge(project, task, finalGate!);
      if (canMerge) {
        await this.deps.git.mergePr(project, task.prNumber!);
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
            runId: "",
            taskId: task.id,
            ts: new Date().toISOString(),
            level: "debug",
            source: "agent",
            message: line,
          });
        },
      });

      this.emitRunEvent(task, result, "passed", model);
      return result;
    } catch (err: unknown) {
      if (
        (err as Error).name === "AbortError" ||
        controller.signal.aborted
      ) {
        if (this.paused) {
          this.emitRunEvent(task, null, "stopped", model);
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
        this.emitRunEvent(task, stuckResult, "failed", model);
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
    model?: ModelId,
  ): void {
    const run: Run = {
      id: `run-${task.id}-${task.attempts}`,
      taskId: task.id,
      model: model ?? task.assignedModel,
      attempt: task.attempts,
      status,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
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
    const { mergePolicy, riskyChangeRules } = this.deps.settings;

    if (mergePolicy === "fully_autonomous") return true;
    if (mergePolicy === "always_ask") return false;

    // hard_gate_flag_risky: auto-merge unless a risky-change rule trips.
    if (riskyChangeRules.outOfScopeEdits && !gate.inScope) return false;

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
      files.some((f) => /\.env|auth|secret|credential|token/i.test(f))
    ) {
      this.emit("warn", "engine", "Risky: auth/secret change detected", task.id);
      return false;
    }

    return true;
  }
}
