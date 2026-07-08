import type {
  Notification as NotifType,
  ServerEvent,
} from "@orc/types";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { useWS } from "../hooks/useWS";

const SEVERITY_BORDERS: Record<string, string> = {
  info: "border-neutral-700",
  warn: "border-amber-700",
  action_required: "border-red-700",
};

const SEVERITY_BG: Record<string, string> = {
  info: "bg-neutral-900",
  warn: "bg-amber-950/30",
  action_required: "bg-red-950/30",
};

/** U15: `approve`/`approve_merge`/`approve_anyway` etc. → "Approve",
 *  "Approve Merge", "Approve Anyway"; `reject` → "Reject". Title Case to
 *  match every other button label in the app. */
function formatOptionLabel(option: string): string {
  return option
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** U14: shared card render so the pending and non-pending groups below
 *  don't duplicate this markup. */
function NotificationCard({
  n,
  onRespond,
}: {
  n: NotifType;
  onRespond: (notifId: string, choice: string) => void;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${SEVERITY_BORDERS[n.severity]} ${SEVERITY_BG[n.severity]}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-neutral-200">
            {n.title}
          </div>
          <div className="mt-1 text-xs text-neutral-400">
            {n.message}
          </div>
          <div className="mt-2 text-[10px] text-neutral-600">
            {new Date(
              n.createdAt,
            ).toLocaleString()}
          </div>
        </div>
        {n.severity === "action_required" && (
          <span className="shrink-0 rounded bg-red-900/50 px-2 py-0.5 text-[10px] font-medium text-red-300">
            Action
          </span>
        )}
      </div>

      {/* F22: the same PR link + validator reasons Telegram's
          approval message already carries — deciding from the app
          shouldn't mean hunting the Board for the task's drawer.
          Absent on notifications that aren't a merge approval and on
          any row that predates this field. */}
      {n.context && (n.context.prUrl || n.context.reasons?.length) ? (
        <div className="mt-3 space-y-1.5 rounded border border-neutral-800 bg-neutral-950/50 px-3 py-2">
          {n.context.prUrl && (
            <a
              href={n.context.prUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-xs text-blue-400 hover:underline"
            >
              View PR ↗
            </a>
          )}
          {n.context.reasons && n.context.reasons.length > 0 && (
            <ul className="list-inside list-disc space-y-0.5 text-[11px] text-neutral-400">
              {n.context.reasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {n.requiresApproval &&
        n.options &&
        !n.respondedWith && (
          <div className="mt-3 flex gap-2">
            {/* U15: this is the highest-stakes control in the app (it
                authorizes a merge to main) — approve and reject previously
                rendered as two identical solid-blue buttons, giving a
                phone-tapping user zero visual guardrail. Only the
                "approve*" option gets the primary treatment; anything else
                (reject, and any future option) gets the same bordered
                secondary style used for every other reject/stop/remove
                control in the app. */}
            {n.options.map((option) => (
              <button
                key={option}
                onClick={() =>
                  onRespond(n.id, option)
                }
                className={
                  option.startsWith("approve")
                    ? "rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
                    : "rounded border border-red-900 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-950/50"
                }
              >
                {formatOptionLabel(option)}
              </button>
            ))}
          </div>
        )}

      {n.respondedWith === "expired_restart" && (
        <div className="mt-3 text-xs text-amber-500">
          Expired — the server restarted while this was pending
        </div>
      )}
      {n.respondedWith && n.respondedWith !== "expired_restart" && (
        <div className="mt-3 text-xs text-neutral-400">
          Responded: {n.respondedWith}
        </div>
      )}
    </div>
  );
}

export function Notifications({
  projectId,
}: {
  projectId: string;
}) {
  const [notifications, setNotifications] = useState<
    NotifType[]
  >([]);
  const [error, setError] = useState<string | null>(null);

  const fetchNotifications = useCallback(async () => {
    try {
      const data = await api<{ notifications: NotifType[] }>(
        "listNotifications",
      );
      setNotifications(data.notifications);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  const handleWSEvent = useCallback(
    (event: ServerEvent) => {
      if (event.type === "notification") {
        const notif = event.payload;
        setNotifications((prev) => {
          const idx = prev.findIndex(
            (n) => n.id === notif.id,
          );
          if (idx >= 0) {
            return prev.map((n, i) =>
              i === idx ? notif : n,
            );
          }
          return [notif, ...prev];
        });
      }
    },
    [],
  );

  useWS(projectId, handleWSEvent);

  const respond = async (
    notifId: string,
    choice: string,
  ) => {
    try {
      await api("respondNotification", {
        params: { id: notifId },
        body: { choice },
      });
      setNotifications((prev) =>
        prev.map((n) =>
          n.id === notifId
            ? { ...n, respondedWith: choice }
            : n,
        ),
      );
    } catch (e) {
      setError(String(e));
    }
  };

  if (error) {
    return (
      <div className="text-sm text-red-400">Error: {error}</div>
    );
  }

  // U14: the one thing that actually blocks a run — a pending approval —
  // could sit below newer info/warn noise in plain chronological order.
  // .filter() is stable, so each group stays newest-first (the fetch/WS
  // order already is) without needing a full re-sort.
  const isPending = (n: NotifType) => n.requiresApproval && !n.respondedWith;
  const pending = notifications.filter(isPending);
  const rest = notifications.filter((n) => !isPending(n));

  return (
    <div className="max-w-2xl">
      <h2 className="mb-6 text-lg font-semibold">
        Notifications
      </h2>

      {notifications.length === 0 && (
        <div className="text-sm text-neutral-400">
          No notifications.
        </div>
      )}

      {pending.length > 0 && (
        <div className="mb-2 text-[10px] uppercase tracking-wide text-amber-500">
          Needs response
        </div>
      )}
      {pending.length > 0 && (
        <div className="space-y-3">
          {pending.map((n) => (
            <NotificationCard key={n.id} n={n} onRespond={respond} />
          ))}
        </div>
      )}

      {pending.length > 0 && rest.length > 0 && (
        <div className="mb-2 mt-6 text-[10px] uppercase tracking-wide text-neutral-600">
          Other
        </div>
      )}
      {rest.length > 0 && (
        <div className="space-y-3">
          {rest.map((n) => (
            <NotificationCard key={n.id} n={n} onRespond={respond} />
          ))}
        </div>
      )}
    </div>
  );
}
