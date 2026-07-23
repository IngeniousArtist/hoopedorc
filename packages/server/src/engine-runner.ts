import {
  GateRunnerImpl,
  GitServiceImpl,
  Orchestrator,
  RollbackConflictError,
  ValidatorImpl,
  WorktreeManagerImpl,
  type GateRunner,
  type GitService,
  type SchedulerDeps,
  type Validator,
  type WorktreeManager,
} from "@orc/engine";
import { makeAdapter, type AgentAdapter } from "@orc/adapters";
import type {
  FigmaCapabilityIssue,
  ModelId,
  ModelInvocation,
  Project,
  RollbackJob,
  RunSummaryDetail,
  Settings,
  Task,
} from "@orc/types";
import { ENV, defaultSettings } from "./config";
import type { Db } from "./db/index";
import * as repo from "./db/repo";
import type { WsHub } from "./ws-hub";
import { checkBudget, checkBudgetThresholds, checkModelQuota } from "./budget";
import { manualCostUsd } from "./pricing";
import { planningPersistenceError } from "./planning-commit";
import { persistInvocationEvent } from "./invocation-ledger";
import type { ServerNotifier } from "./telegram";
import {
  FIGMA_AUTHOR_ACTIONS,
  FigmaVerificationError,
  verifyFigmaReferences,
  type PlannerModel,
} from "./planner.js";
import { extractFigmaReferencesFromText } from "./figma-references.js";

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

export type ProjectRuntimeState =
  | "starting"
  | "running"
  | "draining"
  | "stopping";

interface ProjectRuntime {
  readonly generation: number;
  readonly orchestrator: Orchestrator;
  state: ProjectRuntimeState;
  /** Set when this runtime is autonomous from creation or is promoted from
   * a manual-priority runtime by Start. Absent means only persisted manual
   * requests are eligible for dispatch. */
  autonomousStartedAt?: string;
  settled: Promise<void>;
}

export interface EngineRunnerOptions {
  /** Test seam for deterministic lifecycle/race tests. */
  orchestratorFactory?: (project: Project) => Orchestrator;
  /** Test seam that avoids a real clone while retaining the production order. */
  ensureClone?: (project: Project) => Promise<void>;
  /** B34 only bounds the HTTP wait; the runtime remains registered until it
   * really settles. B35 makes every subprocess honor that deadline promptly. */
  stopSettleTimeoutMs?: number;
  /** One total deadline for service shutdown across every project/rollback. */
  shutdownDeadlineMs?: number;
  /** Test seam for the persisted rollback state machine. */
  rollbackDepsFactory?: (project: Project) => RollbackExecutionDeps;
  /** B42 test seam; production probes through the real selected CLI/MCP. */
  figmaVerifier?: typeof verifyFigmaReferences;
}

export interface RollbackExecutionDeps {
  settings: Settings;
  git: GitService;
  worktrees: WorktreeManager;
  gates: GateRunner;
  validator: Validator;
}

export interface EngineShutdownResult {
  stoppedProjectIds: string[];
  settled: boolean;
  pendingProjectIds: string[];
  pendingRollbackIds: string[];
}

/**
 * Bridges the engine to the server: builds SchedulerDeps whose events persist to
 * SQLite and broadcast over the WebSocket, runs the Orchestrator in the
 * background per project, and resolves human approvals coming back from the UI
 * or Telegram.
 */
export class EngineRunner {
  /** B34: the sole execution owner for each project. Manual priority and
   * autonomous work share this runtime/orchestrator instead of maintaining
   * competing maps with incompatible scope/concurrency state. */
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private nextRuntimeGeneration = 1;
  private readonly pendingApprovals = new Map<string, (choice: string) => void>();
  private readonly rollbackRuns = new Map<string, Promise<void>>();
  private readonly rollbackByProject = new Map<string, string>();
  private readonly rollbackAbortControllers = new Map<string, AbortController>();
  private acceptingWork = true;
  private shutdownPromise?: Promise<EngineShutdownResult>;
  /** Optional second channel (Telegram). Set after construction. */
  private notifier?: ServerNotifier;

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
    private readonly options: EngineRunnerOptions = {},
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

  /** B41 shutdown boundary: force the final buffered batch to SQLite before
   * the database is checkpointed and closed. */
  flushPendingLogs(): void {
    this.flushLogs();
  }

  /** Wire an extra notifier (Telegram) for approvals + status pushes. */
  setNotifier(n: ServerNotifier | undefined): void {
    this.notifier = n;
  }

  private assertAcceptingWork(): void {
    if (!this.acceptingWork) {
      throw new Error("server is shutting down — new work is not accepted");
    }
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
    const cooldown = repo.getModelCooldown(this.db, modelId);
    if (!cooldown) return null;
    const until = new Date(cooldown.until).getTime();
    if (!Number.isFinite(until) || until <= Date.now()) {
      repo.clearModelCooldown(this.db, modelId);
      return null;
    }
    return `rate-limited, cooling down for ~${Math.ceil((until - Date.now()) / 60_000)}m more`;
  }

  /** For the model-health panel (F6) — current cooldown expiry, if any. */
  getCoolingDownUntil(modelId: ModelId): number | undefined {
    const cooldown = repo.getModelCooldown(this.db, modelId);
    if (!cooldown) return undefined;
    const until = new Date(cooldown.until).getTime();
    if (!Number.isFinite(until) || until <= Date.now()) {
      repo.clearModelCooldown(this.db, modelId);
      return undefined;
    }
    return until;
  }

  /** Persist one B40 lifecycle event and fan out only the first accepted
   * terminal transition. SQLite owns the exactly-once decision. */
  private recordInvocation(event: ModelInvocation): ModelInvocation {
    const saved = persistInvocationEvent(this.db, event);
    if (!saved.transitioned) return saved.invocation;
    if (saved.cost) {
      this.hub.broadcast({ type: "cost.updated", payload: saved.cost });
      if (saved.invocation.projectId) {
        this.checkAndPushBudgetAlerts(saved.invocation.projectId);
      }
    }
    if (saved.invocation.exitReason === "rate_limited") {
      repo.setModelCooldown(
        this.db,
        saved.invocation.model,
        new Date(Date.now() + EngineRunner.COOLDOWN_MS).toISOString(),
      );
      if (saved.invocation.projectId) {
        this.logError(
          saved.invocation.projectId,
          `${saved.invocation.model} looks rate-limited — cooling down for ${EngineRunner.COOLDOWN_MS / 60_000}m`,
        );
      }
    }
    return saved.invocation;
  }

  isRunning(projectId: string): boolean {
    return this.runtimes.get(projectId)?.autonomousStartedAt !== undefined;
  }

  /** Any starting/running/draining/stopping activity, regardless of whether
   * it was initiated by Start or a manual-priority request. Deletion and
   * replacement operations must use this stronger predicate. */
  hasActivity(projectId: string): boolean {
    return this.runtimes.has(projectId) || this.rollbackByProject.has(projectId);
  }

  getActivityState(projectId: string): ProjectRuntimeState | undefined {
    return this.runtimes.get(projectId)?.state;
  }

  /** Compatibility/query helper: true for a manual-only runtime. Once Start
   * promotes it, it is the same runtime but no longer manual-only. */
  hasManualRun(projectId: string): boolean {
    const runtime = this.runtimes.get(projectId);
    return Boolean(runtime && runtime.autonomousStartedAt === undefined);
  }

  /** Request that the project's owning runtime stop one active task. */
  stopTask(projectId: string, taskId: string): boolean {
    return this.runtimes.get(projectId)?.orchestrator.stopTask(taskId) ?? false;
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
    if (this.options.orchestratorFactory) {
      return this.options.orchestratorFactory(project);
    }
    const settings = repo.getSettings(this.db);
    if (!settings) throw new Error("settings not found");
    const liveSettings = (): Settings => {
      const current = repo.getSettings(this.db);
      if (!current) throw new Error("settings not found");
      return current;
    };

    // F44: dedupe model-trouble web notifications per (task, event type) for
    // this runtime. Manual priority and autonomous work share the same
    // Orchestrator, so one noisy task cannot bypass the dedupe by changing how
    // it was dispatched.
    const modelTroubleNotified = new Set<string>();
    // B42: positive access facts live no longer than this project runtime.
    // The exact runner model and file are both part of the key.
    const figmaAccessCache = new Set<string>();
    const figmaVerifier = this.options.figmaVerifier ?? verifyFigmaReferences;

    const adapterFor = (modelId: ModelId): AgentAdapter => {
      const cfg = liveSettings().models.find((m) => m.id === modelId);
      if (!cfg) throw new Error(`no ModelConfig for ${modelId}`);
      if (!cfg.enabled) throw new Error(`model ${modelId} is disabled`);
      return makeAdapter(cfg, ENV.opencodeBaseUrl);
    };

    const worktrees = new WorktreeManagerImpl(settings);
    const git = new GitServiceImpl();
    const gates = new GateRunnerImpl(worktrees, settings);
    // Record validator spend: validation runs aren't author runs, so they have
    // no run row — without this their cost never reaches the costs table.
    const validator = new ValidatorImpl(
      adapterFor,
      liveSettings,
      (event) => this.recordInvocation(event),
    );

    const deps: SchedulerDeps = {
      worktrees,
      git,
      gates,
      validator,
      settings,
      getSettings: liveSettings,
      adapterFor,
      opencodeBaseUrl: ENV.opencodeBaseUrl,
      getTasks: () => repo.getTasks(this.db, project.id),
      getMergeDecisions: (taskId) => repo.getMergeDecisions(this.db, taskId),
      getPendingApproval: (projectId) => {
        const pending = repo
          .getNotifications(this.db, projectId)
          .find((n) => n.requiresApproval && !n.respondedWith);
        return pending ? { title: pending.title } : undefined;
      },
      preflightFigma: async ({ task, model, signal }) => {
        const intake = extractFigmaReferencesFromText(
          [task.description, ...task.acceptanceCriteria].join("\n"),
        );
        if (intake.nodes.length === 0) return { required: false };

        const config = liveSettings().models.find((candidate) => candidate.id === model);
        if (!config) {
          throw new Error(`model ${model} is not configured`);
        }
        const representatives = [
          ...new Map(
            intake.nodes.map((reference) => [reference.fileKey, reference]),
          ).values(),
        ];
        const first = representatives[0]!;
        const context = {
          runner: config.runner,
          canonicalUrl: first.canonicalUrl,
          nodeId: first.nodeId,
        };
        const configuredRunnerModel =
          config.runner === "codex"
            ? config.codexModel
            : config.runner === "opencode"
              ? config.opencodeModel
              : config.claudeModel;
        const accessKey = (fileKey: string) =>
          [
            model,
            config.runner,
            configuredRunnerModel ?? "cli-default",
            fileKey,
          ].join("\u0000");
        const uncached = representatives.filter(
          (reference) => !figmaAccessCache.has(accessKey(reference.fileKey)),
        );
        if (uncached.length === 0) {
          return { required: true, context };
        }

        const plannerModel: PlannerModel = {
          id: model,
          runner: config.runner,
          model: configuredRunnerModel,
          effort: config.effort,
          opencodeBaseUrl:
            config.runner === "opencode" ? ENV.opencodeBaseUrl : undefined,
        };
        try {
          await figmaVerifier(
            uncached,
            project.localPath,
            plannerModel,
            signal,
            (event) =>
              this.recordInvocation({
                ...event,
                projectId: project.id,
                taskId: task.id,
              }),
            {
              stage: "author_preflight",
              actions: FIGMA_AUTHOR_ACTIONS,
            },
          );
          for (const reference of uncached) {
            figmaAccessCache.add(accessKey(reference.fileKey));
          }
          return { required: true, context };
        } catch (error) {
          if (error instanceof FigmaVerificationError) {
            return { required: true, context, issue: error.issue };
          }
          const issue: FigmaCapabilityIssue = {
            stage: "author_preflight",
            code: "figma_unavailable",
            model,
            runner: config.runner,
            message: "The assigned runner could not complete the Figma access check.",
            actions: [...FIGMA_AUTHOR_ACTIONS],
            canonicalUrl: first.canonicalUrl,
            nodeId: first.nodeId,
          };
          return { required: true, context, issue };
        }
      },
      checkBudget: (modelId) =>
        checkBudget(this.db, project.id, modelId, liveSettings()),
      checkModelCooldown: (modelId) => this.checkModelCooldown(modelId),
      checkModelQuota: (modelId) => checkModelQuota(this.db, modelId, liveSettings()),
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
            dispatchRequestedAt: t.dispatchRequestedAt,
            statusReason: t.statusReason,
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
            const digest = liveSettings().telegram?.digest ?? "terminal";
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
                // `reason` is the one-line "what worked / why it failed"
                // AuditView renders under the card.
                detail: {
                  attempts: t.attempts,
                  prNumber: t.prNumber,
                  costUsd,
                  model: t.assignedModel,
                  reason: t.statusReason,
                },
              });
            }
          }
        },
        onRunUpdated: (r) => {
          // Manual per-model pricing (Settings) overrides the CLI-reported
          // cost — recompute from tokens before anything persists or alerts
          // on it (see pricing.ts).
          const cfg = liveSettings().models.find((m) => m.id === r.model);
          const manual = manualCostUsd(cfg, r.tokensIn, r.tokensOut, r.tokensCached ?? 0);
          if (manual != null) r = { ...r, costUsd: manual };

          this.recordInvocation({
            id: r.id,
            projectId: project.id,
            taskId: r.taskId,
            runId: r.id,
            stage: r.id.endsWith("-docs") ? "docs" : "author",
            model: r.model,
            runner: cfg?.runner ?? "unknown",
            effort: r.effort ?? "default",
            startedAt: r.startedAt,
            endedAt: r.endedAt,
            outcome:
              r.status === "running"
                ? "running"
                : r.status === "passed"
                  ? "completed"
                  : r.status === "stopped"
                    ? "stopped"
                    : "failed",
            exitReason: r.exitReason,
            costUsd: r.costUsd,
            tokensIn: r.tokensIn,
            tokensOut: r.tokensOut,
            tokensCached: r.tokensCached ?? 0,
          });

          const existingRun = repo.getRun(this.db, r.id);
          if (existingRun?.status === "stopped" && r.status !== "running") {
            // The Stop route owns the terminal run status. Preserve it when
            // the aborted adapter reports its final result a moment later,
            // while still retaining the final usage/cost counters.
            repo.updateRun(this.db, r.id, {
              costUsd: r.costUsd,
              tokensIn: r.tokensIn,
              tokensOut: r.tokensOut,
              tokensCached: r.tokensCached ?? 0,
            });
            r = repo.getRun(this.db, r.id) ?? existingRun;
          } else if (existingRun) {
            repo.updateRun(this.db, r.id, r);
          } else {
            repo.createRun(this.db, r);
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

          // F44: web notification parity — the bell always gets these
          // (unlike the Telegram push below, which respects modelAlerts),
          // deduped to one row per (task, event type) per run so a chatty
          // task's repeated fallback switches don't spam the bell. Picks
          // up B32's "quota_wait" event for free — it's just another value
          // in the same union.
          const dedupeKey = `${info.taskId}:${info.event}`;
          if (!modelTroubleNotified.has(dedupeKey)) {
            modelTroubleNotified.add(dedupeKey);
            const notif = repo.createNotification(this.db, {
              projectId: project.id,
              taskId: info.taskId,
              severity: "warn",
              title: `${info.taskTitle} — ${info.event}`,
              message: `${info.model}: ${info.detail}`,
              requiresApproval: false,
            });
            this.hub.broadcast({ type: "notification", payload: notif });
          }

          // F32: default true (unset counts as enabled) — the owner
          // explicitly asked to be alerted on these, independent of the
          // task-status `digest` setting.
          if (liveSettings().telegram?.modelAlerts !== false) {
            this.notifier?.modelTrouble({
              projectName: project.name,
              taskTitle: info.taskTitle,
              model: info.model,
              event: info.event,
              detail: info.detail,
            });
          }
        },
        onFigmaCapabilityBlocked: (info) => {
          const capabilityKey = [
            "figma",
            info.issue.stage,
            info.issue.model,
            info.issue.runner,
            info.issue.code,
            info.issue.canonicalUrl ?? info.issue.nodeId ?? "unknown",
          ].join("|");
          if (
            repo.getNotificationByCapabilityKey(
              this.db,
              info.taskId,
              capabilityKey,
            )
          ) {
            return;
          }

          const persistedTask = repo.getTask(this.db, info.taskId);
          const message = persistedTask?.statusReason ?? info.issue.message;
          const notification = repo.createNotification(this.db, {
            projectId: project.id,
            taskId: info.taskId,
            severity: "warn",
            title: `${info.taskTitle} — Figma access blocked`,
            message,
            requiresApproval: false,
            context: { capabilityKey },
          });
          repo.createAuditEntry(this.db, {
            projectId: project.id,
            taskId: info.taskId,
            kind: "capability_blocked",
            actor: "engine",
            summary: notification.title,
            detail: {
              stage: info.issue.stage,
              code: info.issue.code,
              model: info.issue.model,
              runner: info.issue.runner,
              reference: info.issue.canonicalUrl ?? info.issue.nodeId,
              actions: info.issue.actions,
            },
          });
          this.hub.broadcast({ type: "notification", payload: notification });
          this.notifier?.info(`⚠️ ${notification.title}\n${message}`);
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

  private buildRollbackDeps(project: Project): RollbackExecutionDeps {
    if (this.options.rollbackDepsFactory) {
      return this.options.rollbackDepsFactory(project);
    }
    const settings = repo.getSettings(this.db);
    if (!settings) throw new Error("settings not found");
    const liveSettings = (): Settings => {
      const current = repo.getSettings(this.db);
      if (!current) throw new Error("settings not found");
      return current;
    };
    const adapterFor = (modelId: ModelId): AgentAdapter => {
      const config = liveSettings().models.find((model) => model.id === modelId);
      if (!config) throw new Error(`no ModelConfig for ${modelId}`);
      if (!config.enabled) throw new Error(`model ${modelId} is disabled`);
      return makeAdapter(config, ENV.opencodeBaseUrl);
    };
    const worktrees = new WorktreeManagerImpl(settings);
    const git = new GitServiceImpl();
    return {
      settings,
      git,
      worktrees,
      gates: new GateRunnerImpl(worktrees, settings),
      validator: new ValidatorImpl(
        adapterFor,
        liveSettings,
        (event) => this.recordInvocation(event),
      ),
    };
  }

  private updateRollback(
    id: string,
    updates: Partial<RollbackJob>,
  ): RollbackJob {
    const updated = repo.updateRollbackJob(this.db, id, updates);
    if (!updated) throw new Error(`rollback job ${id} disappeared`);
    this.hub.broadcast({ type: "rollback.updated", payload: updated });
    return updated;
  }

  private rollbackTask(task: Task, job: RollbackJob): Task {
    return {
      ...task,
      title: `Rollback PR #${job.sourcePrNumber}: ${task.title}`,
      description:
        `Mechanically revert the commit merged by PR #${job.sourcePrNumber}. ` +
        "Do not introduce unrelated changes.",
      status: "in_review",
      acceptanceCriteria: [
        `The changes from PR #${job.sourcePrNumber} are reverted without unrelated edits.`,
        "All applicable repository gates pass.",
      ],
      scopePaths: ["**/*"],
      branch: job.branch,
      worktreePath: job.worktreePath,
      prNumber: job.rollbackPrNumber,
      attempts: 1,
      maxAttempts: 1,
    };
  }

  private requestRollbackApproval(
    project: Project,
    task: Task,
    job: RollbackJob,
    signal?: AbortSignal,
  ): Promise<string> {
    const prUrl = `${project.repoUrl}/pull/${job.rollbackPrNumber}`;
    const reasons = job.decision?.reasons ?? [];
    const checkDetail = job.statusReason ? `\n\n${job.statusReason}` : "";
    const notif = repo.createNotification(this.db, {
      projectId: project.id,
      taskId: task.id,
      severity: "action_required",
      title: `Approve rollback of PR #${job.sourcePrNumber}`,
      message:
        `Rollback PR #${job.rollbackPrNumber} passed local gates and was independently reviewed. ` +
        `Merge it to revert PR #${job.sourcePrNumber}?${checkDetail}`,
      requiresApproval: true,
      options: ["approve_merge", "reject"],
      context: { prUrl, reasons },
    });
    this.updateRollback(job.id, {
      approvalNotificationId: notif.id,
      approvalChoice: undefined,
    });
    repo.createAuditEntry(this.db, {
      projectId: project.id,
      taskId: task.id,
      kind: "approval_requested",
      actor: "engine",
      summary: notif.title,
      detail: {
        rollbackJobId: job.id,
        rollbackPrNumber: job.rollbackPrNumber,
        sourcePrNumber: job.sourcePrNumber,
        reasons,
      },
    });
    this.hub.broadcast({ type: "notification", payload: notif });
    this.notifier?.approvalRequested(notif, { prUrl, reasons });
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        this.pendingApprovals.delete(notif.id);
        reject(new DOMException("Rollback approval interrupted", "AbortError"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pendingApprovals.set(notif.id, (choice) => {
        signal?.removeEventListener("abort", onAbort);
        // Persist before resolving the waiter. A crash immediately after the
        // HTTP/Telegram response can then resume the chosen path on boot.
        this.updateRollback(job.id, { approvalChoice: choice });
        resolve(choice);
      });
    });
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

  private ensureClone(project: Project): Promise<void> {
    if (this.options.ensureClone) return this.options.ensureClone(project);
    return new GitServiceImpl().ensureClone(project);
  }

  /** Create and register the one runtime that owns this project. The runtime
   * is installed before any async work begins, closing the check-then-create
   * race between Start, manual Dispatch, and Stop. */
  private createRuntime(project: Project, autonomous: boolean): ProjectRuntime {
    const runtime: ProjectRuntime = {
      generation: this.nextRuntimeGeneration++,
      orchestrator: this.buildOrchestrator(project),
      state: "starting",
      autonomousStartedAt: autonomous ? new Date().toISOString() : undefined,
      settled: Promise.resolve(),
    };
    this.runtimes.set(project.id, runtime);
    runtime.settled = this.runRuntime(project, runtime);
    return runtime;
  }

  private async runRuntime(
    project: Project,
    runtime: ProjectRuntime,
  ): Promise<void> {
    try {
      await this.ensureClone(project);
      // A hard Stop that arrived while clone/setup was starting owns the
      // outcome. Do not reset Orchestrator.paused by entering start().
      if (runtime.state === "stopping") return;
      runtime.state = "running";
      const tasks = repo.getTasks(this.db, project.id);
      await runtime.orchestrator.start(project, tasks, {
        shouldDispatch: (task) =>
          runtime.autonomousStartedAt !== undefined ||
          task.dispatchRequestedAt !== undefined,
      });
    } catch (err) {
      this.logError(
        project.id,
        `Orchestrator crashed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // Identity check is essential: an old generation must never unregister
      // or finalize over a newer runtime created after it settled.
      const ownsProject = this.runtimes.get(project.id) === runtime;
      if (ownsProject) {
        this.runtimes.delete(project.id);
      }
      this.flushLogs();
      if (ownsProject && runtime.autonomousStartedAt) {
        try {
          this.finishAutonomousRun(project, runtime.autonomousStartedAt);
        } catch (err) {
          this.logError(
            project.id,
            `Failed to finalize run: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  /** Run the whole project DAG autonomously in the background. If a manual-
   * priority runtime already owns the project, promote that exact runtime;
   * never create a competing Orchestrator. */
  async start(project: Project): Promise<void> {
    this.assertAcceptingWork();
    const persistenceError = planningPersistenceError(project);
    if (persistenceError) throw new Error(persistenceError);
    if (this.rollbackByProject.has(project.id)) {
      throw new Error("a rollback is active for this project");
    }
    const existing = this.runtimes.get(project.id);
    if (existing) {
      if (existing.state === "stopping" || existing.state === "draining") {
        throw new Error(
          `project execution is ${existing.state} — wait for it to settle before starting again`,
        );
      }
      existing.autonomousStartedAt ??= new Date().toISOString();
      return;
    }
    this.createRuntime(project, true);
  }

  private finishAutonomousRun(
    project: Project,
    runStartedAt: string,
  ): void {
    // Reflect what actually happened, not "completed" by default. The
    // orchestrator can exit with resumable work after a budget/dependency
    // block or a hard pause.
    const finalTasks = repo.getTasks(this.db, project.id);
    const allDone = finalTasks.every((t) => t.status === "done");
    const stillPending = finalTasks.some(
      (t) =>
        t.status === "backlog" ||
        t.status === "ready" ||
        t.status === "in_progress" ||
        t.status === "in_review" ||
        t.status === "blocked",
    );
    const anyFailed = finalTasks.some((t) => t.status === "failed");
    const finalStatus = allDone
      ? "completed"
      : stillPending
        ? "paused"
        : anyFailed
          ? "failed"
          : "completed";

    repo.updateProject(this.db, project.id, { status: finalStatus });
    if (finalStatus !== "completed") {
      const blocked = finalTasks.filter((t) => t.status !== "done");
      const message =
        `Run ended (${finalStatus}) with ${blocked.length} task(s) not done: ` +
        blocked.map((t) => `${t.title} [${t.status}]`).join(", ");
      this.logError(project.id, message);
      const notif = repo.createNotification(this.db, {
        projectId: project.id,
        severity: "warn",
        title: `Run ended: ${finalStatus}`,
        message,
        requiresApproval: false,
      });
      this.hub.broadcast({ type: "notification", payload: notif });
    }

    const fresh = repo.getProject(this.db, project.id);
    if (fresh) this.hub.broadcast({ type: "project.updated", payload: fresh });
    this.pushRunSummary(project, runStartedAt, finalStatus);
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

  /** Persist and prioritize a task through the project's one scheduler. */
  async dispatchOne(project: Project, taskId: string): Promise<Task> {
    this.assertAcceptingWork();
    if (this.rollbackByProject.has(project.id)) {
      throw new Error("a rollback is active for this project");
    }
    const task = repo.getTask(this.db, taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    if (task.status !== "ready" && task.status !== "backlog") {
      throw new Error(`task is ${task.status}, not dispatchable`);
    }

    const queued = repo.updateTask(this.db, taskId, {
      dispatchRequestedAt:
        task.dispatchRequestedAt ?? new Date().toISOString(),
    })!;
    this.hub.broadcast({ type: "task.updated", payload: queued });

    const existing = this.runtimes.get(project.id);
    if (!existing) {
      this.createRuntime(project, false);
      return queued;
    }

    // Reconciliation normally sees the persisted request on the next pass.
    // Also check after this exact generation settles to close the narrow race
    // where the scheduler has decided to exit but its Promise has not yet
    // unregistered the runtime.
    void existing.settled.then(
      () => this.resumeQueued(project),
      () => this.resumeQueued(project),
    );
    return queued;
  }

  /** Recreate a manual-only runtime for durable requests after process boot or
   * after an older runtime settles. Returns true only when one was started. */
  resumeQueued(project: Project): boolean {
    if (!this.acceptingWork) return false;
    if (this.runtimes.has(project.id) || this.rollbackByProject.has(project.id)) {
      return false;
    }
    const hasQueued = repo
      .getTasks(this.db, project.id)
      .some(
        (task) =>
          task.dispatchRequestedAt !== undefined &&
          (task.status === "ready" || task.status === "backlog"),
      );
    if (!hasQueued) return false;
    this.createRuntime(project, false);
    return true;
  }

  private startRollbackJob(
    project: Project,
    task: Task,
    job: RollbackJob,
  ): void {
    if (this.rollbackRuns.has(job.id)) return;
    const otherJob = this.rollbackByProject.get(project.id);
    if (otherJob && otherJob !== job.id) {
      throw new Error(`project already has active rollback job ${otherJob}`);
    }
    if (this.runtimes.has(project.id)) {
      throw new Error("project execution is active; stop it before rolling back");
    }

    this.rollbackByProject.set(project.id, job.id);
    const controller = new AbortController();
    this.rollbackAbortControllers.set(job.id, controller);
    const run = this.runRollbackJob(project, task, job, controller.signal).finally(() => {
      this.rollbackRuns.delete(job.id);
      this.rollbackAbortControllers.delete(job.id);
      if (this.rollbackByProject.get(project.id) === job.id) {
        this.rollbackByProject.delete(project.id);
      }
    });
    this.rollbackRuns.set(job.id, run);
    void run;
  }

  private async runRollbackJob(
    project: Project,
    sourceTask: Task,
    initialJob: RollbackJob,
    signal: AbortSignal,
  ): Promise<void> {
    const deps = this.buildRollbackDeps(project);
    let job = repo.getRollbackJob(this.db, initialJob.id) ?? initialJob;
    const refresh = (): RollbackJob =>
      repo.getRollbackJob(this.db, job.id) ?? job;
    const audit = (
      kind: string,
      summary: string,
      detail: Record<string, unknown> = {},
    ): void => {
      repo.createAuditEntry(this.db, {
        projectId: project.id,
        taskId: sourceTask.id,
        kind,
        actor: "engine",
        summary,
        detail: { rollbackJobId: job.id, ...detail },
      });
    };
    const cleanupWorktree = async (): Promise<void> => {
      const task = this.rollbackTask(sourceTask, refresh());
      await deps.worktrees.remove(project, task).catch(() => {});
    };
    let preparedWorktree = false;

    try {
      await deps.git.ensureClone(project, signal);

      if (job.status === "requested" || job.status === "preparing") {
        job = this.updateRollback(job.id, {
          status: "preparing",
          statusReason: "Preparing an isolated rollback worktree",
        });
        const prepared = await deps.git.prepareRollback(project, job, signal);
        await deps.worktrees.prepareForGates(
          project,
          this.rollbackTask(sourceTask, job),
          signal,
        );
        preparedWorktree = true;
        job = this.updateRollback(job.id, {
          sourceCommit: prepared.sourceCommit,
          sourceParentCount: prepared.sourceParentCount,
          status: "gating",
          statusReason:
            prepared.sourceParentCount === 1
              ? "Prepared a plain revert for the squash commit"
              : `Prepared a mainline revert for a ${prepared.sourceParentCount}-parent merge commit`,
        });
        audit("rollback_prepared", job.statusReason ?? "Rollback prepared", {
          sourcePrNumber: job.sourcePrNumber,
          sourceCommit: prepared.sourceCommit,
          sourceParentCount: prepared.sourceParentCount,
        });
      }

      if (
        !preparedWorktree &&
        (job.status === "gating" ||
          job.status === "validating" ||
          job.status === "pushing")
      ) {
        await deps.git.prepareRollback(project, job, signal);
        await deps.worktrees.prepareForGates(
          project,
          this.rollbackTask(sourceTask, job),
          signal,
        );
      }

      if (job.status === "gating") {
        const rollbackTask = this.rollbackTask(sourceTask, job);
        const gate = await deps.gates.run(project, rollbackTask, signal);
        const cleanup = await deps.worktrees.restoreToHead(rollbackTask);
        if (!cleanup.ok) {
          gate.tests = false;
          gate.details.tests =
            `${gate.details.tests ?? ""}\nCould not restore rollback worktree after gates: ` +
            `${cleanup.error ?? "unknown git error"}`;
        }
        const passed =
          gate.typecheck &&
          gate.lint &&
          gate.build &&
          gate.tests &&
          gate.noConflicts;
        if (!passed) {
          job = this.updateRollback(job.id, {
            gate,
            status: "failed",
            statusReason: "Rollback failed its repository gates",
          });
          audit("rollback_failed", job.statusReason ?? "Rollback gates failed", { gate });
          await cleanupWorktree();
          return;
        }
        job = this.updateRollback(job.id, {
          gate,
          status: "validating",
          statusReason: gate.vacuous
            ? "No objective scripts were available; independent review is required"
            : "Repository gates passed",
        });
      }

      if (job.status === "validating") {
        const rollbackTask = this.rollbackTask(sourceTask, job);
        const decision = await deps.validator.review(
          project,
          rollbackTask,
          job.gate!,
          "hoopedorc-mechanical-rollback",
          (line) =>
            this.enqueueLog({
              projectId: project.id,
              runId: `rollback-${job.id}`,
              taskId: sourceTask.id,
              ts: new Date().toISOString(),
              level: "info",
              source: "validator",
              message: line,
            }),
          signal,
        );
        job = this.updateRollback(job.id, {
          decision,
          status: "pushing",
          statusReason: `Independent validator verdict: ${decision.verdict}`,
        });
        repo.createMergeDecision(this.db, decision);
        audit(
          "rollback_validation",
          `${decision.verdict} (confidence ${decision.confidence.toFixed(2)})`,
          { reasons: decision.reasons, gate: decision.gate },
        );
        this.hub.broadcast({ type: "merge.decision", payload: decision });
      }

      if (job.status === "pushing") {
        await deps.git.push(job.worktreePath, job.branch, signal);
        const rollbackTask = this.rollbackTask(sourceTask, job);
        const prNumber =
          job.rollbackPrNumber ??
          (await deps.git.openRollbackPr(project, rollbackTask, job, signal));
        job = this.updateRollback(job.id, {
          rollbackPrNumber: prNumber,
          status: "checking",
          statusReason: "Rollback PR opened; checking repository CI",
        });
        audit("rollback_pr_opened", `Opened rollback PR #${prNumber}`, {
          rollbackPrNumber: prNumber,
          sourcePrNumber: job.sourcePrNumber,
        });

      }

      if (job.status === "checking") {
        let statusReason = "Rollback PR is waiting for mandatory human approval";
        if (project.config?.requireGithubChecks) {
          const checks = await deps.git.waitForChecks(
            project,
            job.rollbackPrNumber!,
            (project.config.githubChecksTimeoutMin ?? 15) * 60_000,
            undefined,
            signal,
          );
          if (checks === "failed" || checks === "timeout") {
            statusReason = `GitHub checks ${checks}; explicit approval is required to proceed`;
          }
        }
        job = this.updateRollback(job.id, {
          status: "awaiting_approval",
          statusReason,
        });
      }

      if (job.status === "awaiting_approval") {
        const choice =
          job.approvalChoice ??
          (await this.requestRollbackApproval(project, sourceTask, job, signal));
        job = refresh();
        job = this.updateRollback(job.id, {
          status: choice === "approve_merge" ? "merging" : "rejecting",
          statusReason:
            choice === "approve_merge"
              ? "Human approved the rollback PR"
              : "Human rejected the rollback PR; closing it",
        });
      }

      if (job.status === "rejecting") {
        await deps.git.closeRollbackPr(
          project,
          job,
          `Closed by Hoopedorc: rollback of PR #${job.sourcePrNumber} was rejected.`,
          signal,
        );
        job = this.updateRollback(job.id, {
          status: "rejected",
          statusReason: `Rollback PR #${job.rollbackPrNumber} was rejected and closed`,
        });
        audit("rollback_rejected", job.statusReason ?? "Rollback rejected", {
          rollbackPrNumber: job.rollbackPrNumber,
          sourcePrNumber: job.sourcePrNumber,
        });
        await cleanupWorktree();
        return;
      }

      if (job.status === "merging") {
        await deps.git.prepareRollback(project, job, signal);
        const rollbackTask = this.rollbackTask(sourceTask, job);
        const sync = await deps.git.syncBranchWithMain(project, rollbackTask, signal);
        if (sync === "conflict") {
          throw new RollbackConflictError(
            `Rollback PR #${job.rollbackPrNumber} now conflicts with ${project.defaultBranch}`,
          );
        }
        if (project.config?.requireGithubChecks) {
          const checks = await deps.git.waitForChecks(
            project,
            job.rollbackPrNumber!,
            (project.config.githubChecksTimeoutMin ?? 15) * 60_000,
            undefined,
            signal,
          );
          if (checks === "failed" || checks === "timeout") {
            job = this.updateRollback(job.id, {
              status: "awaiting_approval",
              approvalChoice: undefined,
              statusReason: `GitHub checks ${checks} after the branch refresh; approval is required again`,
            });
            const choice = await this.requestRollbackApproval(
              project,
              sourceTask,
              job,
              signal,
            );
            job = refresh();
            if (choice !== "approve_merge") {
              job = this.updateRollback(job.id, {
                status: "rejecting",
                statusReason: "Human rejected the refreshed rollback PR",
              });
              await deps.git.closeRollbackPr(
                project,
                job,
                `Closed by Hoopedorc: refreshed rollback of PR #${job.sourcePrNumber} was rejected.`,
                signal,
              );
              job = this.updateRollback(job.id, {
                status: "rejected",
                statusReason: `Rollback PR #${job.rollbackPrNumber} was rejected and closed`,
              });
              audit("rollback_rejected", job.statusReason ?? "Rollback rejected");
              await cleanupWorktree();
              return;
            }
            job = this.updateRollback(job.id, {
              status: "merging",
              statusReason: "Human approved the refreshed rollback PR",
            });
          }
        }

        await deps.git.mergePr(project, job.rollbackPrNumber!, signal);
        job = this.updateRollback(job.id, {
          status: "completed",
          statusReason: `Merged rollback PR #${job.rollbackPrNumber}; PR #${job.sourcePrNumber} is reverted`,
        });
        const updatedTask = repo.updateTask(this.db, sourceTask.id, {
          status: "blocked",
          statusReason: job.statusReason,
        });
        if (updatedTask) {
          this.hub.broadcast({ type: "task.updated", payload: updatedTask });
        }
        audit("rollback", job.statusReason ?? "Rollback completed", {
          sourcePrNumber: job.sourcePrNumber,
          rollbackPrNumber: job.rollbackPrNumber,
          sourceCommit: job.sourceCommit,
        });
        const notif = repo.createNotification(this.db, {
          projectId: project.id,
          taskId: sourceTask.id,
          severity: "info",
          title: `Rollback completed: PR #${job.sourcePrNumber}`,
          message: job.statusReason ?? "Rollback completed",
          requiresApproval: false,
          context: {
            prUrl: `${project.repoUrl}/pull/${job.rollbackPrNumber}`,
            reasons: job.decision?.reasons,
          },
        });
        this.hub.broadcast({ type: "notification", payload: notif });
        this.notifier?.info(job.statusReason ?? "Rollback completed");
        await cleanupWorktree();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      job = refresh();
      const failedStage = job.status;
      if (signal.aborted) {
        this.updateRollback(job.id, {
          statusReason: "Interrupted by server shutdown; rollback will resume on restart",
        });
        audit("rollback_interrupted", "Rollback interrupted by server shutdown", {
          stage: failedStage,
        });
      } else if (err instanceof RollbackConflictError) {
        if (job.rollbackPrNumber != null) {
          await deps.git
            .closeRollbackPr(project, job, `Closed by Hoopedorc: ${message}`)
            .catch(() => {});
        }
        job = this.updateRollback(job.id, {
          status: "conflicted",
          statusReason: message,
        });
        audit("rollback_conflicted", message);
        await cleanupWorktree();
      } else if (
        job.status === "pushing" ||
        job.status === "rejecting" ||
        job.status === "merging"
      ) {
        // These stages are idempotent and externally stateful. Keep the
        // checkpoint recoverable so a duplicate click or restart retries it.
        this.updateRollback(job.id, { statusReason: message });
        audit("rollback_retryable_error", message, { stage: failedStage });
      } else {
        job = this.updateRollback(job.id, {
          status: "failed",
          statusReason: message,
        });
        audit("rollback_failed", message, { stage: failedStage });
        await cleanupWorktree();
      }
      this.logError(project.id, `Rollback ${job.id}: ${message}`);
    }
  }

  /** Re-arm every nonterminal rollback after process restart. */
  resumeRollbacks(): number {
    if (!this.acceptingWork) return 0;
    let resumed = 0;
    for (const job of repo.getRecoverableRollbackJobs(this.db)) {
      const project = repo.getProject(this.db, job.projectId);
      const task = repo.getTask(this.db, job.taskId);
      if (!project || !task || this.rollbackRuns.has(job.id)) continue;
      try {
        this.startRollbackJob(project, task, job);
        resumed++;
      } catch {
        // A normal project runtime already owns the repo; its completion or
        // the next boot/click can retry the persisted rollback.
      }
    }
    return resumed;
  }

  private async waitForSettlement(runtime: ProjectRuntime): Promise<boolean> {
    const timeoutMs = this.options.stopSettleTimeoutMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        runtime.settled.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async pause(project: Project, opts: { drain?: boolean } = {}): Promise<void> {
    const runtime = this.runtimes.get(project.id);
    if (!runtime) return;

    // Draining before start/clone has reached the scheduler has no active
    // work to preserve, so treat it as a hard stop. Otherwise drain remains
    // non-blocking while the registered runtime owns its finishing tasks.
    const drain = opts.drain === true && runtime.state !== "starting";
    runtime.state = drain ? "draining" : "stopping";
    await runtime.orchestrator.pause(project, { drain });
    if (drain) return;

    // A project-level hard Stop also cancels queued-but-not-started manual
    // requests. Active requests were already cleared at actual dispatch.
    for (const task of repo.clearDispatchRequests(this.db, project.id)) {
      this.hub.broadcast({ type: "task.updated", payload: task });
    }

    const settled = await this.waitForSettlement(runtime);
    if (!settled) {
      this.logError(
        project.id,
        `Stop requested, but runtime generation ${runtime.generation} is still settling; new starts and deletion remain blocked`,
      );
    }
  }

  /**
   * F23: the global "Stop all" panic button — hard-aborts every currently
   * running project. B34's one runtime already owns autonomous and manual-
   * priority work, so one hard pause reaches every active task.
   * Returns the ids of projects that actually had something to stop.
   */
  async stopAll(projects: Project[]): Promise<string[]> {
    const stopped: string[] = [];
    for (const project of projects) {
      if (!this.hasActivity(project.id)) continue;
      await this.pause(project, { drain: false });
      stopped.push(project.id);
    }
    return stopped;
  }

  /**
   * B41 service shutdown: reject new work synchronously, abort every owned
   * orchestrator in parallel, and wait under one total deadline (not one
   * timeout per project). Rollback jobs are restart-safe and are included in
   * settlement, though their checkpointed state remains recoverable if the
   * deadline expires.
   */
  shutdown(projects: Project[]): Promise<EngineShutdownResult> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.acceptingWork = false;
    this.shutdownPromise = (async () => {
      const projectById = new Map(projects.map((project) => [project.id, project]));
      const runtimes = [...this.runtimes.entries()];
      const rollbackRuns = [...this.rollbackRuns.entries()];
      const stoppedProjectIds = [
        ...new Set([
          ...runtimes.map(([projectId]) => projectId),
          ...this.rollbackByProject.keys(),
        ]),
      ];

      const stopRequests = runtimes.map(async ([projectId, runtime]) => {
        runtime.state = "stopping";
        const project = projectById.get(projectId) ?? repo.getProject(this.db, projectId);
        if (!project) return;
        for (const task of repo.clearDispatchRequests(this.db, projectId)) {
          this.hub.broadcast({ type: "task.updated", payload: task });
        }
        await runtime.orchestrator.pause(project, { drain: false });
      });
      for (const controller of this.rollbackAbortControllers.values()) {
        controller.abort();
      }

      const settlement = Promise.allSettled(stopRequests).then(() =>
        Promise.allSettled([
          ...runtimes.map(([, runtime]) => runtime.settled),
          ...rollbackRuns.map(([, run]) => run),
        ]),
      );
      const deadlineMs = this.options.shutdownDeadlineMs ?? 15_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        settlement.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), deadlineMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      this.flushLogs();

      return {
        stoppedProjectIds,
        settled,
        pendingProjectIds: [...this.runtimes.keys()],
        pendingRollbackIds: [...this.rollbackRuns.keys()],
      };
    })();
    return this.shutdownPromise;
  }

  /** Persist and start a gated rollback PR. Duplicate calls return one job. */
  async rollback(project: Project, task: Task): Promise<RollbackJob> {
    this.assertAcceptingWork();
    if (task.prNumber == null) {
      throw new Error("task has no merged PR to roll back");
    }
    const existing = repo.getRollbackJobForTask(
      this.db,
      task.id,
      task.prNumber,
    );
    if (existing) {
      if (
        !["completed", "rejected", "conflicted", "failed"].includes(
          existing.status,
        )
      ) {
        this.startRollbackJob(project, task, existing);
      }
      return repo.getRollbackJob(this.db, existing.id) ?? existing;
    }
    if (task.status !== "done") {
      throw new Error(`task is ${task.status}, not a completed task`);
    }
    if (this.hasActivity(project.id)) {
      throw new Error("project execution is active; stop it before rolling back");
    }

    const id = crypto.randomUUID();
    const job = repo.createOrGetRollbackJob(this.db, {
      id,
      projectId: project.id,
      taskId: task.id,
      sourcePrNumber: task.prNumber,
      branch: `orc/rollback-${id}`,
      worktreePath: `${project.localPath}-rollback-${id}`,
      status: "requested",
    });
    this.hub.broadcast({ type: "rollback.updated", payload: job });
    repo.createAuditEntry(this.db, {
      projectId: project.id,
      taskId: task.id,
      kind: "rollback_requested",
      actor: "human",
      summary: `Requested rollback of PR #${task.prNumber} for "${task.title}"`,
      detail: { rollbackJobId: job.id, sourcePrNumber: task.prNumber },
    });
    this.startRollbackJob(project, task, job);
    return job;
  }
}
