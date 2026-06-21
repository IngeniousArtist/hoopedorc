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
  private readonly pendingApprovals = new Map<string, (choice: string) => void>();
  /** Optional second channel (Telegram). Set after construction. */
  private notifier?: ServerNotifier;

  constructor(
    private readonly db: Db,
    private readonly hub: WsHub,
  ) {}

  /** Wire an extra notifier (Telegram) for approvals + status pushes. */
  setNotifier(n: ServerNotifier | undefined): void {
    this.notifier = n;
  }

  isRunning(projectId: string): boolean {
    return this.orchestrators.has(projectId);
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
    const validator = new ValidatorImpl(adapterFor, settings);

    const deps: SchedulerDeps = {
      worktrees,
      git,
      gates,
      validator,
      settings,
      adapterFor,
      opencodeBaseUrl: ENV.opencodeBaseUrl,
      checkBudget: (modelId) => checkBudget(this.db, project.id, modelId, settings),
      events: {
        onLog: (e) => {
          const log = repo.createLog(this.db, e);
          this.hub.broadcast({ type: "log", payload: log });
        },
        onTaskUpdated: (t) => {
          const prev = repo.getTask(this.db, t.id);
          repo.updateTask(this.db, t.id, {
            status: t.status,
            attempts: t.attempts,
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
            this.notifier?.taskStatus(
              t.title,
              t.status,
              t.prNumber ? `PR #${t.prNumber}` : undefined,
            );
            repo.createAuditEntry(this.db, {
              projectId: project.id,
              taskId: t.id,
              kind: t.status === "done" ? "task_done" : "task_failed",
              actor: "engine",
              summary: `${t.title} → ${t.status}${t.prNumber ? ` (PR #${t.prNumber})` : ""}`,
              detail: { attempts: t.attempts, prNumber: t.prNumber },
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
        repo.updateProject(this.db, project.id, { status: "completed" });
        const fresh = repo.getProject(this.db, project.id);
        if (fresh) this.hub.broadcast({ type: "project.updated", payload: fresh });
        const { totalUsd } = repo.getCostSummary(this.db, project.id);
        this.notifier?.info(
          `🏁 ${project.name} finished. Total spend $${totalUsd.toFixed(4)}.`,
        );
      }
    })();
  }

  /** Run a single task through the full pipeline (manual dispatch). */
  async dispatchOne(project: Project, taskId: string): Promise<void> {
    const orch = this.buildOrchestrator(project);
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
