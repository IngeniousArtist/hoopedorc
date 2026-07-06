import {
  TASK_STATUSES,
  type EstimateResponse,
  type LogEvent,
  type ModelId,
  type RetryTaskResponse,
  type ServerEvent,
  type Settings as SettingsType,
  type StopTaskResponse,
  type Task,
  type TaskDiffResponse,
  type TaskEstimate,
  type TaskStatus,
} from "@orc/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useWS } from "../hooks/useWS";
import { useToast } from "../hooks/useToast";
import { TaskDrawer } from "../components/TaskDrawer";
import { TaskCard } from "../components/TaskCard";
import { BoardSummary } from "../components/BoardSummary";
import { AddTaskForm } from "../components/AddTaskForm";
import { MissionControl } from "../components/MissionControl";

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
  onViewNotifications,
}: {
  projectId: string;
  repoUrl?: string;
  /** F4's mission-control strip deep-links its pending-approvals count here. */
  onViewNotifications?: () => void;
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
  const [budgetUsd, setBudgetUsd] = useState<number | undefined>(undefined);
  // Per-task "last time we heard anything" (client receive time, so it's
  // immune to server clock skew). Drives the live heartbeat on running cards.
  const [activity, setActivity] = useState<Record<string, number>>({});
  // Re-render once a second so the heartbeat's "Ns ago" + color stay current
  // even when no new events arrive. Only ticks while a task is in_progress.
  const [, setNowTick] = useState(0);
  // F3: tasks with a stop request in flight — hides the Stop button on that
  // card so a slow click can't fire the request twice.
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(new Set());
  const [showAddTask, setShowAddTask] = useState(false);
  // F7: taskId -> pre-run cost estimate, for the Ready column's "~$0.03" chip.
  const [estimates, setEstimates] = useState<Record<string, TaskEstimate>>({});
  // U3: empty columns collapse to a slim strip by default (8 fixed-width
  // columns overflow at 1280px); a click or a drag hovering over one expands
  // it. Only ever holds statuses the user (or a drag) has explicitly opened —
  // a column with cards is never collapsed regardless of membership here.
  const [expandedEmpty, setExpandedEmpty] = useState<Set<TaskStatus>>(new Set());
  const [dragOverStatus, setDragOverStatus] = useState<TaskStatus | null>(null);

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

  const fetchEstimates = useCallback(async () => {
    try {
      const res = await api<EstimateResponse>("estimatePlan", {
        params: { id: projectId },
      });
      setEstimates(Object.fromEntries(res.tasks.map((t) => [t.taskId, t])));
    } catch {
      /* non-critical — the chip just doesn't show */
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [tasksRes, settingsRes, costRes] = await Promise.all([
          api<{ tasks: Task[] }>("listTasks", {
            params: { id: projectId },
          }),
          api<{ settings: SettingsType }>("getSettings"),
          api<{ totalUsd: number; budgetUsd?: number }>("costAnalytics", {
            params: { id: projectId },
          }).catch(() => ({ totalUsd: 0, budgetUsd: undefined })),
        ]);
        if (cancelled) return;
        setTasks(tasksRes.tasks);
        setSettings(settingsRes.settings);
        setCostUsd(costRes.totalUsd);
        setBudgetUsd(costRes.budgetUsd);
        fetchEstimates();
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
          // F7: a status change can move a task off the non-terminal set the
          // estimate is computed over (or change what's left to run) — cheap
          // enough to just refetch rather than try to patch it in place.
          fetchEstimates();
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
    [markActivity, fetchEstimates],
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

  const handleStop = async (taskId: string) => {
    setStoppingIds((prev) => new Set(prev).add(taskId));
    try {
      const res = await api<StopTaskResponse>("stopTask", {
        params: { id: taskId },
      });
      setTasks((prev) => prev.map((t) => (t.id === taskId ? res.task : t)));
      toast("Stopped — task moved to Blocked.", "success");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setStoppingIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  };

  const handleTaskAdded = (t: Task) => {
    setTasks((prev) => [...prev, t]);
    setShowAddTask(false);
    toast(`Added "${t.title}".`, "success");
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

  // U3: a collapsed column still needs to accept a drop, so dragover expands
  // it first (rather than requiring a click before every drag).
  const toggleColumnExpanded = (status: TaskStatus) => {
    setExpandedEmpty((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const handleColumnDragOver = (status: TaskStatus, e: React.DragEvent) => {
    handleDragOver(e);
    if (dragOverStatus !== status) setDragOverStatus(status);
  };

  const handleColumnDragLeave = (status: TaskStatus) => {
    setDragOverStatus((cur) => (cur === status ? null : cur));
  };

  const handleColumnDrop = (status: TaskStatus, e: React.DragEvent) => {
    setDragOverStatus(null);
    handleDrop(status, e);
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
    } catch (e) {
      // B21: B5's server rules reject most invalid moves with a genuinely
      // useful message ("can only requeue to backlog/ready", "stop it first")
      // — surface it instead of letting the card silently snap back, which
      // is indistinguishable from the drag not registering at all.
      toast(String(e), "error");
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

      <MissionControl
        projectId={projectId}
        tasks={tasks}
        models={settings?.models ?? []}
        activity={activity}
        costUsd={costUsd}
        budgetUsd={budgetUsd}
        onViewNotifications={() => onViewNotifications?.()}
      />

      <div className="mb-4">
        {showAddTask ? (
          <AddTaskForm
            projectId={projectId}
            tasks={tasks}
            onCreated={handleTaskAdded}
            onCancel={() => setShowAddTask(false)}
          />
        ) : (
          <button
            onClick={() => setShowAddTask(true)}
            className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            + Add task
          </button>
        )}
      </div>

      {/* snap-x makes mobile a one-column-at-a-time swipe; sm: reverts to the
          normal multi-column horizontal scroll once there's room for it. */}
      <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-4 sm:snap-none">
        {COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => t.status === col.status);
          // U3: never collapse a column that has cards, even if it was
          // toggled open-then-emptied earlier this session — only the
          // "still empty and not explicitly opened" case collapses.
          const collapsed =
            colTasks.length === 0 &&
            !expandedEmpty.has(col.status) &&
            dragOverStatus !== col.status;

          if (collapsed) {
            return (
              <button
                key={col.status}
                type="button"
                onClick={() => toggleColumnExpanded(col.status)}
                onDragOver={(e) => handleColumnDragOver(col.status, e)}
                onDragLeave={() => handleColumnDragLeave(col.status)}
                onDrop={(e) => handleColumnDrop(col.status, e)}
                title={`${col.label} — empty, click to expand`}
                className="flex w-9 shrink-0 flex-col items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900/50 py-3 hover:border-neutral-700"
              >
                <span className="rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500">
                  0
                </span>
                <span className="[writing-mode:vertical-rl] rotate-180 text-[10px] font-medium tracking-wider text-neutral-500 uppercase">
                  {col.label}
                </span>
              </button>
            );
          }

          return (
            <section
              key={col.status}
              onDragOver={(e) => handleColumnDragOver(col.status, e)}
              onDragLeave={() => handleColumnDragLeave(col.status)}
              onDrop={(e) => handleColumnDrop(col.status, e)}
              className="min-w-[85vw] max-w-[85vw] flex-1 snap-center rounded-lg border border-neutral-800 bg-neutral-900/50 p-3 sm:min-w-[220px] sm:max-w-[280px] sm:snap-none"
            >
              <h2
                onClick={
                  colTasks.length === 0
                    ? () => toggleColumnExpanded(col.status)
                    : undefined
                }
                className={
                  "mb-3 flex items-center gap-2 text-xs font-medium text-neutral-400 uppercase tracking-wider" +
                  (colTasks.length === 0 ? " cursor-pointer" : "")
                }
              >
                {col.label}
                <span className="rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                  {colTasks.length}
                </span>
              </h2>
              <div className="space-y-2">
                {colTasks.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    allTasks={tasks}
                    models={settings?.models ?? []}
                    lastActivityAt={activity[t.id]}
                    estimate={estimates[t.id]}
                    onClick={() =>
                      setSelectedTaskId(
                        selectedTaskId === t.id
                          ? null
                          : t.id,
                      )
                    }
                    onStop={
                      stoppingIds.has(t.id)
                        ? undefined
                        : () => handleStop(t.id)
                    }
                    isSelected={selectedTaskId === t.id}
                  />
                ))}
              </div>
            </section>
          );
        })}
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
          onModelChange={(m) => handleModelChange(selectedTask.id, m)}
        />
      )}
    </div>
  );
}
