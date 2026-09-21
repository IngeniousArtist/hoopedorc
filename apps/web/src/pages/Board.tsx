import {
  type EstimateResponse,
  type LogEvent,
  type ModelId,
  type RetryTaskResponse,
  type RollbackJob,
  type RollbackTaskResponse,
  type ServerEvent,
  type Settings as SettingsType,
  type StopTaskResponse,
  type Task,
  type TaskDiffResponse,
  type TaskEstimate,
  type TaskRollbackResponse,
  type TaskStatus,
} from "@orc/types";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { api, isAbortError } from "../api/client";
import { appendTaskLog, retainNewestTaskLogs } from "../lib/taskLogs";
import {
  BOARD_GROUPS,
  defaultListGroup,
  groupForStatus,
  tasksInGroup,
  type BoardGroupKey,
} from "../lib/boardGroups";
import { useWS } from "../hooks/useWS";
import { useToast } from "../hooks/useToast";
import { TaskDrawer } from "../components/TaskDrawer";
import { TaskCard } from "../components/TaskCard";
import { BoardSummary } from "../components/BoardSummary";
import { AddTaskForm } from "../components/AddTaskForm";
import { MissionControl } from "../components/MissionControl";
import {
  errorMessage,
  useConfirmation,
} from "../components/ConfirmationDialog";

const EMPTY_MODELS: NonNullable<SettingsType["models"]> = [];

// VW04: the board is five outcome groups over the existing statuses (see
// lib/boardGroups.ts). Phones default to a status-filtered list; the Kanban
// stays one toggle away. Both preferences persist per browser.
type BoardViewMode = "kanban" | "list";
const VIEW_STORAGE_KEY = "hoop.board.view";
const ENGINEERING_STORAGE_KEY = "hoop.board.engineering";
const PHONE_MEDIA_QUERY = "(max-width: 639px)";

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* best effort — a private-mode browser just loses the preference */
  }
}

function initialViewMode(): BoardViewMode {
  const stored = readStorage(VIEW_STORAGE_KEY);
  if (stored === "kanban" || stored === "list") return stored;
  return typeof window !== "undefined" && window.matchMedia?.(PHONE_MEDIA_QUERY).matches
    ? "list"
    : "kanban";
}

type TaskAuthority = {
  projectId: string;
  version: number;
  tasks: Map<string, { task: Task; version: number }>;
};

type BoardRequest = {
  projectId: string;
  generation: number;
};

export function Board({
  projectId,
  repoUrl,
  selectedTaskId: selectedTaskIdProp,
  onSelectTask,
  onViewNotifications,
}: {
  projectId: string;
  repoUrl?: string;
  /** VW04: when provided, the app shell owns which task's inspector is open
   *  (it is part of the URL); otherwise the Board keeps that state itself. */
  selectedTaskId?: string | null;
  onSelectTask?: (taskId: string | null) => void;
  /** F4's mission-control strip deep-links its pending-approvals count here. */
  onViewNotifications?: () => void;
}) {
  const toast = useToast();
  const { requestConfirmation, confirmationDialog } = useConfirmation();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [internalSelectedTaskId, setInternalSelectedTaskId] = useState<string | null>(null);
  const controlledSelection = selectedTaskIdProp !== undefined;
  const selectedTaskId = controlledSelection ? selectedTaskIdProp : internalSelectedTaskId;
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [logsOmittedOlder, setLogsOmittedOlder] = useState(false);
  const logsOmittedOlderRef = useRef(false);
  const [logsLoading, setLogsLoading] = useState(false);
  // VW04: a failed history read is reported as such — never as "no logs" or
  // "no rollback" — and can be retried without closing the inspector.
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsReloadNonce, setLogsReloadNonce] = useState(0);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [rollbackJobs, setRollbackJobs] = useState<Record<string, RollbackJob>>({});
  const [diff, setDiff] = useState<string | null>(null);
  const [costUsd, setCostUsd] = useState(0);
  const [budgetUsd, setBudgetUsd] = useState<number | undefined>(undefined);
  // Per-task "last time we heard anything" (client receive time, so it's
  // immune to server clock skew). Drives the live heartbeat on running cards.
  const [activity, setActivity] = useState<Record<string, number>>({});
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
  const [expandedEmpty, setExpandedEmpty] = useState<Set<BoardGroupKey>>(new Set());
  const [dragOverGroup, setDragOverGroup] = useState<BoardGroupKey | null>(null);
  const [viewMode, setViewModeState] = useState<BoardViewMode>(initialViewMode);
  const [engineering, setEngineeringState] = useState(
    () => readStorage(ENGINEERING_STORAGE_KEY) === "1",
  );
  // The phone list shows one group at a time; null means "not chosen yet",
  // which resolves to the most urgent non-empty group.
  const [listGroup, setListGroup] = useState<BoardGroupKey | null>(null);
  const [pendingFocusGroup, setPendingFocusGroup] = useState<BoardGroupKey | null>(null);
  const columnRefs = useRef(new Map<BoardGroupKey, HTMLElement>());
  // U13: when a task entered its current active (in_progress/in_review)
  // stretch — client receive time, kept stable across the in_progress <->
  // in_review transition within the same attempt (unlike task.updatedAt,
  // which bumps on that transition too and made MissionControl's "elapsed"
  // visibly reset mid-attempt). Cleared once a task leaves the active set,
  // so a later re-entry (a retry) starts a fresh count instead of an old,
  // no-longer-relevant one. No entry yet (a task active since before this
  // page loaded) falls back to task.updatedAt in MissionControl itself.
  const [activeSince, setActiveSince] = useState<Record<string, number>>({});

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const selectedTaskIdRef = useRef(selectedTaskId);
  selectedTaskIdRef.current = selectedTaskId;
  // handleWSEvent has empty deps, so read projectId through a ref to filter
  // events without making the callback (and the WS subscription) churn.
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  // A keyed Board unmount can leave an awaited action holding the old
  // projectIdRef alive long enough to mutate state or emit a toast. The
  // instance generation is invalidated by cleanup so every action can guard
  // both project identity and the lifetime of the instance that started it.
  const lifecycleRef = useRef({ active: true, generation: 0 });
  useLayoutEffect(() => {
    const generation = lifecycleRef.current.generation + 1;
    lifecycleRef.current = { active: true, generation };
    return () => {
      if (lifecycleRef.current.generation !== generation) return;
      lifecycleRef.current.active = false;
      lifecycleRef.current.generation++;
    };
  }, []);
  const isActiveRequest = useCallback((request: BoardRequest) => {
    const lifecycle = lifecycleRef.current;
    return (
      lifecycle.active &&
      lifecycle.generation === request.generation &&
      projectIdRef.current === request.projectId
    );
  }, []);
  // A REST analytics response may resolve after the socket's synchronous
  // subscribe snapshot (or a live delta). Keep a per-project receive counter
  // so an older REST seed cannot overwrite authoritative WebSocket state.
  const costAuthorityRef = useRef({ projectId, wsEvents: 0 });
  if (costAuthorityRef.current.projectId !== projectId) {
    costAuthorityRef.current = { projectId, wsEvents: 0 };
  }
  // Keep one monotonic authority stream per project so an older in-flight REST
  // list cannot erase any concrete task state accepted after that request
  // began. WS events, optimistic mutations, API responses, and rollbacks all
  // use this same ordering; the REST merge compares the captured request
  // version instead of applying source-specific precedence rules.
  const taskAuthorityRef = useRef<TaskAuthority>({
    projectId,
    version: 0,
    tasks: new Map(),
  });
  if (taskAuthorityRef.current.projectId !== projectId) {
    taskAuthorityRef.current = { projectId, version: 0, tasks: new Map() };
  }
  const recordTaskAuthority = useCallback(
    (task: Task, expectedProjectId: string) => {
      const authority = taskAuthorityRef.current;
      if (
        authority.projectId !== expectedProjectId ||
        task.projectId !== expectedProjectId
      ) {
        return;
      }
      authority.version++;
      authority.tasks.set(task.id, { task, version: authority.version });
      return authority.version;
    },
    [],
  );
  const getTaskAuthorityVersion = useCallback(
    (taskId: string, expectedProjectId: string) => {
      const authority = taskAuthorityRef.current;
      if (authority.projectId !== expectedProjectId) return;
      return authority.tasks.get(taskId)?.version ?? 0;
    },
    [],
  );
  const selectedTask =
    tasks.find((t) => t.id === selectedTaskId) ?? null;
  const selectedTaskPrNumber = selectedTask?.prNumber;

  const estimateGenerationRef = useRef(0);
  const estimateAbortRef = useRef<AbortController | null>(null);
  const fetchEstimates = useCallback(async () => {
    estimateAbortRef.current?.abort();
    const controller = new AbortController();
    estimateAbortRef.current = controller;
    const requestGeneration = ++estimateGenerationRef.current;
    try {
      const res = await api<EstimateResponse>("estimatePlan", {
        params: { id: projectId },
        signal: controller.signal,
      });
      if (estimateGenerationRef.current !== requestGeneration) return;
      setEstimates(Object.fromEntries(res.tasks.map((t) => [t.taskId, t])));
    } catch (error) {
      if (isAbortError(error) || estimateGenerationRef.current !== requestGeneration) {
        return;
      }
      /* non-critical — the chip just doesn't show */
    }
  }, [projectId]);

  useEffect(() => {
    return () => {
      estimateAbortRef.current?.abort();
    };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    const taskAuthorityAtRequest = taskAuthorityRef.current;
    const taskAuthorityVersionAtRequest = taskAuthorityAtRequest.version;
    const costEventsAtRequest = costAuthorityRef.current.wsEvents;
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
        if (
          cancelled ||
          taskAuthorityRef.current.projectId !== projectId ||
          taskAuthorityRef.current !== taskAuthorityAtRequest
        ) {
          return;
        }
        setTasks(() => {
          const merged = tasksRes.tasks.map((task) => {
            const authority = taskAuthorityRef.current.tasks.get(task.id);
            return authority && authority.version > taskAuthorityVersionAtRequest
              ? authority.task
              : task;
          });
          const included = new Set(merged.map((task) => task.id));
          // A task created or otherwise accepted after this request began may
          // not exist in the REST response captured before that event. Keep
          // those concrete authority entries, including unknown task IDs.
          for (const authority of taskAuthorityRef.current.tasks.values()) {
            if (authority.version <= taskAuthorityVersionAtRequest) continue;
            if (!included.has(authority.task.id)) merged.unshift(authority.task);
          }
          return merged;
        });
        setSettings(settingsRes.settings);
        setTasksLoaded(true);
        setBudgetUsd(costRes.budgetUsd);
        if (
          costAuthorityRef.current.projectId === projectId &&
          costAuthorityRef.current.wsEvents === costEventsAtRequest
        ) {
          setCostUsd(costRes.totalUsd);
        }
        fetchEstimates();
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [fetchEstimates, projectId]);

  useEffect(() => {
    if (!selectedTaskId) {
      logsOmittedOlderRef.current = false;
      setLogsOmittedOlder(false);
      setLogs([]);
      setLogsError(null);
      setRollbackError(null);
      return;
    }
    let cancelled = false;
    async function loadLogs() {
      setLogsLoading(true);
      setLogsError(null);
      logsOmittedOlderRef.current = false;
      setLogsOmittedOlder(false);
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
        const bounded = retainNewestTaskLogs(res.logs);
        logsOmittedOlderRef.current = bounded.omittedOlder;
        setLogsOmittedOlder(bounded.omittedOlder);
        setLogs(bounded.logs);
      } catch (e) {
        if (!cancelled) setLogsError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLogsLoading(false);
      }
    }
    loadLogs();
    setRollbackError(null);
    api<TaskRollbackResponse>("taskRollback", {
      params: { id: selectedTaskId },
    })
      .then(({ rollback }) => {
        if (cancelled) return;
        setRollbackJobs((current) => {
          if (rollback) return { ...current, [rollback.taskId]: rollback };
          const next = { ...current };
          delete next[selectedTaskId];
          return next;
        });
      })
      .catch((e: unknown) => {
        if (!cancelled) setRollbackError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTaskId, selectedTaskPrNumber, logsReloadNonce]);

  const pendingActivityRef = useRef<Record<string, number>>({});
  const activityFrameRef = useRef<number | null>(null);
  const flushActivity = useCallback(() => {
    activityFrameRef.current = null;
    const pending = pendingActivityRef.current;
    pendingActivityRef.current = {};
    const taskIds = Object.keys(pending);
    if (taskIds.length === 0) return;
    setActivity((current) => ({ ...current, ...pending }));
  }, []);
  const markActivity = useCallback((taskId: string | undefined) => {
    if (!taskId) return;
    pendingActivityRef.current[taskId] = Date.now();
    if (activityFrameRef.current != null) return;
    activityFrameRef.current = requestAnimationFrame(flushActivity);
  }, [flushActivity]);
  useEffect(() => {
    return () => {
      if (activityFrameRef.current == null) return;
      cancelAnimationFrame(activityFrameRef.current);
      activityFrameRef.current = null;
    };
  }, [projectId]);

  const handleWSEvent = useCallback(
    (event: ServerEvent) => {
      switch (event.type) {
        case "task.updated": {
          const updated = event.payload;
          if (updated.projectId !== projectIdRef.current) break;
          recordTaskAuthority(updated, updated.projectId);
          const previous = tasksRef.current.find((task) => task.id === updated.id);
          const wasActive =
            previous?.status === "in_progress" || previous?.status === "in_review";
          const isActive =
            updated.status === "in_progress" || updated.status === "in_review";
          if (isActive && !wasActive) {
            setActiveSince((prev) => ({ ...prev, [updated.id]: Date.now() }));
          } else if (!isActive) {
            setActiveSince((prev) => {
              if (!(updated.id in prev)) return prev;
              const next = { ...prev };
              delete next[updated.id];
              return next;
            });
          }
          setTasks((prev) => {
            const existing = prev.some((t) => t.id === updated.id);
            return existing
              ? prev.map((t) => (t.id === updated.id ? updated : t))
              : [updated, ...prev];
          });
          markActivity(updated.id);
          if (
            !previous ||
            previous.status !== updated.status ||
            previous.assignedModel !== updated.assignedModel ||
            previous.difficulty !== updated.difficulty ||
            previous.maxAttempts !== updated.maxAttempts
          ) {
            fetchEstimates();
          }
          break;
        }
        case "run.updated": {
          markActivity(event.payload.taskId);
          break;
        }
        case "rollback.updated": {
          const rollback = event.payload;
          setRollbackJobs((current) => ({
            ...current,
            [rollback.taskId]: rollback,
          }));
          break;
        }
        case "cost.snapshot": {
          if (event.payload.projectId === projectIdRef.current) {
            costAuthorityRef.current.wsEvents++;
            setCostUsd(event.payload.totalUsd);
          }
          break;
        }
        case "cost.updated": {
          // The hub broadcasts to all clients; only count this project's spend
          // (a concurrently-running project would otherwise inflate the total).
          if (event.payload.projectId === projectIdRef.current) {
            costAuthorityRef.current.wsEvents++;
            setCostUsd((c) => c + event.payload.costUsd);
          }
          break;
        }
        case "log": {
          const logEvent = event.payload;
          // Any log line for any task = that model is alive right now.
          markActivity(logEvent.taskId);
          if (logEvent.taskId === selectedTaskIdRef.current) {
            setLogs((prev) => {
              const bounded = appendTaskLog(
                prev,
                logEvent,
                logsOmittedOlderRef.current,
              );
              logsOmittedOlderRef.current = bounded.omittedOlder;
              setLogsOmittedOlder(bounded.omittedOlder);
              return bounded.logs;
            });
          }
          break;
        }
      }
    },
    [markActivity, fetchEstimates, recordTaskAuthority],
  );

  useWS(projectId, handleWSEvent);

  const handleRollback = (taskId: string, prNumber: number) => {
    requestConfirmation({
      title: `Create a rollback PR for #${prNumber}?`,
      description:
        "Hoopedorc will run gates and an independent review, then require your approval before merging it.",
      confirmLabel: "Create rollback PR",
      pendingLabel: "Starting rollback…",
      tone: "warning",
      action: async () => {
        const request: BoardRequest = {
          projectId,
          generation: lifecycleRef.current.generation,
        };
        setActionBusy(true);
        try {
          const res = await api<RollbackTaskResponse>("rollbackTask", {
            params: { id: taskId },
          });
          if (!isActiveRequest(request)) return;
          setRollbackJobs((current) => ({
            ...current,
            [taskId]: res.rollback,
          }));
          toast(`Rollback job started for PR #${prNumber}.`, "success");
        } catch (error) {
          if (isActiveRequest(request)) throw error;
        } finally {
          if (isActiveRequest(request)) setActionBusy(false);
        }
      },
      errorMessage: (error) =>
        `Could not start the rollback: ${errorMessage(error)}`,
    });
  };

  const handleRetry = async (taskId: string) => {
    const request: BoardRequest = {
      projectId,
      generation: lifecycleRef.current.generation,
    };
    const authorityVersionAtRequest = getTaskAuthorityVersion(
      taskId,
      request.projectId,
    );
    if (authorityVersionAtRequest == null) return;
    setActionBusy(true);
    try {
      const res = await api<RetryTaskResponse>("retryTask", {
        params: { id: taskId },
      });
      if (!isActiveRequest(request)) return;
      if (
        getTaskAuthorityVersion(taskId, request.projectId) ===
        authorityVersionAtRequest
      ) {
        const responseVersion = recordTaskAuthority(res.task, request.projectId);
        if (responseVersion == null) return;
        setTasks((prev) =>
          prev.map((t) => (t.id === taskId ? res.task : t)),
        );
      }
      toast("Retry queued with priority.", "success");
    } catch (e) {
      if (isActiveRequest(request)) toast(String(e), "error");
    } finally {
      if (isActiveRequest(request)) setActionBusy(false);
    }
  };

  const handleStop = async (taskId: string) => {
    const request: BoardRequest = {
      projectId,
      generation: lifecycleRef.current.generation,
    };
    const authorityVersionAtRequest = getTaskAuthorityVersion(
      taskId,
      request.projectId,
    );
    if (authorityVersionAtRequest == null) return;
    setStoppingIds((prev) => new Set(prev).add(taskId));
    try {
      const res = await api<StopTaskResponse>("stopTask", {
        params: { id: taskId },
      });
      if (!isActiveRequest(request)) return;
      if (
        getTaskAuthorityVersion(taskId, request.projectId) ===
        authorityVersionAtRequest
      ) {
        const responseVersion = recordTaskAuthority(res.task, request.projectId);
        if (responseVersion == null) return;
        setTasks((prev) =>
          prev.map((t) => (t.id === taskId ? res.task : t)),
        );
      }
      toast("Stopped — task moved to Blocked.", "success");
    } catch (error) {
      if (isActiveRequest(request)) throw error;
    } finally {
      if (isActiveRequest(request)) {
        setStoppingIds((prev) => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      }
    }
  };
  const handleStopRef = useRef(handleStop);
  handleStopRef.current = handleStop;
  const updateSelectedTaskId = useCallback(
    (next: string | null) => {
      if (!controlledSelection) setInternalSelectedTaskId(next);
      onSelectTask?.(next);
    },
    [controlledSelection, onSelectTask],
  );
  const selectTask = useCallback(
    (taskId: string) => {
      updateSelectedTaskId(selectedTaskIdRef.current === taskId ? null : taskId);
    },
    [updateSelectedTaskId],
  );
  const missingSelectedTask =
    tasksLoaded && selectedTaskId && !tasks.some((t) => t.id === selectedTaskId)
      ? selectedTaskId
      : null;
  const stopTask = useCallback((taskId: string) => {
    void handleStopRef.current(taskId);
  }, []);

  const handleTaskAdded = (t: Task) => {
    const request: BoardRequest = {
      projectId,
      generation: lifecycleRef.current.generation,
    };
    if (!isActiveRequest(request) || t.projectId !== request.projectId) return;
    const existingAuthority = taskAuthorityRef.current.tasks.get(t.id);
    if (!existingAuthority) {
      recordTaskAuthority(t, request.projectId);
      setTasks((prev) => {
        const existing = prev.some((task) => task.id === t.id);
        return existing
          ? prev.map((task) => (task.id === t.id ? t : task))
          : [...prev, t];
      });
    }
    setShowAddTask(false);
    toast(`Added "${t.title}".`, "success");
  };

  const handleViewDiff = async (taskId: string) => {
    const request: BoardRequest = {
      projectId,
      generation: lifecycleRef.current.generation,
    };
    setActionBusy(true);
    setDiff(null);
    try {
      const res = await api<TaskDiffResponse>("taskDiff", {
        params: { id: taskId },
      });
      if (isActiveRequest(request)) setDiff(res.diff || "(empty diff)");
    } catch (e) {
      if (isActiveRequest(request)) toast(String(e), "error");
    } finally {
      if (isActiveRequest(request)) setActionBusy(false);
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
  const toggleColumnExpanded = (group: BoardGroupKey) => {
    setExpandedEmpty((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const handleColumnDragOver = (group: BoardGroupKey, e: React.DragEvent) => {
    handleDragOver(e);
    if (dragOverGroup !== group) setDragOverGroup(group);
  };

  const handleColumnDragLeave = (group: BoardGroupKey) => {
    setDragOverGroup((cur) => (cur === group ? null : cur));
  };

  // VW04: dropping expresses one allowed action — "run this next" onto
  // Planned (status ready). Other groups are engine evidence and accept no
  // drops; their dragover is not prevented, so the browser refuses the drop.
  const handleColumnDrop = (group: BoardGroupKey, e: React.DragEvent) => {
    setDragOverGroup(null);
    e.preventDefault();
    const definition = BOARD_GROUPS.find((candidate) => candidate.key === group);
    if (definition?.dropAction !== "run_next") return;
    const taskId = e.dataTransfer.getData("text/plain");
    if (!taskId) return;
    void changeStatus(taskId, "ready");
  };

  const setViewMode = (mode: BoardViewMode) => {
    setViewModeState(mode);
    writeStorage(VIEW_STORAGE_KEY, mode);
  };

  const setEngineering = (enabled: boolean) => {
    setEngineeringState(enabled);
    writeStorage(ENGINEERING_STORAGE_KEY, enabled ? "1" : "0");
  };

  const focusGroup = (group: BoardGroupKey) => {
    if (viewMode === "list") {
      setListGroup(group);
      return;
    }
    setExpandedEmpty((prev) => (prev.has(group) ? prev : new Set(prev).add(group)));
    setPendingFocusGroup(group);
  };

  useEffect(() => {
    if (!pendingFocusGroup) return;
    const column = columnRefs.current.get(pendingFocusGroup);
    column?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "center" });
    column?.focus?.({ preventScroll: true });
    setPendingFocusGroup(null);
  }, [pendingFocusGroup, expandedEmpty]);

  /** Optimistic status change with rollback — the one path behind Planned
   *  drops and the card menu's Run next / Move back to queue. */
  const changeStatus = async (taskId: string, status: TaskStatus) => {
    const task = tasksRef.current.find((t) => t.id === taskId);
    if (!task || task.status === status) return;
    const request: BoardRequest = {
      projectId,
      generation: lifecycleRef.current.generation,
    };
    const optimisticTask = { ...task, status };
    const optimisticVersion = recordTaskAuthority(
      optimisticTask,
      request.projectId,
    );
    if (optimisticVersion == null) return;

    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? optimisticTask : t)),
    );

    try {
      const res = await api<{ task: Task }>("updateTask", {
        params: { id: taskId },
        body: { status },
      });
      if (!isActiveRequest(request)) return;
      if (
        getTaskAuthorityVersion(taskId, request.projectId) !== optimisticVersion
      ) {
        return;
      }
      const responseVersion = recordTaskAuthority(res.task, request.projectId);
      if (responseVersion != null) {
        setTasks((prev) =>
          prev.map((current) => (current.id === taskId ? res.task : current)),
        );
      }
    } catch (e) {
      if (!isActiveRequest(request)) return;
      if (
        getTaskAuthorityVersion(taskId, request.projectId) === optimisticVersion
      ) {
        const rollbackVersion = recordTaskAuthority(task, request.projectId);
        if (rollbackVersion != null) {
          setTasks((prev) =>
            prev.map((current) => (current.id === taskId ? task : current)),
          );
        }
      }
      // B21: B5's server rules reject most invalid moves with a genuinely
      // useful message ("can only requeue to backlog/ready", "stop it first")
      // — surface it instead of letting the card silently snap back, which
      // is indistinguishable from the drag not registering at all.
      toast(String(e), "error");
    }
  };

  const handleModelChange = async (
    taskId: string,
    model: ModelId,
  ) => {
    const task = tasksRef.current.find((t) => t.id === taskId);
    if (!task || task.assignedModel === model) return;
    const request: BoardRequest = {
      projectId,
      generation: lifecycleRef.current.generation,
    };
    const optimisticTask = { ...task, assignedModel: model };
    const optimisticVersion = recordTaskAuthority(
      optimisticTask,
      request.projectId,
    );
    if (optimisticVersion == null) return;

    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? optimisticTask : t)),
    );

    try {
      const res = await api<{ task: Task }>("updateTask", {
        params: { id: taskId },
        body: { assignedModel: model },
      });
      if (!isActiveRequest(request)) return;
      if (
        getTaskAuthorityVersion(taskId, request.projectId) !== optimisticVersion
      ) {
        return;
      }
      const responseVersion = recordTaskAuthority(res.task, request.projectId);
      if (responseVersion != null) {
        setTasks((prev) =>
          prev.map((current) => (current.id === taskId ? res.task : current)),
        );
      }
    } catch (e) {
      if (!isActiveRequest(request)) return;
      if (
        getTaskAuthorityVersion(taskId, request.projectId) === optimisticVersion
      ) {
        const rollbackVersion = recordTaskAuthority(task, request.projectId);
        if (rollbackVersion != null) {
          setTasks((prev) =>
            prev.map((current) => (current.id === taskId ? task : current)),
          );
        }
      }
      toast(String(e), "error");
    }
  };

  return (
    <div>
      {confirmationDialog}
      {error && (
        <div className="mb-4 rounded border border-red-800 bg-red-950/50 px-4 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {missingSelectedTask && (
        <div
          role="status"
          className="mb-4 flex flex-wrap items-center gap-2 rounded border border-amber-800/60 bg-amber-950/20 px-4 py-2 text-xs text-amber-200"
        >
          <span className="min-w-0 flex-1">
            Task <code className="font-mono">{missingSelectedTask}</code> is not on this board —
            it may belong to another project or have been deleted.
          </span>
          <button
            type="button"
            onClick={() => updateSelectedTaskId(null)}
            className="min-h-10 rounded border border-amber-700 px-3 py-2 text-xs hover:bg-amber-900/40 focus-visible:ring-2 focus-visible:ring-amber-400"
          >
            Dismiss
          </button>
        </div>
      )}

      <BoardSummary
        tasks={tasks}
        costUsd={costUsd}
        budgetUsd={budgetUsd}
        onFocusGroup={focusGroup}
      />

      <MissionControl
        projectId={projectId}
        tasks={tasks}
        models={settings?.models ?? []}
        activity={activity}
        activeSince={activeSince}
        onViewNotifications={() => onViewNotifications?.()}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {showAddTask ? (
          <div className="w-full">
            <AddTaskForm
              projectId={projectId}
              tasks={tasks}
              onCreated={handleTaskAdded}
              onCancel={() => setShowAddTask(false)}
            />
          </div>
        ) : (
          <button
            onClick={() => setShowAddTask(true)}
            className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            + Add task
          </button>
        )}
        <div
          role="group"
          aria-label="Board layout"
          className="ml-auto flex items-center rounded border border-neutral-700 text-xs"
        >
          {(["kanban", "list"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={viewMode === mode}
              onClick={() => setViewMode(mode)}
              className={
                "px-3 py-1.5 first:rounded-l last:rounded-r focus-visible:ring-2 focus-visible:ring-blue-500 " +
                (viewMode === mode
                  ? "bg-neutral-700 text-neutral-100"
                  : "text-neutral-400 hover:text-neutral-200")
              }
            >
              {mode === "kanban" ? "Kanban" : "List"}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-neutral-400">
          <input
            type="checkbox"
            checked={engineering}
            onChange={(e) => setEngineering(e.target.checked)}
          />
          Engineering details
        </label>
      </div>

      {viewMode === "list" ? (
        <BoardList
          tasks={tasks}
          group={listGroup ?? defaultListGroup(tasks)}
          onGroupChange={setListGroup}
          renderCard={(t) => (
            <TaskCard
              key={t.id}
              task={t}
              allTasks={tasks}
              models={settings?.models ?? EMPTY_MODELS}
              lastActivityAt={activity[t.id]}
              estimate={estimates[t.id]}
              onSelect={selectTask}
              onStop={stoppingIds.has(t.id) ? undefined : stopTask}
              onRunNext={(id) => void changeStatus(id, "ready")}
              onDefer={(id) => void changeStatus(id, "backlog")}
              onRetry={(id) => void handleRetry(id)}
              isSelected={selectedTaskId === t.id}
              engineering={engineering}
            />
          )}
        />
      ) : (
        <div
          data-horizontal-scroll="board"
          className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-4 sm:snap-none"
        >
          {BOARD_GROUPS.map((group) => {
            const colTasks = tasksInGroup(tasks, group.key);
            const droppable = group.dropAction !== null;
            // U3: never collapse a column that has cards, even if it was
            // toggled open-then-emptied earlier this session — only the
            // "still empty and not explicitly opened" case collapses.
            const collapsed =
              colTasks.length === 0 &&
              !expandedEmpty.has(group.key) &&
              dragOverGroup !== group.key;

            if (collapsed) {
              return (
                <button
                  key={group.key}
                  ref={(el) => {
                    if (el) columnRefs.current.set(group.key, el);
                  }}
                  type="button"
                  onClick={() => toggleColumnExpanded(group.key)}
                  onDragOver={droppable ? (e) => handleColumnDragOver(group.key, e) : undefined}
                  onDragLeave={droppable ? () => handleColumnDragLeave(group.key) : undefined}
                  onDrop={droppable ? (e) => handleColumnDrop(group.key, e) : undefined}
                  title={`${group.label} — empty, click to expand`}
                  className="flex w-9 shrink-0 flex-col items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900/50 py-3 hover:border-neutral-700 focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  <span className="rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500">
                    0
                  </span>
                  <span className="[writing-mode:vertical-rl] rotate-180 text-[10px] font-medium tracking-wider text-neutral-500 uppercase">
                    {group.label}
                  </span>
                </button>
              );
            }

            return (
              <section
                key={group.key}
                ref={(el) => {
                  if (el) columnRefs.current.set(group.key, el);
                }}
                tabIndex={-1}
                aria-label={`${group.label} (${colTasks.length})`}
                onDragOver={droppable ? (e) => handleColumnDragOver(group.key, e) : undefined}
                onDragLeave={droppable ? () => handleColumnDragLeave(group.key) : undefined}
                onDrop={droppable ? (e) => handleColumnDrop(group.key, e) : undefined}
                className={
                  "min-w-[85vw] max-w-[85vw] flex-1 snap-center rounded-lg border bg-neutral-900/50 p-3 sm:min-w-[220px] sm:max-w-[280px] sm:snap-none focus:outline-none " +
                  (dragOverGroup === group.key
                    ? "border-blue-600"
                    : "border-neutral-800")
                }
              >
                <h2
                  onClick={
                    colTasks.length === 0
                      ? () => toggleColumnExpanded(group.key)
                      : undefined
                  }
                  title={group.description}
                  className={
                    "mb-3 flex items-center gap-2 text-xs font-medium text-neutral-400 uppercase tracking-wider" +
                    (colTasks.length === 0 ? " cursor-pointer" : "")
                  }
                >
                  {group.label}
                  <span className="rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                    {colTasks.length}
                  </span>
                </h2>
                {colTasks.length === 0 && (
                  <p className="text-[11px] text-neutral-500">{group.description}</p>
                )}
                <div className="space-y-2">
                  {colTasks.map((t) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      allTasks={tasks}
                      models={settings?.models ?? EMPTY_MODELS}
                      lastActivityAt={activity[t.id]}
                      estimate={estimates[t.id]}
                      onSelect={selectTask}
                      onStop={stoppingIds.has(t.id) ? undefined : stopTask}
                      onRunNext={(id) => void changeStatus(id, "ready")}
                      onDefer={(id) => void changeStatus(id, "backlog")}
                      onRetry={(id) => void handleRetry(id)}
                      isSelected={selectedTaskId === t.id}
                      engineering={engineering}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {selectedTask && (
        <TaskDrawer
          task={selectedTask}
          models={settings?.models ?? []}
          repoUrl={repoUrl}
          logs={logs}
          logsLoading={logsLoading}
          logsOmittedOlder={logsOmittedOlder}
          logsError={logsError}
          onReloadLogs={() => setLogsReloadNonce((nonce) => nonce + 1)}
          rollbackError={rollbackError}
          diff={diff}
          rollbackJob={
            rollbackJobs[selectedTask.id]?.sourcePrNumber === selectedTask.prNumber
              ? rollbackJobs[selectedTask.id]
              : undefined
          }
          estimate={estimates[selectedTask.id]}
          actionBusy={actionBusy}
          onClose={() => updateSelectedTaskId(null)}
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

/**
 * VW04: the phone-first status-filtered list — one group at a time behind a
 * tab strip, with the same cards and actions as the Kanban columns.
 */
function BoardList({
  tasks,
  group,
  onGroupChange,
  renderCard,
}: {
  tasks: Task[];
  group: BoardGroupKey;
  onGroupChange: (group: BoardGroupKey) => void;
  renderCard: (task: Task) => React.ReactNode;
}) {
  const definition = BOARD_GROUPS.find((candidate) => candidate.key === group) ?? BOARD_GROUPS[0]!;
  const visible = tasksInGroup(tasks, group);
  return (
    <div>
      <div
        role="tablist"
        aria-label="Task groups"
        data-horizontal-scroll="board-groups"
        className="mb-3 flex gap-1 overflow-x-auto"
      >
        {BOARD_GROUPS.map((candidate) => {
          const count = tasks.filter((t) => groupForStatus(t.status) === candidate.key).length;
          const selected = candidate.key === group;
          return (
            <button
              key={candidate.key}
              type="button"
              role="tab"
              id={`board-tab-${candidate.key}`}
              aria-selected={selected}
              aria-controls={`board-group-${candidate.key}`}
              title={candidate.description}
              onClick={() => onGroupChange(candidate.key)}
              className={
                "min-h-10 shrink-0 rounded px-3 py-1.5 text-xs focus-visible:ring-2 focus-visible:ring-blue-500 " +
                (selected
                  ? "bg-neutral-700 text-neutral-100"
                  : "text-neutral-400 hover:text-neutral-200")
              }
            >
              {candidate.label}
              <span
                className={
                  "ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] " +
                  (candidate.key === "attention" && count > 0
                    ? "bg-amber-900/60 text-amber-300"
                    : "bg-neutral-800 text-neutral-400")
                }
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
      <section
        role="tabpanel"
        id={`board-group-${group}`}
        aria-labelledby={`board-tab-${group}`}
        className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-3"
      >
        <p className="mb-3 text-[11px] text-neutral-500">{definition.description}</p>
        {visible.length === 0 ? (
          <p className="text-xs text-neutral-500">Nothing here right now.</p>
        ) : (
          <div className="space-y-2">{visible.map(renderCard)}</div>
        )}
      </section>
    </div>
  );
}
