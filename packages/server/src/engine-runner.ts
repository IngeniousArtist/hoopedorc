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

/**
 * Bridges the engine to the server: builds SchedulerDeps whose events persist to
 * SQLite and broadcast over the WebSocket, runs the Orchestrator in the
 * background per project, and resolves human approvals coming back from the UI
 * or Telegram.
 */
export class EngineRunner {
  private readonly orchestrators = new Map<string, Orchestrator>();
  private readonly pendingApprovals = new Map<string, (choice: string) => void>();

  constructor(
    private readonly db: Db,
    private readonly hub: WsHub,
  ) {}

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
          this.hub.broadcast({ type: "notification", payload: notif });
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
}
