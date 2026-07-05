import {
  GateRunnerImpl,
  GitServiceImpl,
  Orchestrator,
  ValidatorImpl,
  WorktreeManagerImpl,
  type SchedulerDeps,
} from "@orc/engine";
import { makeAdapter, type AgentAdapter } from "@orc/adapters";
import type { ModelId, Project } from "@orc/types";
import { ENV } from "./config";
import type { Db } from "./db/index";
import * as repo from "./db/repo";
import type { WsHub } from "./ws-hub";
import { checkBudget } from "./budget";
import type { ServerNotifier } from "./telegram";

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
   * these spins up its own Orchestrator with empty activeTaskIds/
   * modelActiveCount, sharing none of the autonomous loop's in-flight state —
   * without this map neither `start()` nor `stopTask()` can see them at all:
   * `start()` would boot the autonomous loop right on top of a manual
   * dispatch (orphan recovery would requeue the "in_progress" task with no
   * active run in ITS memory -> two agents on the same branch/worktree), and
   * `stopTask()` could never reach a manually-dispatched task's process.
   */
  private readonly manualRuns = new Map<string, Map<string, Orchestrator>>();
  private readonly pendingApprovals = new Map<string, (choice: string) => void>();
  /** Optional second channel (Telegram). Set after construction. */
  private notifier?: ServerNotifier;

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
          // Push terminal transitions to Telegram + audit log (once).
          if (
            prev?.status !== t.status &&
            (t.status === "done" || t.status === "failed")
          ) {
            const costUsd = repo
              .getRuns(this.db, t.id)
              .reduce((sum, r) => sum + r.costUsd, 0);
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
            repo.createAuditEntry(this.db, {
              projectId: project.id,
              taskId: t.id,
              kind: t.status === "done" ? "task_done" : "task_failed",
              actor: "engine",
              summary: `${t.title} → ${t.status}${t.prNumber ? ` (PR #${t.prNumber})` : ""}`,
              detail: { attempts: t.attempts, prNumber: t.prNumber, costUsd },
            });
          }
        },
        onRunUpdated: (r) => {
          if (repo.getRun(this.db, r.id)) repo.updateRun(this.db, r.id, r);
          else repo.createRun(this.db, r);
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
        requestApproval: (args) => {
          const notif = repo.createNotification(this.db, {
            projectId: project.id,
            taskId: args.taskId,
            severity: "action_required",
            title: args.title,
            message: args.message,
            requiresApproval: true,
            options: args.options,
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
          this.notifier?.approvalRequested(notif);
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
        const { totalUsd } = repo.getCostSummary(this.db, project.id);
        this.notifier?.info(
          finalStatus === "completed"
            ? `🏁 ${project.name} finished. Total spend $${totalUsd.toFixed(4)}.`
            : `⚠️ ${project.name} stopped (${finalStatus}) with unfinished tasks. Total spend $${totalUsd.toFixed(4)}.`,
        );
      }
    })();
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

  async pause(project: Project): Promise<void> {
    const orch = this.orchestrators.get(project.id);
    if (!orch) return;
    await orch.pause(project);
    this.orchestrators.delete(project.id);
  }

  /** Revert a merged PR on the project's default branch (one-click rollback). */
  async rollback(project: Project, prNumber: number): Promise<void> {
    const git = new GitServiceImpl();
    await git.ensureClone(project);
    await git.revertMerge(project, prNumber);
  }
}
