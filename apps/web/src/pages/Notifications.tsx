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

      <div className="space-y-3">
        {notifications.map((n) => (
          <div
            key={n.id}
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

            {n.requiresApproval &&
              n.options &&
              !n.respondedWith && (
                <div className="mt-3 flex gap-2">
                  {n.options.map((option) => (
                    <button
                      key={option}
                      onClick={() =>
                        respond(n.id, option)
                      }
                      className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
                    >
                      {option}
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
        ))}
      </div>
    </div>
  );
}
