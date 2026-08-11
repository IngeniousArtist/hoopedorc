// F40: action logic shared between the HTTP routes and the Telegram command
// wave (`telegramCommand` in index.ts). Kept in its own module — unlike
// index.ts, which boots a real server as a side effect of being imported
// (`main()` runs unconditionally at the bottom of that file) — so these are
// actually unit-testable against a real in-memory DB, the same reasoning
// budget.ts/scheduler.ts/attachments.ts are their own modules.

import type { MergePolicy, Project, ServerEvent, Task } from "@orc/types";
import { checkBudget } from "./budget";
import { defaultSettings } from "./config";
import type { Db } from "./db/index";
import * as repo from "./db/repo";
import type { EngineRunner } from "./engine-runner";
import type { ServerNotifier } from "./telegram";
import {
  commitTelegramActionEffect,
  replaceTelegramActionEffectResult,
} from "./telegram-inbox";

export type ProjectActionResult =
  | { ok: true; project: Project }
  | { ok: false; status: number; error: string };

/** Shared by /pending and bot (re)configuration after process restart. */
export function resendPendingApprovals(
  db: Db,
  notifier: Pick<ServerNotifier, "approvalRequested">,
): number {
  const pending = repo
    .getNotifications(db)
    .filter((notification) =>
      notification.requiresApproval && !notification.respondedWith
    );
  for (const notification of pending) {
    notifier.approvalRequested(notification, notification.context);
  }
  return pending.length;
}

/** Turn a permanently missed phone approval into one deduplicated web alert. */
export function notifyTelegramApprovalFailure(
  db: Db,
  broadcast: (e: ServerEvent) => void,
  notificationId: string,
  error: string,
): boolean {
  const approval = repo.getNotification(db, notificationId);
  if (!approval) return false;
  const failureId = `telegram-delivery:${notificationId}`;
  if (repo.getNotification(db, failureId)) return false;
  const notification = repo.createNotification(db, {
    id: failureId,
    projectId: approval.projectId,
    taskId: approval.taskId,
    severity: "warn",
    title: "Telegram approval delivery failed",
    message: `Approval is still pending in the web UI. Telegram error: ${error}`,
    requiresApproval: false,
  });
  broadcast({ type: "notification", payload: notification });
  return true;
}

/** One Start implementation for HTTP, schedules, and Telegram controls. */
export async function startProject(
  db: Db,
  engine: EngineRunner,
  broadcast: (e: ServerEvent) => void,
  id: string,
  idempotencyKey?: string,
): Promise<ProjectActionResult> {
  if (idempotencyKey) {
    type StartActionResult =
      | { ok: true; project: Project; previousStatus: Project["status"] }
      | { ok: false; status: number; error: string };
    const action = commitTelegramActionEffect<StartActionResult>(
      db,
      idempotencyKey,
      () => {
        const project = repo.getProject(db, id);
        if (!project) {
          return { ok: false, status: 404, error: "project not found" };
        }
        return {
          ok: true,
          project: repo.updateProject(db, id, { status: "running" })!,
          previousStatus: project.status,
        };
      },
    );
    if (!action.result.ok) return action.result;
    const previousStatus = action.result.previousStatus;
    const running = repo.getProject(db, id) ?? action.result.project;
    try {
      if (running.status === "running" && !engine.hasActivity(id)) {
        await engine.start(running);
      }
    } catch (err) {
      if (!action.committed) throw err;
      return replaceTelegramActionEffectResult<ProjectActionResult>(
        db,
        idempotencyKey,
        () => {
          const current = repo.getProject(db, id);
          if (current?.status === "running") {
            repo.updateProject(db, id, { status: previousStatus });
          }
          return {
            ok: false,
            status: 409,
            error: err instanceof Error ? err.message : String(err),
          };
        },
      );
    }
    if (action.committed) {
      broadcast({ type: "project.updated", payload: running });
    }
    return { ok: true, project: running };
  }

  const project = repo.getProject(db, id);
  if (!project) return { ok: false, status: 404, error: "project not found" };
  try {
    await engine.start(project);
  } catch (err) {
    return {
      ok: false,
      status: 409,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const running = repo.updateProject(db, id, { status: "running" })!;
  broadcast({ type: "project.updated", payload: running });
  return { ok: true, project: running };
}

/** One Pause implementation for HTTP and Telegram controls. */
export async function pauseProject(
  db: Db,
  engine: EngineRunner,
  broadcast: (e: ServerEvent) => void,
  id: string,
  drain?: boolean,
  idempotencyKey?: string,
): Promise<ProjectActionResult> {
  if (idempotencyKey) {
    const action = commitTelegramActionEffect<ProjectActionResult>(
      db,
      idempotencyKey,
      () => {
        const project = repo.getProject(db, id);
        if (!project) {
          return { ok: false, status: 404, error: "project not found" };
        }
        return {
          ok: true,
          project: repo.updateProject(db, id, { status: "paused" })!,
        };
      },
    );
    if (!action.result.ok) return action.result;
    const paused = repo.getProject(db, id) ?? action.result.project;
    if (paused.status === "paused" && engine.hasActivity(id)) {
      await engine.pause(paused, { drain });
    }
    if (action.committed) {
      broadcast({ type: "project.updated", payload: paused });
    }
    return { ok: true, project: paused };
  }

  const project = repo.getProject(db, id);
  if (!project) return { ok: false, status: 404, error: "project not found" };
  try {
    await engine.pause(project, { drain });
  } catch (err) {
    return {
      ok: false,
      status: 409,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const paused = repo.updateProject(db, id, { status: "paused" })!;
  broadcast({ type: "project.updated", payload: paused });
  return { ok: true, project: paused };
}

/** Phone-friendly unique id/name prefix resolution for Telegram controls. */
export function findProjectByPrefix(
  db: Db,
  raw: string,
): { ok: true; project: Project } | { ok: false; error: string } {
  const query = raw.trim().toLocaleLowerCase();
  if (!query) return { ok: false, error: "Project name or id is required." };
  const projects = repo.getProjects(db);
  const exact = projects.filter(
    (project) =>
      project.id.toLocaleLowerCase() === query ||
      project.name.toLocaleLowerCase() === query,
  );
  const matches = exact.length > 0
    ? exact
    : projects.filter(
        (project) =>
          project.id.toLocaleLowerCase().startsWith(query) ||
          project.name.toLocaleLowerCase().startsWith(query),
      );
  if (matches.length === 0) {
    return { ok: false, error: `No project matches "${raw}".` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `Ambiguous, matches: ${matches
        .map((project) => `${project.name} (${project.id})`)
        .join(", ")}`,
    };
  }
  return { ok: true, project: matches[0]! };
}

/**
 * Stop-all's real work, shared by `POST /api/engine/stop-all` and the
 * Telegram `/stopall` confirmation so there's exactly one place that does
 * it. One audit entry per affected project (not one global entry) since
 * `AuditEntry.projectId` is required and the Audit tab is per-project —
 * every affected project's own audit trail should show it was stopped,
 * with the full list of what else was hit alongside it.
 */
export async function stopAllProjects(
  db: Db,
  engine: EngineRunner,
  broadcast: (e: ServerEvent) => void,
  actor: "human" | "telegram",
  idempotencyKey?: string,
): Promise<string[]> {
  const projects = repo.getProjects(db);
  if (idempotencyKey) {
    const activeIds = projects
      .filter((project) => engine.hasActivity(project.id))
      .map((project) => project.id);
    const action = commitTelegramActionEffect<string[]>(db, idempotencyKey, () => {
      for (const id of activeIds) {
        repo.updateProject(db, id, { status: "paused" });
        repo.createAuditEntry(db, {
          projectId: id,
          kind: "stopped",
          actor,
          summary: `Stopped via global "Stop all" (${activeIds.length} project${activeIds.length === 1 ? "" : "s"} affected)`,
          detail: { affectedProjectIds: activeIds },
        });
      }
      return activeIds;
    });
    for (const id of action.result) {
      const project = repo.getProject(db, id);
      if (project?.status === "paused" && engine.hasActivity(id)) {
        await engine.pause(project, { drain: false });
      }
    }
    if (action.committed) {
      for (const id of action.result) {
        const updated = repo.getProject(db, id);
        if (updated) broadcast({ type: "project.updated", payload: updated });
      }
    }
    return action.result;
  }

  const stoppedIds = await engine.stopAll(projects);
  for (const id of stoppedIds) {
    repo.updateProject(db, id, { status: "paused" });
    const updated = repo.getProject(db, id)!;
    broadcast({ type: "project.updated", payload: updated });
    repo.createAuditEntry(db, {
      projectId: id,
      kind: "stopped",
      actor,
      summary: `Stopped via global "Stop all" (${stoppedIds.length} project${stoppedIds.length === 1 ? "" : "s"} affected)`,
      detail: { affectedProjectIds: stoppedIds },
    });
  }
  return stoppedIds;
}

/**
 * `/retry`'s real work, shared by `POST /api/tasks/:id/retry` and the
 * Telegram `/retry` command. Mirrors the HTTP route's own status codes as a
 * `status` field so an HTTP caller can still respond with the right one.
 */
export async function retryTask(
  db: Db,
  engine: EngineRunner,
  broadcast: (e: ServerEvent) => void,
  id: string,
  actor: "human" | "telegram",
  idempotencyKey?: string,
): Promise<{ ok: true; task: Task } | { ok: false; status: number; error: string }> {
  if (idempotencyKey) {
    const action = commitTelegramActionEffect<
      { ok: true; task: Task } | { ok: false; status: number; error: string }
    >(db, idempotencyKey, () => {
      const task = repo.getTask(db, id);
      if (!task) return { ok: false, status: 404, error: "task not found" };
      const retryable = ["failed", "changes_requested", "blocked"];
      if (!retryable.includes(task.status)) {
        return {
          ok: false,
          status: 409,
          error: `task is ${task.status}; only ${retryable.join("/")} can be retried`,
        };
      }
      const settings = repo.getSettings(db);
      if (!settings) return { ok: false, status: 500, error: "settings not found" };
      const budgetMsg = checkBudget(db, task.projectId, task.assignedModel, settings);
      if (budgetMsg) {
        return { ok: false, status: 403, error: `budget cap: ${budgetMsg}` };
      }
      const resetTask = repo.resetTaskForRetry(db, id, actor);
      return resetTask
        ? { ok: true, task: resetTask }
        : { ok: false, status: 409, error: "task lost the retry race" };
    });
    if (!action.result.ok) return action.result;
    const current = repo.getTask(db, id) ?? action.result.task;
    if (action.committed) broadcast({ type: "task.updated", payload: current });
    const project = repo.getProject(db, current.projectId)!;
    try {
      if (action.committed) {
        await engine.dispatchOne(project, id);
      } else {
        engine.resumeQueued(project);
      }
      return { ok: true, task: repo.getTask(db, id) ?? current };
    } catch (err) {
      return {
        ok: false,
        status: 409,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const task = repo.getTask(db, id);
  if (!task) return { ok: false, status: 404, error: "task not found" };

  const retryable = ["failed", "changes_requested", "blocked"];
  if (!retryable.includes(task.status)) {
    return {
      ok: false,
      status: 409,
      error: `task is ${task.status}; only ${retryable.join("/")} can be retried`,
    };
  }

  const settings = repo.getSettings(db);
  if (!settings) return { ok: false, status: 500, error: "settings not found" };

  const budgetMsg = checkBudget(db, task.projectId, task.assignedModel, settings);
  if (budgetMsg) return { ok: false, status: 403, error: `budget cap: ${budgetMsg}` };

  // O34: status qualification, generation increment, task-run reset, stale
  // execution cleanup, and the audit entry are one conditional SQLite
  // transaction. A concurrent HTTP/Telegram Retry that lost the race cannot
  // create a second logical run or audit entry.
  const resetTask = repo.resetTaskForRetry(db, id, actor);
  if (!resetTask) {
    const current = repo.getTask(db, id);
    return {
      ok: false,
      status: 409,
      error: current
        ? `task is ${current.status}; only ${retryable.join("/")} can be retried`
        : "task not found",
    };
  }
  broadcast({ type: "task.updated", payload: resetTask });

  const project = repo.getProject(db, task.projectId)!;
  try {
    return { ok: true, task: await engine.dispatchOne(project, id) };
  } catch (err) {
    return {
      ok: false,
      status: 409,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Finds the one task across every project whose id starts with `prefix` —
 * the Telegram `/retry <taskId-or-prefix>` command's matching logic (typing
 * a full UUID on a phone keyboard isn't realistic). Errors on zero or more
 * than one match; the ambiguous case lists every candidate so the human can
 * retype a longer prefix.
 */
export function findTaskByIdPrefix(
  db: Db,
  prefix: string,
): { ok: true; task: Task } | { ok: false; error: string } {
  const matches: Task[] = [];
  for (const p of repo.getProjects(db)) {
    for (const t of repo.getTasks(db, p.id)) {
      if (t.id.startsWith(prefix)) matches.push(t);
    }
  }
  if (matches.length === 0) return { ok: false, error: `No task matches "${prefix}".` };
  if (matches.length > 1) {
    return {
      ok: false,
      error: `Ambiguous, matches: ${matches.map((t) => `${t.id} (${t.title})`).join(", ")}`,
    };
  }
  return { ok: true, task: matches[0]! };
}

/**
 * `/autonomous`'s real work — flips the global merge policy and logs it
 * against every project's own audit trail (a policy flip has no single
 * project to hang the change off; every project's future dispatch behavior
 * is affected, so every project's Audit tab should show it, mirroring
 * stopAllProjects' own "one entry per affected project" shape above).
 */
export function setMergePolicy(
  db: Db,
  policy: MergePolicy,
  actor: "human" | "telegram",
  idempotencyKey?: string,
): void {
  if (idempotencyKey) {
    commitTelegramActionEffect(db, idempotencyKey, () => {
      setMergePolicy(db, policy, actor);
      return { policy };
    });
    return;
  }
  const current = repo.getSettings(db) ?? defaultSettings();
  repo.upsertSettings(db, { ...current, mergePolicy: policy });
  for (const p of repo.getProjects(db)) {
    repo.createAuditEntry(db, {
      projectId: p.id,
      kind: "settings_changed",
      actor,
      summary: `Merge policy changed to "${policy}"`,
    });
  }
}

export function setTelegramDigest(
  db: Db,
  digest: "off" | "terminal" | "all",
  idempotencyKey?: string,
): boolean {
  const apply = () => {
    const settings = repo.getSettings(db) ?? defaultSettings();
    if (!settings.telegram) return false;
    repo.upsertSettings(db, {
      ...settings,
      telegram: { ...settings.telegram, digest },
    });
    return true;
  };
  return idempotencyKey
    ? commitTelegramActionEffect(db, idempotencyKey, apply).result
    : apply();
}

/**
 * The model-health computation, shared by `GET /api/setup/model-health` and
 * the Telegram `/health` command.
 */
export function computeModelHealth(db: Db, engine: EngineRunner) {
  const settings = repo.getSettings(db) ?? defaultSettings();
  const latestChecks = new Map(
    repo.getLatestModelChecks(db).map((c) => [c.modelId, c]),
  );
  const runStats = new Map(repo.getModelRunStats(db).map((s) => [s.model, s]));

  return settings.models.map((m) => {
    const check = latestChecks.get(m.id);
    const stats = runStats.get(m.id);
    const coolingUntil = engine.getCoolingDownUntil(m.id);
    const quota = m.quota;
    const windowUsage = quota
      ? (() => {
          const sinceIso = new Date(
            Date.now() - quota.windowHours * 60 * 60 * 1000,
          ).toISOString();
          const usage = repo.getModelUsageSince(db, m.id, sinceIso);
          return {
            runs: usage.runs,
            costUsd: usage.costUsd,
            windowHours: quota.windowHours,
            maxRuns: quota.maxRuns,
            maxCostUsd: quota.maxCostUsd,
          };
        })()
      : undefined;
    return {
      id: m.id,
      displayName: m.displayName,
      enabled: m.enabled,
      effort: m.effort ?? "default",
      lastCheck: check
        ? {
            ok: check.ok,
            ts: check.ts,
            ms: check.ms,
            costUsd: check.costUsd,
            reply: check.reply,
            error: check.error,
          }
        : undefined,
      totalRuns: stats?.totalRuns ?? 0,
      failedRuns: stats?.failedRuns ?? 0,
      medianDurationMs: stats?.medianDurationMs ?? null,
      coolingDownUntil: coolingUntil ? new Date(coolingUntil).toISOString() : undefined,
      windowUsage,
    };
  });
}
