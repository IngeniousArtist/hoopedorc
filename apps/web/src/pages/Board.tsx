import type {
  LogEvent,
  ModelId,
  RetryTaskResponse,
  ServerEvent,
  Settings as SettingsType,
  Task,
  TaskDiffResponse,
  TaskStatus,
} from "@orc/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useWS } from "../hooks/useWS";
import { LogPanel } from "../components/LogPanel";
import { TaskCard } from "../components/TaskCard";

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "backlog", label: "Backlog" },
  { status: "ready", label: "Ready" },
  { status: "in_progress", label: "In Progress" },
  { status: "in_review", label: "In Review" },
  { status: "changes_requested", label: "Changes Req." },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
  { status: "failed", label: "Failed" },
];

export function Board({ projectId }: { projectId: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const selectedTaskIdRef = useRef(selectedTaskId);
  selectedTaskIdRef.current = selectedTaskId;

  const selectedTask =
    tasks.find((t) => t.id === selectedTaskId) ?? null;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [tasksRes, settingsRes] = await Promise.all([
          api<{ tasks: Task[] }>("listTasks", {
            params: { id: projectId },
          }),
          api<{ settings: SettingsType }>("getSettings"),
        ]);
        if (cancelled) return;
        setTasks(tasksRes.tasks);
        setSettings(settingsRes.settings);
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
        const runsRes = await api<{
          runs: { id: string }[];
        }>("listTaskRuns", {
          params: { id: selectedTaskId! },
        });
        if (cancelled) return;
        const logsResults = await Promise.all(
          runsRes.runs.map((r) =>
            api<{ logs: LogEvent[] }>("runLogs", {
              params: { id: r.id },
            }).catch(() => ({ logs: [] as LogEvent[] })),
          ),
        );
        if (cancelled) return;
        const allLogs = logsResults
          .flatMap((r) => r.logs)
          .sort(
            (a, b) =>
              new Date(a.ts).getTime() - new Date(b.ts).getTime(),
          );
        setLogs(allLogs);
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

  const handleWSEvent = useCallback((event: ServerEvent) => {
    switch (event.type) {
      case "task.updated": {
        const updated = event.payload;
        setTasks((prev) =>
          prev.map((t) => (t.id === updated.id ? updated : t)),
        );
        break;
      }
      case "run.updated": {
        /* run status changes may reflect in task state; refetch */
        break;
      }
      case "log": {
        const logEvent = event.payload;
        if (logEvent.taskId === selectedTaskIdRef.current) {
          setLogs((prev) => [...prev, logEvent]);
        }
        break;
      }
    }
  }, []);

  useWS(projectId, handleWSEvent);

  const handleRollback = async (taskId: string, prNumber: number) => {
    if (
      !window.confirm(
        `Revert PR #${prNumber}? This pushes a revert commit to the default branch.`,
      )
    )
      return;
    setActionBusy(true);
    setActionMsg(null);
    try {
      const res = await api<{ task: Task }>("rollbackTask", {
        params: { id: taskId },
      });
      setTasks((prev) =>
        prev.map((t) => (t.id === taskId ? res.task : t)),
      );
      setActionMsg(`Reverted PR #${prNumber}.`);
    } catch (e) {
      setActionMsg(String(e));
    } finally {
      setActionBusy(false);
    }
  };

  const handleRetry = async (taskId: string) => {
    setActionBusy(true);
    setActionMsg(null);
    try {
      const res = await api<RetryTaskResponse>("retryTask", {
        params: { id: taskId },
      });
      setTasks((prev) => prev.map((t) => (t.id === taskId ? res.task : t)));
      setActionMsg("Retrying — dispatched a fresh run.");
    } catch (e) {
      setActionMsg(String(e));
    } finally {
      setActionBusy(false);
    }
  };

  const handleViewDiff = async (taskId: string) => {
    setActionBusy(true);
    setActionMsg(null);
    setDiff(null);
    try {
      const res = await api<TaskDiffResponse>("taskDiff", {
        params: { id: taskId },
      });
      setDiff(res.diff || "(empty diff)");
    } catch (e) {
      setActionMsg(String(e));
    } finally {
      setActionBusy(false);
    }
  };

  // Clear the action area when switching tasks.
  useEffect(() => {
    setDiff(null);
    setActionMsg(null);
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
      setError(String(e));
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
              <span className="rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500">
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
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
            <span className="text-sm text-neutral-300">
              {selectedTask.title}
            </span>
            {selectedTask.prNumber && (
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] text-neutral-400">
                PR #{selectedTask.prNumber}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {selectedTask.prNumber && (
                <button
                  onClick={() => handleViewDiff(selectedTask.id)}
                  disabled={actionBusy}
                  className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
                >
                  View PR diff
                </button>
              )}
              {(selectedTask.status === "failed" ||
                selectedTask.status === "changes_requested" ||
                selectedTask.status === "blocked") && (
                <button
                  onClick={() => handleRetry(selectedTask.id)}
                  disabled={actionBusy}
                  className="rounded border border-blue-800 px-3 py-1 text-xs text-blue-300 hover:bg-blue-950/40 disabled:opacity-50"
                >
                  {actionBusy ? "Working…" : "↻ Retry task"}
                </button>
              )}
              {selectedTask.status === "done" && selectedTask.prNumber && (
                <button
                  onClick={() =>
                    handleRollback(selectedTask.id, selectedTask.prNumber!)
                  }
                  disabled={actionBusy}
                  className="rounded border border-amber-800 px-3 py-1 text-xs text-amber-300 hover:bg-amber-950/40 disabled:opacity-50"
                >
                  {actionBusy ? "Working…" : "↩ Rollback merge"}
                </button>
              )}
            </div>
          </div>
          {actionMsg && (
            <div className="rounded border border-neutral-800 bg-neutral-900/50 px-4 py-2 text-xs text-neutral-300">
              {actionMsg}
            </div>
          )}
          {diff && (
            <pre className="max-h-96 overflow-auto rounded-lg border border-neutral-800 bg-neutral-950 p-3 font-mono text-[11px] leading-relaxed text-neutral-300">
              {diff}
            </pre>
          )}
          <LogPanel
            logs={logs}
            loading={logsLoading}
            taskTitle={selectedTask.title}
            onClose={() => setSelectedTaskId(null)}
          />
        </div>
      )}
    </div>
  );
}
