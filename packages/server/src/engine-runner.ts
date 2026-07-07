import {
  GateRunnerImpl,
  GitServiceImpl,
  Orchestrator,
  ValidatorImpl,
  WorktreeManagerImpl,
  type SchedulerDeps,
} from "@orc/engine";
import { makeAdapter, type AgentAdapter } from "@orc/adapters";
import type { ModelId, Project, RunSummaryDetail } from "@orc/types";
import { ENV, defaultSettings } from "./config";
import type { Db } from "./db/index";
import * as repo from "./db/repo";
import type { WsHub } from "./ws-hub";
import { checkBudget, checkBudgetThresholds, checkModelQuota } from "./budget";
import type { ServerNotifier } from "./telegram";

function fmtDurationMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${totalMinutes % 60}m`;
}

/**
 * F8's Telegram digest — the end-of-run "info" push upgraded from one line
 * to an actual report card. Exported (and kept a pure function of its
 * inputs) so it's directly unit-testable without spinning up a whole
 * EngineRunner, matching the pattern F6's classifyFailure established.
 */
export function formatRunSummaryMessage(
  projectName: string,
  s: RunSummaryDetail,
): string {
  const icon = s.finalStatus === "completed" ? "🏁" : "⚠️";
  const lines = [
    `${icon} ${projectName} ${s.finalStatus} — ${fmtDurationMs(s.durationMs)}`,
    `✅ ${s.tasksDone} done · ❌ ${s.tasksFailed} failed · $${s.totalCostUsd.toFixed(4)} spent`,
  ];

  if (s.prLinks.length > 0) {
    lines.push("", "PRs merged:");
    for (const pr of s.prLinks) {
      lines.push(`- ${pr.title} (#${pr.prNumber}): ${pr.url}`);
    }
  }

  if (s.approvalsRequired > 0) {
    lines.push("", `⏸ ${s.approvalsRequired} approval(s) were required this run`);
  }

  if (s.topFailureReasons.length > 0) {
    lines.push("", "Top issues:");
    for (const reason of s.topFailureReasons) {
      lines.push(`- ${reason}`);
    }
  }

  return lines.join("\n");
}

/**
 * Bridges the engine to the server: builds SchedulerDeps whose events persist to
 * SQLite and broadcast over the WebSocket, runs the Orchestrator in the
 * background per project, and resolves human approvals coming back from the UI
 * or Telegram.
 */
export class EngineRunner {
  private readonly orchestrators = new Map<string, Orchestrator>();
  /**
   * Tracks in-flight manual dispatches (dispatchOne/runTask), keyed by
   * projectId -> taskId -> the one-off Orchestrator running it. Each of
   * these spins up its own Orchestrator with an empty `activeTaskIds`,
   * sharing none of the autonomous loop's in-flight state — without this map
   * neither `start()` nor `stopTask()` can see them at all: `start()` would
   * boot the autonomous loop right on top of a manual dispatch (orphan
   * recovery would requeue the "in_progress" task with no active run in ITS
   * memory -> two agents on the same branch/worktree), and `stopTask()`
   * could never reach a manually-dispatched task's process. (Note: unlike
   * `activeTaskIds`, per-model concurrency accounting IS shared across every
   * Orchestrator this class builds — see `modelActiveCount` below. B19:
   * manual dispatch's own `runTask` path bypasses the dispatch-loop's
   * maxConcurrent CHECK entirely — a human's explicit dispatch is never
   * capacity-blocked — but it DOES increment/decrement the same shared
   * count around the run, so the autonomous loop and other projects can see
   * it and won't pile maxConcurrent MORE copies of the model on top of it.)
   */
  private readonly manualRuns = new Map<string, Map<string, Orchestrator>>();
  private readonly pendingApprovals = new Map<string, (choice: string) => void>();
  /** Optional second channel (Telegram). Set after construction. */
  private notifier?: ServerNotifier;

  /**
   * F6: model id -> cooldown expiry (ms epoch), set when an adapter run
   * fails with exitReason "rate_limited" (see @orc/adapters' classifyFailure).
   * Consulted by every project's Orchestrator via checkModelCooldown below —
   * cross-project, since a rate limit on a model's API key applies globally,
   * not per-project.
   */
  private readonly coolingDown = new Map<ModelId, number>();
  private static readonly COOLDOWN_MS = 5 * 60 * 1000;

  /**
   * F12: per-model in-flight dispatch counts, shared across every project's
   * Orchestrator (wired in via SchedulerDeps.getModelActive/incModelActive/
   * decModelActive in buildOrchestrator below) so `ModelConfig.maxConcurrent`
   * is a true global cap. Before this, each project built its own Orchestrator
   * with its own private count, so two concurrently-running projects could
   * each dispatch up to `maxConcurrent` copies of the same model at once.
   */
  private readonly modelActiveCount = new Map<ModelId, number>();

  // Buffered log writer: agent runs stream hundreds of lines; writing each one
  // synchronously to SQLite (+ broadcasting) froze the event loop. We queue
  // them and flush in one transaction every ~300ms.
  private logQueue: Parameters<typeof repo.createLogs>[1] = [];
  private logFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly LOG_FLUSH_MS = 300;

  constructor(
    private readonly db: Db,
    private readonly hub: WsHub,
  ) {}

  private enqueueLog(e: Parameters<typeof repo.createLog>[1]): void {
    this.logQueue.push(e);
    // Flush sooner if the buffer grows large (a very chatty run), so memory
    // and UI latency stay bounded.
    if (this.logQueue.length >= 200) {
      this.flushLogs();
      return;
    }
    if (!this.logFlushTimer) {
      this.logFlushTimer = setTimeout(() => this.flushLogs(), EngineRunner.LOG_FLUSH_MS);
    }
  }

  private flushLogs(): void {
    if (this.logFlushTimer) {
      clearTimeout(this.logFlushTimer);
      this.logFlushTimer = null;
    }
    if (this.logQueue.length === 0) return;
    const batch = this.logQueue;
    this.logQueue = [];
    try {
      const saved = repo.createLogs(this.db, batch);
      for (const log of saved) {
        this.hub.broadcast({ type: "log", payload: log });
      }
    } catch {
      /* a dropped log batch must never break the run */
    }
  }

  /** Wire an extra notifier (Telegram) for approvals + status pushes. */
  setNotifier(n: ServerNotifier | undefined): void {
    this.notifier = n;
  }

  /**
   * F7: checks project + global monthly spend against the 50%/80% soft
   * thresholds and pushes (WS notification + Telegram) any newly crossed
   * one, recording it so it only fires once. Called right after every cost
   * record is created, from all three places one gets created (author run,
   * validator run, planner spend).
   */
  checkAndPushBudgetAlerts(projectId: string): void {
    const settings = repo.getSettings(this.db) ?? defaultSettings();
    const alerts = checkBudgetThresholds(this.db, projectId, settings);
    for (const alert of alerts) {
      const notif = repo.createNotification(this.db, {
        projectId,
        severity: "warn",
        title: `Budget alert: ${alert.threshold}%`,
        message: alert.message,
        requiresApproval: false,
      });
      this.hub.broadcast({ type: "notification", payload: notif });
      this.notifier?.info(`⚠️ ${alert.message}`);
      repo.recordBudgetAlert(this.db, alert.scope, alert.threshold);
    }
  }

  /** Returns a reason string while `modelId` is cooling down, else null —
   *  wired into every Orchestrator as SchedulerDeps.checkModelCooldown. */
  checkModelCooldown(modelId: ModelId): string | null {
    const until = this.coolingDown.get(modelId);
    if (!until) return null;
    if (until <= Date.now()) {
      this.coolingDown.delete(modelId);
      return null;
    }
    return `rate-limited, cooling down for ~${Math.ceil((until - Date.now()) / 60_000)}m more`;
  }

  /** For the model-health panel (F6) — current cooldown expiry, if any. */
  getCoolingDownUntil(modelId: ModelId): number | undefined {
    const until = this.coolingDown.get(modelId);
    return until && until > Date.now() ? until : undefined;
  }

  isRunning(projectId: string): boolean {
    return this.orchestrators.has(projectId);
  }

  /** True while a manually-dispatched task is in flight for this project —
   *  callers must refuse to start the autonomous loop until it clears. */
  hasManualRun(projectId: string): boolean {
    return (this.manualRuns.get(projectId)?.size ?? 0) > 0;
  }

  /**
   * Request that an active task stop. Checks the autonomous-loop orchestrator
   * first, then falls back to a manually-dispatched task's own one-off
   * orchestrator via manualRuns. Returns true if a live orchestrator actually
   * found and aborted the task.
   */
  stopTask(projectId: string, taskId: string): boolean {
    const orch = this.orchestrators.get(projectId);
    if (orch?.stopTask(taskId)) return true;
    const manual = this.manualRuns.get(projectId)?.get(taskId);
    return manual?.stopTask(taskId) ?? false;
  }

  /** Resolve a human approval requested via events.requestApproval. */
  resolveApproval(notificationId: string, choice: string): boolean {
    const resolver = this.pendingApprovals.get(notificationId);
    if (!resolver) return false;
    this.pendingApprovals.delete(notificationId);
    resolver(choice);
    return true;
  }

  private buildOrchestrator(project: Project): Orchestrator {
    const settings = repo.getSettings(this.db);
    if (!settings) throw new Error("settings not found");

    const adapterFor = (modelId: ModelId): AgentAdapter => {
      const cfg = settings.models.find((m) => m.id === modelId);
      if (!cfg) throw new Error(`no ModelConfig for ${modelId}`);
      return makeAdapter(cfg, ENV.opencodeBaseUrl);
    };

    const worktrees = new WorktreeManagerImpl();
    const git = new GitServiceImpl();
    const gates = new GateRunnerImpl(worktrees);
    // Record validator spend: validation runs aren't author runs, so they have
    // no run row — without this their cost never reaches the costs table.
    const validator = new ValidatorImpl(
      adapterFor,
      settings,
      (model, taskId, costUsd, tokensIn, tokensOut) => {
        const cost = repo.createCost(this.db, {
          projectId: project.id,
          model,
          taskId,
          costUsd,
          tokensIn,
          tokensOut,
          ts: new Date().toISOString(),
        });
        this.hub.broadcast({ type: "cost.updated", payload: cost });
        this.checkAndPushBudgetAlerts(project.id);
      },
    );

    const deps: SchedulerDeps = {
      worktrees,
      git,
      gates,
      validator,
      settings,
      adapterFor,
      opencodeBaseUrl: ENV.opencodeBaseUrl,
      getTasks: () => repo.getTasks(this.db, project.id),
      checkBudget: (modelId) => checkBudget(this.db, project.id, modelId, settings),
      checkModelCooldown: (modelId) => this.checkModelCooldown(modelId),
      checkModelQuota: (modelId) => checkModelQuota(this.db, modelId, settings),
      getModelActive: (modelId) => this.modelActiveCount.get(modelId) ?? 0,
      incModelActive: (modelId) =>
        this.modelActiveCount.set(modelId, (this.modelActiveCount.get(modelId) ?? 0) + 1),
      decModelActive: (modelId) =>
        this.modelActiveCount.set(
          modelId,
          Math.max(0, (this.modelActiveCount.get(modelId) ?? 0) - 1),
        ),
      events: {
        onLog: (e) => this.enqueueLog(e),
        onTaskUpdated: (t) => {
          const prev = repo.getTask(this.db, t.id);
          repo.updateTask(this.db, t.id, {
            status: t.status,
            attempts: t.attempts,
            // Model-fallback escalation bumps maxAttempts in memory mid-run
            // (one extra attempt per fallback model) — persist it, otherwise
            // the kanban card shows attempts > maxAttempts (e.g. "4/3").
            maxAttempts: t.maxAttempts,
            branch: t.branch,
            worktreePath: t.worktreePath,
            prNumber: t.prNumber,
          });
          this.hub.broadcast({
            type: "task.updated",
            payload: repo.getTask(this.db, t.id) ?? t,
          });
          // F5: settings.telegram.digest controls how much of this reaches
          // Telegram. "terminal" (default/unset) = done/failed only (the
          // original behavior); "all" also pushes every intermediate status
          // change; "off" suppresses task-status pushes entirely. The audit
          // log entry for a terminal transition is unconditional either way
          // — it's a permanent record, not chatter.
          if (prev?.status !== t.status) {
            const isTerminal = t.status === "done" || t.status === "failed";
            const digest = settings.telegram?.digest ?? "terminal";
            const shouldPush =
              digest !== "off" && (isTerminal || digest === "all");
            const costUsd =
              shouldPush || isTerminal
                ? repo.getRuns(this.db, t.id).reduce((sum, r) => sum + r.costUsd, 0)
                : 0;

            if (shouldPush) {
              this.notifier?.taskStatus({
                title: t.title,
                status: t.status,
                difficulty: t.difficulty,
                assignedModel: t.assignedModel,
                attempts: t.attempts,
                maxAttempts: t.maxAttempts,
                summary: t.description.split("\n")[0],
                costUsd,
                prNumber: t.prNumber,
                prUrl: t.prNumber ? `${project.repoUrl}/pull/${t.prNumber}` : undefined,
              });
            }

            if (isTerminal) {
              repo.createAuditEntry(this.db, {
                projectId: project.id,
                taskId: t.id,
                kind: t.status === "done" ? "task_done" : "task_failed",
                actor: "engine",
                summary: `${t.title} → ${t.status}${t.prNumber ? ` (PR #${t.prNumber})` : ""}`,
                detail: { attempts: t.attempts, prNumber: t.prNumber, costUsd },
              });
            }
          }
        },
        onRunUpdated: (r) => {
          if (repo.getRun(this.db, r.id)) repo.updateRun(this.db, r.id, r);
          else repo.createRun(this.db, r);
          if (r.exitReason === "rate_limited") {
            this.coolingDown.set(r.model, Date.now() + EngineRunner.COOLDOWN_MS);
            this.logError(
              project.id,
              `${r.model} looks rate-limited — cooling down for ${EngineRunner.COOLDOWN_MS / 60_000}m`,
            );
          }
          if (r.costUsd > 0) {
            const cost = repo.createCost(this.db, {
              projectId: project.id,
              model: r.model,
              taskId: r.taskId,
              runId: r.id,
              costUsd: r.costUsd,
              tokensIn: r.tokensIn,
              tokensOut: r.tokensOut,
              ts: new Date().toISOString(),
            });
            this.hub.broadcast({ type: "cost.updated", payload: cost });
            this.checkAndPushBudgetAlerts(project.id);
          }
          this.hub.broadcast({
            type: "run.updated",
            payload: repo.getRun(this.db, r.id) ?? r,
          });
        },
        onMergeDecision: (d) => {
          repo.createMergeDecision(this.db, d);
          repo.createAuditEntry(this.db, {
            projectId: project.id,
            taskId: d.taskId,
            kind: "merge_decision",
            actor: `validator:${d.validatorModel}`,
            summary: `${d.verdict} (confidence ${d.confidence.toFixed(2)})`,
            detail: { reasons: d.reasons, gate: d.gate },
          });
          this.hub.broadcast({ type: "merge.decision", payload: d });
        },
        onModelTrouble: (info) => {
          repo.createAuditEntry(this.db, {
            projectId: project.id,
            taskId: info.taskId,
            kind: "model_trouble",
            actor: "engine",
            summary: `${info.model} — ${info.event}: ${info.detail}`,
            detail: { event: info.event, model: info.model },
          });
          // F32: default true (unset counts as enabled) — the owner
          // explicitly asked to be alerted on these, independent of the
          // task-status `digest` setting.
          if (settings.telegram?.modelAlerts !== false) {
            this.notifier?.modelTrouble({
              projectName: project.name,
              taskTitle: info.taskTitle,
              model: info.model,
              event: info.event,
              detail: info.detail,
            });
          }
        },
        requestApproval: (args) => {
          // F5/F22: give the human enough to decide without opening the app
          // (or, on the web, without hunting the Board for the task's
          // drawer) — the PR to look at and why the validator flagged it.
          // Computed once, before the notification is created, so both
          // Telegram and the persisted (web-visible) notification carry the
          // exact same context from one source.
          const approvalTask = repo.getTask(this.db, args.taskId);
          const prUrl =
            approvalTask?.prNumber != null
              ? `${project.repoUrl}/pull/${approvalTask.prNumber}`
              : undefined;
          const latestDecision = repo.getMergeDecisions(this.db, args.taskId)[0];
          const context =
            prUrl || latestDecision?.reasons?.length
              ? { prUrl, reasons: latestDecision?.reasons }
              : undefined;
          const notif = repo.createNotification(this.db, {
            projectId: project.id,
            taskId: args.taskId,
            severity: "action_required",
            title: args.title,
            message: args.message,
            requiresApproval: true,
            options: args.options,
            context,
          });
          repo.createAuditEntry(this.db, {
            projectId: project.id,
            taskId: args.taskId,
            kind: "approval_requested",
            actor: "engine",
            summary: args.title,
            detail: { message: args.message, options: args.options },
          });
          this.hub.broadcast({ type: "notification", payload: notif });
          this.notifier?.approvalRequested(notif, { prUrl, reasons: latestDecision?.reasons });
          return new Promise<string>((resolve) => {
            this.pendingApprovals.set(notif.id, resolve);
          });
        },
      },
    };

    return new Orchestrator(deps);
  }

  private logError(projectId: string, message: string): void {
    const log = repo.createLog(this.db, {
      projectId,
      runId: "",
      taskId: "",
      ts: new Date().toISOString(),
      level: "error",
      source: "engine",
      message,
    });
    this.hub.broadcast({ type: "log", payload: log });
  }

  /** Run the whole project DAG autonomously in the background. */
  async start(project: Project): Promise<void> {
    if (this.orchestrators.has(project.id)) return;
    if (this.hasManualRun(project.id)) {
      throw new Error(
        "a task is being dispatched manually — wait for it to finish (or stop it) before starting the autonomous run",
      );
    }
    const orch = this.buildOrchestrator(project);
    this.orchestrators.set(project.id, orch);
    const runStartedAt = new Date().toISOString();

    void (async () => {
      try {
        const git = new GitServiceImpl();
        await git.ensureClone(project);
        const tasks = repo.getTasks(this.db, project.id);
        await orch.start(project, tasks);
      } catch (err) {
        this.logError(
          project.id,
          `Orchestrator crashed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        this.orchestrators.delete(project.id);
        this.flushLogs(); // write out any buffered tail logs from this run

        // Reflect what actually happened, not "completed" by default. The
        // orchestrator's run loop also exits when it simply runs out of
        // dispatchable work (e.g. every remaining task is blocked on a failed
        // dependency, or budget-capped) — that is NOT the same as every task
        // having finished successfully, and calling it "completed" hid a
        // stuck board behind a status that looked fine.
        const finalTasks = repo.getTasks(this.db, project.id);
        const allDone = finalTasks.every((t) => t.status === "done");
        const stillPending = finalTasks.some(
          (t) =>
            t.status === "backlog" ||
            t.status === "ready" ||
            t.status === "in_progress" ||
            t.status === "in_review",
        );
        const anyFailed = finalTasks.some((t) => t.status === "failed");
        const finalStatus = allDone
          ? "completed"
          : stillPending
            ? "paused" // resumable: hit a budget cap or every ready task is blocked
            : anyFailed
              ? "failed"
              : "completed";

        repo.updateProject(this.db, project.id, { status: finalStatus });
        if (finalStatus !== "completed") {
          const blocked = finalTasks.filter((t) => t.status !== "done");
          this.logError(
            project.id,
            `Run ended (${finalStatus}) with ${blocked.length} task(s) not done: ` +
              blocked.map((t) => `${t.title} [${t.status}]`).join(", "),
          );
        }

        const fresh = repo.getProject(this.db, project.id);
        if (fresh) this.hub.broadcast({ type: "project.updated", payload: fresh });

        // F8: the "get updates" feature for away-from-keyboard autonomy — a
        // report card for this specific start-to-finish cycle (not the
        // project's lifetime totals), persisted so AuditView can show past
        // runs and pushed as a real digest instead of one terse line.
        this.pushRunSummary(project, runStartedAt, finalStatus);
      }
    })();
  }

  /** Builds and persists this run's report card (F8), then pushes it to
   *  Telegram as a multi-line digest. */
  private pushRunSummary(
    project: Project,
    runStartedAt: string,
    finalStatus: string,
  ): void {
    const endedAt = new Date().toISOString();
    const durationMs = new Date(endedAt).getTime() - new Date(runStartedAt).getTime();
    const totalCostUsd = repo.getCostSince(this.db, project.id, runStartedAt);

    // Scope every count to what actually happened during THIS run, not the
    // project's all-time history — audit entries are the natural source
    // since every terminal transition already writes one.
    const sinceRun = repo
      .getAuditLog(this.db, project.id)
      .filter((e) => e.ts >= runStartedAt);
    const doneEntries = sinceRun.filter((e) => e.kind === "task_done");
    const failedEntries = sinceRun.filter((e) => e.kind === "task_failed");
    const approvalsRequired = sinceRun.filter(
      (e) => e.kind === "approval_requested",
    ).length;

    const prLinks = doneEntries.flatMap((e) => {
      const prNumber = e.detail?.prNumber as number | undefined;
      if (!prNumber || !e.taskId) return [];
      return [
        {
          taskId: e.taskId,
          title: e.summary.split(" → ")[0] ?? e.summary,
          prNumber,
          url: `${project.repoUrl}/pull/${prNumber}`,
        },
      ];
    });

    // "Why" for each failed task: the most recent validator verdict's top
    // reason, if it went through review at all — otherwise just the task
    // title, since a task can fail before ever reaching the validator (e.g.
    // exhausted attempts on author errors).
    const topFailureReasons = failedEntries.slice(0, 5).map((e) => {
      const title = e.summary.split(" → ")[0] ?? e.summary;
      const reason = e.taskId
        ? repo.getMergeDecisions(this.db, e.taskId)[0]?.reasons[0]
        : undefined;
      return reason ? `${title}: ${reason}` : title;
    });

    const summary: RunSummaryDetail = {
      startedAt: runStartedAt,
      endedAt,
      durationMs,
      finalStatus,
      tasksDone: doneEntries.length,
      tasksFailed: failedEntries.length,
      totalCostUsd,
      prLinks,
      approvalsRequired,
      topFailureReasons,
    };

    repo.createAuditEntry(this.db, {
      projectId: project.id,
      kind: "run_summary",
      actor: "engine",
      summary: `Run ${finalStatus}: ${summary.tasksDone} done, ${summary.tasksFailed} failed, $${totalCostUsd.toFixed(4)} spent`,
      detail: summary as unknown as Record<string, unknown>,
    });

    this.notifier?.info(formatRunSummaryMessage(project.name, summary));
  }

  /** Run a single task through the full pipeline (manual dispatch). */
  async dispatchOne(project: Project, taskId: string): Promise<void> {
    const orch = this.buildOrchestrator(project);

    let projectRuns = this.manualRuns.get(project.id);
    if (!projectRuns) {
      projectRuns = new Map();
      this.manualRuns.set(project.id, projectRuns);
    }
    projectRuns.set(taskId, orch);

    void (async () => {
      try {
        const git = new GitServiceImpl();
        await git.ensureClone(project);
        const task = repo.getTask(this.db, taskId);
        if (!task) throw new Error(`task ${taskId} not found`);
        await orch.runTask(project, task);
      } catch (err) {
        this.logError(
          project.id,
          `Dispatch of ${taskId} crashed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        const runs = this.manualRuns.get(project.id);
        runs?.delete(taskId);
        if (runs && runs.size === 0) this.manualRuns.delete(project.id);
      }
    })();
  }

  async pause(project: Project, opts: { drain?: boolean } = {}): Promise<void> {
    const orch = this.orchestrators.get(project.id);
    if (!orch) return;
    await orch.pause(project, opts);
    // Hard stop: pause() already aborted/requeued everything and start()'s
    // loop has already exited by the time this returns, so it's safe to drop
    // the registration now. Drain: start()'s background loop (below) is
    // still running, waiting for active tasks to finish — its own `finally`
    // deletes this entry once that's genuinely done. Deleting it here too
    // would let a second Start race in while tasks are still draining.
    if (!opts.drain) {
      this.orchestrators.delete(project.id);
    }
  }

  /**
   * F23: the global "Stop all" panic button — hard-aborts every currently
   * running project, both the autonomous loop (via pause({drain:false}),
   * the same path the per-project Stop now button uses) *and* any
   * manually-dispatched task in flight for it (B19: `manualRuns` is a
   * separate execution path pause() alone never touches — a plain
   * pause-everything here would silently leave a manual dispatch running).
   * Returns the ids of projects that actually had something to stop.
   */
  async stopAll(projects: Project[]): Promise<string[]> {
    const stopped: string[] = [];
    for (const project of projects) {
      const wasRunning = this.isRunning(project.id);
      const manualTaskIds = [...(this.manualRuns.get(project.id)?.keys() ?? [])];
      if (!wasRunning && manualTaskIds.length === 0) continue;
      if (wasRunning) await this.pause(project, { drain: false });
      for (const taskId of manualTaskIds) this.stopTask(project.id, taskId);
      stopped.push(project.id);
    }
    return stopped;
  }

  /** Revert a merged PR on the project's default branch (one-click rollback). */
  async rollback(project: Project, prNumber: number): Promise<void> {
    const git = new GitServiceImpl();
    await git.ensureClone(project);
    await git.revertMerge(project, prNumber);
  }
}
