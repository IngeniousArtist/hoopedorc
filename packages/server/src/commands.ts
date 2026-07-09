// F40: action logic shared between the HTTP routes and the Telegram command
// wave (`telegramCommand` in index.ts). Kept in its own module — unlike
// index.ts, which boots a real server as a side effect of being imported
// (`main()` runs unconditionally at the bottom of that file) — so these are
// actually unit-testable against a real in-memory DB, the same reasoning
// budget.ts/scheduler.ts/attachments.ts are their own modules.

import type { MergePolicy, ServerEvent, Task } from "@orc/types";
import { checkBudget } from "./budget";
import { defaultSettings } from "./config";
import type { Db } from "./db/index";
import * as repo from "./db/repo";
import type { EngineRunner } from "./engine-runner";

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
): Promise<string[]> {
  const projects = repo.getProjects(db);
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
export function retryTask(
  db: Db,
  engine: EngineRunner,
  broadcast: (e: ServerEvent) => void,
  id: string,
  actor: "human" | "telegram",
): { ok: true; task: Task } | { ok: false; status: number; error: string } {
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

  if (engine.isRunning(task.projectId)) {
    return {
      ok: false,
      status: 409,
      error: "project is running autonomously — pause it before retrying a task manually",
    };
  }

  const settings = repo.getSettings(db);
  if (!settings) return { ok: false, status: 500, error: "settings not found" };

  const budgetMsg = checkBudget(db, task.projectId, task.assignedModel, settings);
  if (budgetMsg) return { ok: false, status: 403, error: `budget cap: ${budgetMsg}` };

  // Also clear prNumber/branch/worktreePath: a prior failed attempt may have
  // already pushed to and opened a PR on `orc/<taskId>`. Without this, the
  // new attempt's worktree (freshly branched off origin/<default>) can't
  // push to that same branch name — its remote ref has diverged — and the
  // push is rejected as non-fast-forward, failing every retry regardless of
  // which model runs it.
  repo.updateTask(
    db,
    id,
    {
      status: "in_progress",
      attempts: 1,
      prNumber: null,
      branch: null,
      worktreePath: null,
    } as Record<string, unknown> as Parameters<typeof repo.updateTask>[2],
  );
  const updatedTask = repo.getTask(db, id)!;
  repo.createAuditEntry(db, {
    projectId: task.projectId,
    taskId: id,
    kind: "retry",
    actor,
    summary: `Retried "${task.title}"`,
  });
  broadcast({ type: "task.updated", payload: updatedTask });

  const project = repo.getProject(db, task.projectId)!;
  void engine.dispatchOne(project, id);
  return { ok: true, task: updatedTask };
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
): void {
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
