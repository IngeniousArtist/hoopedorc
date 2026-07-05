import type { AddTaskResponse, Difficulty, Task } from "@orc/types";
import { useState } from "react";
import { api } from "../api/client";

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

const inputCls =
  "w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200";

/**
 * "+ Add task" affordance on the Board (F3) — materializes a single task via
 * POST /api/projects/:id/tasks. Picked up live by the autonomous loop if it's
 * already running (B9's reconcileTasks), or just sits in backlog/ready
 * otherwise.
 */
export function AddTaskForm({
  projectId,
  tasks,
  onCreated,
  onCancel,
}: {
  projectId: string;
  tasks: Task[];
  onCreated: (task: Task) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [scopePaths, setScopePaths] = useState("");
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleDep(id: string) {
    setDependsOn((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id],
    );
  }

  async function create() {
    if (!title.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await api<AddTaskResponse>("addTask", {
        params: { id: projectId },
        body: {
          title: title.trim(),
          description: description.trim() || undefined,
          difficulty,
          dependsOn,
          scopePaths: scopePaths
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      onCreated(res.task);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="mb-4 space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-neutral-300">Add task</h3>
        <button
          onClick={onCancel}
          className="rounded p-1 text-neutral-400 hover:text-neutral-200"
          aria-label="Cancel"
        >
          {"✕"}
        </button>
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}

      <div>
        <label className="mb-1 block text-[10px] uppercase text-neutral-400">
          Title *
        </label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a settings toggle for X"
          className={inputCls}
        />
      </div>

      <div>
        <label className="mb-1 block text-[10px] uppercase text-neutral-400">
          Description
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className={inputCls}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-[10px] uppercase text-neutral-400">
            Difficulty
          </label>
          <select
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value as Difficulty)}
            className={inputCls}
          >
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[10px] uppercase text-neutral-400">
            Scope paths (comma-separated)
          </label>
          <input
            value={scopePaths}
            onChange={(e) => setScopePaths(e.target.value)}
            placeholder="src/**/*.ts (default: **/*)"
            className={inputCls + " font-mono"}
          />
        </div>
      </div>

      {tasks.length > 0 && (
        <div>
          <label className="mb-1 block text-[10px] uppercase text-neutral-400">
            Depends on (optional)
          </label>
          <div className="flex flex-wrap gap-2">
            {tasks.map((t) => (
              <label
                key={t.id}
                className="flex items-center gap-1 rounded border border-neutral-800 px-2 py-1 text-[11px] text-neutral-300"
              >
                <input
                  type="checkbox"
                  checked={dependsOn.includes(t.id)}
                  onChange={() => toggleDep(t.id)}
                />
                {t.title}
              </label>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={create}
        disabled={!title.trim() || creating}
        className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
      >
        {creating ? "Adding…" : "Add task"}
      </button>
    </section>
  );
}
