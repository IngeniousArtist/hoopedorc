import { memo, useEffect, useId, useRef, useState } from "react";
import type { ModelConfig, Task, TaskEstimate } from "@orc/types";
import { useNowTick } from "../hooks/useNowTick";
import { allowedActions, cardActivity, type ActivityTone } from "../lib/boardGroups";
import { errorMessage, useConfirmation } from "./ConfirmationDialog";

// Mirrors STUCK_DETECTION.idleMs in @orc/engine: if the model emits no output
// for this long, the engine kills the run and falls back. The heartbeat turns
// amber as a task approaches this so you can see it going quiet before the kill.
const IDLE_LIMIT_MS = 6 * 60 * 1000;

export function agoLabel(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  // U12: a run past an hour used to read "127m 33s ago" — switch to
  // hours+minutes instead of minutes+seconds once there's an hour to show.
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

/** Live "is the model still working" heartbeat for an in-progress task.
 *  Exported for reuse by MissionControl (F4)'s active-agent rows. */
export function Heartbeat({ lastActivityAt }: { lastActivityAt?: number }) {
  useNowTick(lastActivityAt != null);
  if (lastActivityAt == null) {
    return (
      <span className="flex items-center gap-1 text-[10px] text-neutral-400">
        <span className="h-1.5 w-1.5 rounded-full bg-neutral-500" />
        starting…
      </span>
    );
  }
  const elapsed = Date.now() - lastActivityAt;
  // < 1min: actively streaming (green). < 4min: normal gap between steps
  // (blue). >= 4min: going quiet, approaching the 6min idle kill (amber).
  const [dot, text, label] =
    elapsed < 60_000
      ? ["bg-green-500", "text-green-300", "active"]
      : elapsed < IDLE_LIMIT_MS - 120_000
        ? ["bg-blue-500", "text-blue-300", "working"]
        : ["bg-amber-500 animate-pulse", "text-amber-300", "quiet"];
  return (
    <span
      className={"flex items-center gap-1 text-[10px] " + text}
      title={`Last model output ${agoLabel(elapsed)} · engine kills + falls back at ${IDLE_LIMIT_MS / 60000}m idle`}
    >
      <span className={"h-1.5 w-1.5 rounded-full " + dot} />
      {label} · {agoLabel(elapsed)}
    </span>
  );
}

const TONE_CLASS: Record<ActivityTone, string> = {
  waiting: "text-neutral-400",
  ready: "text-blue-300",
  active: "text-green-300",
  review: "text-violet-300",
  done: "text-green-400",
  attention: "text-amber-300",
};

export function taskCardPropsAreEqual(
  prev: TaskCardProps,
  next: TaskCardProps,
): boolean {
  if (
    prev.task !== next.task ||
    prev.lastActivityAt !== next.lastActivityAt ||
    prev.estimate !== next.estimate ||
    prev.onSelect !== next.onSelect ||
    prev.onStop !== next.onStop ||
    prev.onRunNext !== next.onRunNext ||
    prev.onDefer !== next.onDefer ||
    prev.onRetry !== next.onRetry ||
    prev.isSelected !== next.isSelected ||
    prev.engineering !== next.engineering ||
    prev.models !== next.models
  ) {
    return false;
  }
  return next.task.dependsOn.every((id) => {
    const previous = prev.allTasks.find((task) => task.id === id);
    const current = next.allTasks.find((task) => task.id === id);
    return previous === current;
  });
}

export type TaskCardProps = {
  task: Task;
  allTasks: Task[];
  models: ModelConfig[];
  lastActivityAt?: number;
  /** F7 — pre-run cost estimate, shown as a "~$0.03" chip on Ready cards only. */
  estimate?: TaskEstimate;
  onSelect?: (taskId: string) => void;
  /** F3 — "Stop this task" on a running card. Omitted while a stop is
   *  already in flight for this task, so the button just disappears rather
   *  than allowing a double-click. */
  onStop?: (taskId: string) => void | Promise<void>;
  /** VW04 — keyboard/menu equivalents of the allowed drag/drop and recovery
   *  actions. Each is offered only when `allowedActions` permits it. */
  onRunNext?: (taskId: string) => void | Promise<void>;
  onDefer?: (taskId: string) => void | Promise<void>;
  onRetry?: (taskId: string) => void | Promise<void>;
  isSelected?: boolean;
  /** VW04 — show model, difficulty, attempt, and estimate chips on the card.
   *  Off by default: those details live in the task inspector. */
  engineering?: boolean;
};

export const TaskCard = memo(function TaskCard({
  task,
  allTasks,
  models,
  lastActivityAt,
  estimate,
  onSelect,
  onStop,
  onRunNext,
  onDefer,
  onRetry,
  isSelected,
  engineering = false,
}: TaskCardProps) {
  const { requestConfirmation, confirmationDialog } = useConfirmation();
  const activity = cardActivity(task, allTasks);
  const actions = allowedActions(task);
  const menuId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  const menuItems: Array<{ label: string; run: () => void }> = [
    { label: "Open details", run: () => onSelect?.(task.id) },
  ];
  if (actions.runNext && onRunNext) {
    menuItems.push({ label: "Run next", run: () => void onRunNext(task.id) });
  }
  if (actions.defer && onDefer) {
    menuItems.push({ label: "Move back to queue", run: () => void onDefer(task.id) });
  }
  if (actions.retry && onRetry) {
    menuItems.push({ label: "Retry task", run: () => void onRetry(task.id) });
  }

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", task.id);
    e.dataTransfer.effectAllowed = "move";
  };

  const isActive = task.status === "in_progress" || task.status === "in_review";
  const modelName =
    models.find((m) => m.id === task.assignedModel)?.displayName ?? task.assignedModel;

  return (
    <article
      draggable
      tabIndex={0}
      aria-label={task.title}
      onDragStart={handleDragStart}
      onClick={() => onSelect?.(task.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect?.(task.id);
        }
      }}
      className={
        "cursor-pointer rounded-md border p-3 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 " +
        (isSelected
          ? "border-blue-600 bg-neutral-800"
          : "border-neutral-800 bg-neutral-900 hover:border-neutral-700")
      }
    >
      {confirmationDialog}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 text-sm font-medium">{task.title}</div>
        <div ref={menuRef} className="relative shrink-0">
          <button
            ref={menuButtonRef}
            type="button"
            aria-label={`Actions for ${task.title}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((open) => !open);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && menuOpen) {
                e.stopPropagation();
                setMenuOpen(false);
              }
            }}
            className="rounded border border-transparent px-1.5 py-0.5 text-[13px] leading-none text-neutral-400 hover:border-neutral-700 hover:text-neutral-200 focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              id={menuId}
              role="menu"
              aria-label={`Actions for ${task.title}`}
              className="absolute right-0 z-20 mt-1 min-w-44 rounded-md border border-neutral-700 bg-neutral-900 p-1 shadow-xl"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setMenuOpen(false);
                  menuButtonRef.current?.focus();
                }
              }}
            >
              {menuItems.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    item.run();
                  }}
                  className="block w-full rounded px-2 py-2 text-left text-xs text-neutral-200 hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <p
        className={"mt-1 text-[11px] leading-snug " + TONE_CLASS[activity.tone]}
        title={`Status: ${task.status}`}
      >
        {activity.line}
      </p>

      {isActive && (
        <div className="mt-1 flex items-center justify-between gap-2">
          <Heartbeat lastActivityAt={lastActivityAt} />
          {onStop && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                requestConfirmation({
                  title: `Stop "${task.title}"?`,
                  description:
                    "The agent process will be killed and the task moved to Blocked.",
                  confirmLabel: "Stop task",
                  pendingLabel: "Stopping…",
                  tone: "danger",
                  action: () => onStop(task.id),
                  errorMessage: (error) =>
                    `Could not stop the task: ${errorMessage(error)}`,
                });
              }}
              className="shrink-0 rounded border border-red-900 px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-950/50"
            >
              Stop
            </button>
          )}
        </div>
      )}

      {(activity.reviewAvailable || task.dispatchRequestedAt) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
          {task.dispatchRequestedAt && (
            <span
              className="rounded bg-blue-900/50 px-1.5 py-0.5 text-blue-300"
              title="Priority dispatch requested; waiting for dependencies or scheduler capacity"
            >
              queued
            </span>
          )}
          {activity.reviewAvailable && (
            <span
              className="rounded bg-violet-900/40 px-1.5 py-0.5 text-violet-200"
              title="Open the card to see the PR, diff, gate results, and validator verdicts"
            >
              Review available
            </span>
          )}
        </div>
      )}

      {engineering && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">
            {modelName}
          </span>
          <span
            className={
              "rounded px-1.5 py-0.5 " +
              (task.difficulty === "hard"
                ? "bg-red-900/50 text-red-300"
                : task.difficulty === "medium"
                  ? "bg-amber-900/50 text-amber-300"
                  : "bg-green-900/50 text-green-300")
            }
          >
            {task.difficulty}
          </span>
          {task.attempts > 0 && (
            <span
              className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-400"
              title={
                `${task.attempts} author invocations consumed in logical run ` +
                `${task.runGeneration}; policy allows ${task.maxAttempts}` +
                (task.runExtraAttempts > 0
                  ? ` plus ${task.runExtraAttempts} recovery attempts`
                  : "")
              }
            >
              Attempt {task.attempts} · policy {task.maxAttempts}
              {task.runExtraAttempts > 0
                ? ` + ${task.runExtraAttempts} recovery`
                : ""}
            </span>
          )}
          {task.status === "ready" && estimate && (
            <span
              className={
                "rounded px-1.5 py-0.5 " +
                (estimate.hasHistory
                  ? "bg-neutral-800 text-neutral-400"
                  : "bg-neutral-800 text-neutral-500 italic")
              }
              title={
                estimate.hasHistory
                  ? `Based on historical spend — up to $${estimate.highUsd.toFixed(2)} across all attempts`
                  : "Low confidence — no run history yet for this model"
              }
            >
              ~${estimate.expectedUsd.toFixed(2)}
            </span>
          )}
        </div>
      )}

      {activity.blockedBy.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {activity.blockedBy.map((dep) => (
            <span
              key={dep.id}
              className="rounded bg-purple-900/30 px-1.5 py-0.5 text-[10px] text-purple-300"
              title={`${dep.title} — ${dep.status}`}
            >
              waiting on{" "}
              {dep.title.length > 16
                ? dep.title.slice(0, 16) + "…"
                : dep.title}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}, taskCardPropsAreEqual);
