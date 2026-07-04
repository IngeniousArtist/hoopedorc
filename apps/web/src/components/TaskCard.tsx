import type { ModelConfig, ModelId, Task } from "@orc/types";
import { ModelSelect } from "./ModelSelect";

// Mirrors STUCK_DETECTION.idleMs in @orc/engine: if the model emits no output
// for this long, the engine kills the run and falls back. The heartbeat turns
// amber as a task approaches this so you can see it going quiet before the kill.
const IDLE_LIMIT_MS = 6 * 60 * 1000;

function agoLabel(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ${s % 60}s ago`;
}

/** Live "is the model still working" heartbeat for an in-progress task. */
function Heartbeat({ lastActivityAt }: { lastActivityAt?: number }) {
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

export function TaskCard({
  task,
  allTasks,
  models,
  lastActivityAt,
  onModelChange,
  onClick,
  isSelected,
}: {
  task: Task;
  allTasks: Task[];
  models: ModelConfig[];
  lastActivityAt?: number;
  onModelChange?: (m: ModelId) => void;
  onClick?: () => void;
  isSelected?: boolean;
}) {
  const depTasks = task.dependsOn
    .map((id) => allTasks.find((t) => t.id === id))
    .filter(Boolean) as Task[];

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", task.id);
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    <article
      draggable
      onDragStart={handleDragStart}
      onClick={onClick}
      className={
        "cursor-pointer rounded-md border p-3 transition-colors " +
        (isSelected
          ? "border-blue-600 bg-neutral-800"
          : "border-neutral-800 bg-neutral-900 hover:border-neutral-700")
      }
    >
      <div className="text-sm font-medium">{task.title}</div>

      {(task.status === "in_progress" || task.status === "in_review") && (
        <div className="mt-1">
          <Heartbeat lastActivityAt={lastActivityAt} />
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">
          {task.assignedModel}
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
          <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-400">
            {task.attempts}/{task.maxAttempts}
          </span>
        )}
      </div>

      {depTasks.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {depTasks.map((dep) => (
            <span
              key={dep.id}
              className="rounded bg-purple-900/30 px-1.5 py-0.5 text-[10px] text-purple-300"
              title={dep.title}
            >
              blocked by{" "}
              {dep.title.length > 16
                ? dep.title.slice(0, 16) + "\u2026"
                : dep.title}
            </span>
          ))}
        </div>
      )}

      {onModelChange && (
        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
          <ModelSelect
            value={task.assignedModel}
            models={models}
            onChange={(m) => {
              if (m) onModelChange(m);
            }}
            disabled={task.status === "in_progress" || task.status === "in_review"}
            disabledReason="Running — wait for this attempt to finish to reassign"
          />
        </div>
      )}
    </article>
  );
}
