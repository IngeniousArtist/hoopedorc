import type { Task, TaskStatus } from "@orc/types";
import { useEffect, useState } from "react";

// Round 0 placeholder board. OWNER: glm — build this out per docs/specs/glm-web.md.
// Reads tasks from the (mock) API and groups them into DAG-ordered columns.

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "backlog", label: "Backlog" },
  { status: "ready", label: "Ready" },
  { status: "in_progress", label: "In Progress" },
  { status: "in_review", label: "In Review" },
  { status: "done", label: "Done" },
];

const PROJECT_ID = "proj-hoopedorc";

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/projects/${PROJECT_ID}/tasks`)
      .then((r) => r.json())
      .then((d: { tasks: Task[] }) => setTasks(d.tasks))
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Hoopedorc</h1>
        <p className="text-sm text-neutral-400">
          Multi-model orchestrator — Round 0 scaffold
        </p>
      </header>

      {error && <p className="text-red-400">API error: {error}</p>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
        {COLUMNS.map((col) => (
          <section
            key={col.status}
            className="rounded-lg border border-neutral-800 bg-neutral-900 p-3"
          >
            <h2 className="mb-3 text-sm font-medium text-neutral-300">
              {col.label}
            </h2>
            <div className="space-y-2">
              {tasks
                .filter((t) => t.status === col.status)
                .map((t) => (
                  <article
                    key={t.id}
                    className="rounded-md border border-neutral-800 bg-neutral-950 p-3"
                  >
                    <div className="text-sm font-medium">{t.title}</div>
                    <div className="mt-2 flex items-center gap-2 text-xs text-neutral-400">
                      <span className="rounded bg-neutral-800 px-1.5 py-0.5">
                        {t.assignedModel}
                      </span>
                      <span className="rounded bg-neutral-800 px-1.5 py-0.5">
                        {t.difficulty}
                      </span>
                    </div>
                  </article>
                ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
