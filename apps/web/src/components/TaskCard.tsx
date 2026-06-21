import type { ModelConfig, ModelId, Task } from "@orc/types";
import { ModelSelect } from "./ModelSelect";

export function TaskCard({
  task,
  allTasks,
  models,
  onModelChange,
  onClick,
  isSelected,
}: {
  task: Task;
  allTasks: Task[];
  models: ModelConfig[];
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
            disabled={task.status === "in_progress"}
            disabledReason="Running — wait for this attempt to finish to reassign"
          />
        </div>
      )}
    </article>
  );
}
