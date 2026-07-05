import {
  TASK_STATUSES,
  type LogEvent,
  type ModelId,
  type RetryTaskResponse,
  type ServerEvent,
  type Settings as SettingsType,
  type Task,
  type TaskDiffResponse,
  type TaskStatus,
} from "@orc/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useWS } from "../hooks/useWS";
import { useToast } from "../hooks/useToast";
import { TaskDrawer } from "../components/TaskDrawer";
import { TaskCard } from "../components/TaskCard";
import { BoardSummary } from "../components/BoardSummary";

// Record so adding a TaskStatus in @orc/types is a compile error here until
// it gets a label too — the column list itself is derived from TASK_STATUSES
// (single source of truth shared with the server's PATCH validation) so the
// two can't silently drift apart.
const COLUMN_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In Progress",
  in_review: "In Review",
  changes_requested: "Changes Req.",
  blocked: "Blocked",
  done: "Done",
  failed: "Failed",
};
const COLUMNS: { status: TaskStatus; label: string }[] = TASK_STATUSES.map(
  (status) => ({ status, label: COLUMN_LABELS[status] }),
);

export function Board({
  projectId,
  repoUrl,
}: {
  projectId: string;
  repoUrl?: string;
}) {
  const toast = useToast();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [costUsd, setCostUsd] = useState(0);
  // Per-task "last time we heard anything" (client receive time, so it's
  // immune to server clock skew). Drives the live heartbeat on running cards.
  const [activity, setActivity] = useState<Record<string, number>>({});
  // Re-render once a second so the heartbeat's "Ns ago" + color stay current
  // even when no new events arrive. Only ticks while a task is in_progress.
  const [, setNowTick] = useState(0);

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const selectedTaskIdRef = useRef(selectedTaskId);
  selectedTaskIdRef.current = selectedTaskId;
  // handleWSEvent has empty deps, so read projectId through a ref to filter
  // events without making the callback (and the WS subscription) churn.
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const selectedTask =
    tasks.find((t) => t.id === selectedTaskId) ?? null;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [tasksRes, settingsRes, costRes] = await Promise.all([
          api<{ tasks: Task[] }>("listTasks", {
            params: { id: projectId },
          }),
          api<{ settings: SettingsType }>("getSettings"),
          api<{ totalUsd: number }>("costAnalytics", {
            params: { id: projectId },
          }).catch(() => ({ totalUsd: 0 })),
        ]);
        if (cancelled) return;
        setTasks(tasksRes.tasks);
        setSettings(settingsRes.settings);
        setCostUsd(costRes.totalUsd);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!selectedTaskId) {
      setLogs([]);
      return;
    }
    let cancelled = false;
    async function loadLogs() {
      setLogsLoading(true);
      setLogs([]);
      try {
        // Every onLog emission is keyed by task_id regardless of run, so one
        // task-scoped call gets full history after a reload — the old
        // per-run fan-out (GET /api/runs/:id/logs per run) matched nothing
        // because runId was hardcoded to "" almost everywhere it's written.
        const res = await api<{ logs: LogEvent[] }>("taskLogs", {
          params: { id: selectedTaskId! },
        });
        if (cancelled) return;
        setLogs(res.logs);
      } catch {
        /* ignore fetch errors for logs */
      } finally {
        if (!cancelled) setLogsLoading(false);
      }
    }
    loadLogs();
    return () => {
      cancelled = true;
    };
  }, [selectedTaskId]);

  const markActivity = useCallback((taskId: string | undefined) => {
    if (taskId) setActivity((a) => ({ ...a, [taskId]: Date.now() }));
  }, []);

  const handleWSEvent = useCallback(
    (event: ServerEvent) => {
      switch (event.type) {
        case "task.updated": {
          const updated = event.payload;
          setTasks((prev) =>
            prev.map((t) => (t.id === updated.id ? updated : t)),
          );
          // Seed/refresh the heartbeat (covers a freshly-dispatched task).
          markActivity(updated.id);
          break;
        }
        case "run.updated": {
          markActivity(event.payload.taskId);
          break;
        }
        case "cost.updated": {
          // The hub broadcasts to all clients; only count this project's spend
          // (a concurrently-running project would otherwise inflate the total).
          if (event.payload.projectId === projectIdRef.current) {
            setCostUsd((c) => c + event.payload.costUsd);
          }
          break;
        }
        case "log": {
          const logEvent = event.payload;
          // Any log line for any task = that model is alive right now.
          markActivity(logEvent.taskId);
          if (logEvent.taskId === selectedTaskIdRef.current) {
            setLogs((prev) => [...prev, logEvent]);
          }
          break;
        }
      }
    },
    [markActivity],
  );

  useWS(projectId, handleWSEvent);

  // 1s heartbeat ticker — only runs while something is in_progress, so an idle
  // board doesn't re-render needlessly.
  const hasRunning = tasks.some(
    (t) => t.status === "in_progress" || t.status === "in_review",
  );
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  const handleRollback = async (taskId: string, prNumber: number) => {
    if (
      !window.confirm(
        `Revert PR #${prNumber}? This pushes a revert commit to the default branch.`,
      )
    )
      return;
    setActionBusy(true);
    try {
      const res = await api<{ task: Task }>("rollbackTask", {
        params: { id: taskId },
      });
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? res.task : t)),
      );
      toast(`Reverted PR #${prNumber}.`, "success");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handleRetry = async (taskId: string) => {
    setActionBusy(true);
    try {
      const res = await api<RetryTaskResponse>("retryTask", {
        params: { id: taskId },
      });
      setTasks((prev) => prev.map((t) => (t.id === taskId ? res.task : t)));
      toast("Retrying — dispatched a fresh run.", "success");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handleViewDiff = async (taskId: string) => {
    setActionBusy(true);
    setDiff(null);
    try {
      const res = await api<TaskDiffResponse>("taskDiff", {
        params: { id: taskId },
      });
      setDiff(res.diff || "(empty diff)");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setActionBusy(false);
    }
  };

  // Clear the diff view when switching tasks.
  useEffect(() => {
    setDiff(null);
  }, [selectedTaskId]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = async (
    status: TaskStatus,
    e: React.DragEvent,
  ) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData("text/plain");
    if (!taskId) return;

    const task = tasksRef.current.find((t) => t.id === taskId);
    if (!task || task.status === status) return;

    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId ? { ...t, status } : t,
      ),
    );

    try {
      await api<{ task: Task }>("updateTask", {
        params: { id: taskId },
        body: { status },
      });
    } catch {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId ? { ...t, status: task.status } : t,
        ),
      );
    }
  };

  const handleModelChange = async (
    taskId: string,
    model: ModelId,
  ) => {
    const task = tasksRef.current.find((t) => t.id === taskId);
    if (!task || task.assignedModel === model) return;

    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId ? { ...t, assignedModel: model } : t,
      ),
    );

    try {
      await api<{ task: Task }>("updateTask", {
        params: { id: taskId },
        body: { assignedModel: model },
      });
    } catch (e) {
      toast(String(e), "error");
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? { ...t, assignedModel: task.assignedModel }
            : t,
        ),
      );
    }
  };

  return (
    <div>
      {error && (
        <div className="mb-4 rounded border border-red-800 bg-red-950/50 px-4 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <BoardSummary tasks={tasks} costUsd={costUsd} />

      {/* snap-x makes mobile a one-column-at-a-time swipe; sm: reverts to the
          normal multi-column horizontal scroll once there's room for it. */}
      <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-4 sm:snap-none">
        {COLUMNS.map((col) => (
          <section
            key={col.status}
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(col.status, e)}
            className="min-w-[85vw] max-w-[85vw] flex-1 snap-center rounded-lg border border-neutral-800 bg-neutral-900/50 p-3 sm:min-w-[220px] sm:max-w-[280px] sm:snap-none"
          >
            <h2 className="mb-3 flex items-center gap-2 text-xs font-medium text-neutral-400 uppercase tracking-wider">
              {col.label}
              <span className="rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                {
                  tasks.filter((t) => t.status === col.status)
                    .length
                }
              </span>
            </h2>
            <div className="space-y-2">
              {tasks
                .filter((t) => t.status === col.status)
                .map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    allTasks={tasks}
                    models={settings?.models ?? []}
                    lastActivityAt={activity[t.id]}
                    onModelChange={(m) =>
                      handleModelChange(t.id, m)
                    }
                    onClick={() =>
                      setSelectedTaskId(
                        selectedTaskId === t.id
                          ? null
                          : t.id,
                      )
                    }
                    isSelected={selectedTaskId === t.id}
                  />
                ))}
            </div>
          </section>
        ))}
      </div>

      {selectedTask && (
        <TaskDrawer
          task={selectedTask}
          models={settings?.models ?? []}
          repoUrl={repoUrl}
          logs={logs}
          logsLoading={logsLoading}
          diff={diff}
          actionBusy={actionBusy}
          onClose={() => setSelectedTaskId(null)}
          onViewDiff={() => handleViewDiff(selectedTask.id)}
          onRetry={() => handleRetry(selectedTask.id)}
          onRollback={() =>
            handleRollback(selectedTask.id, selectedTask.prNumber!)
          }
        />
      )}
    </div>
  );
}
