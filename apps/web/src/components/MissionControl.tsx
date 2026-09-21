import type {
  ListNotificationsResponse,
  ModelConfig,
  ServerEvent,
  Task,
} from "@orc/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useNowTick } from "../hooks/useNowTick";
import { useWS } from "../hooks/useWS";
import { Heartbeat, agoLabel } from "./TaskCard";

/**
 * Slim "what's the team doing right now" strip above the Board's columns
 * (F4): one row per active agent and a pending approvals count that
 * deep-links to Notifications. VW04 moved the budget bar into BoardSummary so
 * the two strips no longer duplicate the runtime dashboard; `costUsd`/
 * `budgetUsd` stay in the props for callers that still pass them. Reuses
 * data Board.tsx already tracks (tasks, the activity/heartbeat map) — only
 * the approvals count needs its own fetch.
 */
export function MissionControl({
  projectId,
  tasks,
  models,
  activity,
  activeSince,
  onViewNotifications,
}: {
  projectId: string;
  tasks: Task[];
  models: ModelConfig[];
  activity: Record<string, number>;
  /** U13: client-tracked "entered the active set" timestamp per task,
   *  stable across in_progress <-> in_review — falls back to
   *  task.updatedAt (below) for a task active before the page loaded, the
   *  only case with no entry yet. */
  activeSince: Record<string, number>;
  /** Kept for API compatibility; the budget bar now lives in BoardSummary. */
  costUsd?: number;
  budgetUsd?: number;
  onViewNotifications: () => void;
}) {
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const approvalsAuthorityRef = useRef(0);

  const fetchApprovals = useCallback(async () => {
    const authorityAtRequest = approvalsAuthorityRef.current;
    try {
      // listNotifications has no server-side project filter wired up on the
      // client side anywhere yet (Notifications.tsx doesn't use one either)
      // — filter client-side by the Notification's own projectId field.
      const res = await api<ListNotificationsResponse>("listNotifications");
      if (approvalsAuthorityRef.current !== authorityAtRequest) return;
      setPendingApprovals(
        res.notifications.filter(
          (n) =>
            n.projectId === projectId && n.requiresApproval && !n.respondedWith,
        ).length,
      );
    } catch {
      /* non-critical — the strip just omits the approvals count */
    }
  }, [projectId]);

  useEffect(() => {
    fetchApprovals();
  }, [fetchApprovals]);

  const onWS = useCallback(
    (e: ServerEvent) => {
      if (e.type === "notifications.snapshot") {
        approvalsAuthorityRef.current++;
        setPendingApprovals(
          e.payload.notifications.filter(
            (notification) =>
              notification.projectId === projectId &&
              notification.requiresApproval &&
              !notification.respondedWith,
          ).length,
        );
      } else if (e.type === "notification") {
        approvalsAuthorityRef.current++;
        fetchApprovals();
      }
    },
    [fetchApprovals, projectId],
  );
  useWS(projectId, onWS);

  const active = tasks.filter(
    (t) => t.status === "in_progress" || t.status === "in_review",
  );
  useNowTick(active.length > 0);

  if (active.length === 0 && pendingApprovals === 0) {
    return null;
  }

  return (
    <div
      data-testid="mission-control"
      className="mb-3 space-y-2 rounded-lg border border-neutral-800 bg-neutral-900/50 px-3 py-2"
    >
      {active.length > 0 && (
        <div className="space-y-1">
          {active.map((t) => {
            const model = models.find((m) => m.id === t.assignedModel);
            // U13: prefer the stable "entered the active set" timestamp over
            // task.updatedAt, which bumps on the in_progress -> in_review
            // transition too (B6) and made this visibly reset mid-attempt.
            // Falls back to updatedAt only when there's no tracked entry yet
            // (a task that was already active when the page first loaded).
            const since = activeSince[t.id] ?? new Date(t.updatedAt).getTime();
            const elapsedMs = Date.now() - since;
            return (
              <div key={t.id} className="flex items-center gap-2 text-xs">
                <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-300">
                  {model?.displayName ?? t.assignedModel}
                </span>
                <span className="min-w-0 flex-1 truncate text-neutral-300">
                  {t.title}
                </span>
                <span className="shrink-0 text-[11px] text-neutral-500">
                  elapsed {agoLabel(elapsedMs).replace(/ ago$/, "")}
                </span>
                <Heartbeat lastActivityAt={activity[t.id]} />
              </div>
            );
          })}
        </div>
      )}

      {pendingApprovals > 0 && (
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={onViewNotifications}
            className="shrink-0 rounded border border-amber-800 px-2 py-0.5 text-[11px] text-amber-300 hover:bg-amber-950/40 focus-visible:ring-2 focus-visible:ring-amber-400"
          >
            {pendingApprovals} pending approval{pendingApprovals === 1 ? "" : "s"} {"→"}
          </button>
        </div>
      )}
    </div>
  );
}
