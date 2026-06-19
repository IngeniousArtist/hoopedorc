import type {
  CreateProjectResponse,
  PlanProjectResponse,
} from "@orc/types";
import { useState } from "react";
import { api } from "../api/client";

export function NewProject() {
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [budgetUsd, setBudgetUsd] = useState("");
  const [goal, setGoal] = useState("");
  const [creating, setCreating] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<
    CreateProjectResponse["project"] | null
  >(null);
  const [planResult, setPlanResult] =
    useState<PlanProjectResponse | null>(null);

  async function createProject() {
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const res = await api<CreateProjectResponse>(
        "createProject",
        {
          body: {
            name,
            repoUrl: repoUrl || undefined,
            defaultBranch,
            budgetUsd: budgetUsd
              ? parseFloat(budgetUsd)
              : undefined,
          },
        },
      );
      setProject(res.project);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  async function planProject() {
    if (!project || !goal) return;
    setPlanning(true);
    setError(null);
    try {
      const res = await api<PlanProjectResponse>(
        "planProject",
        {
          params: { id: project.id },
          body: { goal },
        },
      );
      setPlanResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setPlanning(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-8">
      <h2 className="text-lg font-semibold">New Project</h2>

      {error && (
        <div className="rounded border border-red-800 bg-red-950/50 px-4 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <section className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h3 className="text-sm font-medium text-neutral-300">
          Create Project
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="mb-1 block text-xs text-neutral-400">
              Name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My project"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200"
            />
          </div>
          <div className="col-span-2">
            <label className="mb-1 block text-xs text-neutral-400">
              Repo URL
            </label>
            <input
              type="text"
              value={repoUrl}
              onChange={(e) =>
                setRepoUrl(e.target.value)
              }
              placeholder="https://github.com/user/repo"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-neutral-400">
              Default branch
            </label>
            <input
              type="text"
              value={defaultBranch}
              onChange={(e) =>
                setDefaultBranch(e.target.value)
              }
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-neutral-400">
              Budget (USD)
            </label>
            <input
              type="number"
              value={budgetUsd}
              onChange={(e) =>
                setBudgetUsd(e.target.value)
              }
              placeholder="Optional"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200"
            />
          </div>
        </div>
        <button
          onClick={createProject}
          disabled={!name || creating}
          className="rounded bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create Project"}
        </button>
      </section>

      {project && (
        <section className="space-y-2 rounded-lg border border-green-800 bg-green-950/20 p-4">
          <h3 className="text-sm font-medium text-green-300">
            Project Created
          </h3>
          <div className="space-y-1 text-xs text-neutral-300">
            <div>
              <span className="text-neutral-500">
                ID:
              </span>{" "}
              {project.id}
            </div>
            <div>
              <span className="text-neutral-500">
                Name:
              </span>{" "}
              {project.name}
            </div>
            <div>
              <span className="text-neutral-500">
                Status:
              </span>{" "}
              {project.status}
            </div>
          </div>

          <div className="mt-4 space-y-3 border-t border-green-900/50 pt-4">
            <label className="block text-xs text-neutral-400">
              Describe what you want to build
            </label>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="e.g. Build a REST API for user management with JWT auth"
              rows={3}
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 resize-none"
            />
            <button
              onClick={planProject}
              disabled={!goal || planning}
              className="rounded bg-green-700 px-4 py-2 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-50"
            >
              {planning
                ? "Planning…"
                : "Start Planning"}
            </button>
          </div>
        </section>
      )}

      {planResult && (
        <section className="space-y-4">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <h3 className="mb-3 text-sm font-medium text-neutral-300">
              PRD
            </h3>
            <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-neutral-300">
              {planResult.prdMarkdown}
            </pre>
          </div>

          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <h3 className="mb-3 text-sm font-medium text-neutral-300">
              Tasks ({planResult.tasks.length})
            </h3>
            <div className="space-y-2">
              {planResult.tasks.map((task) => (
                <div
                  key={task.id}
                  className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2"
                >
                  <div className="text-sm font-medium text-neutral-200">
                    {task.title}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px]">
                    <span className="text-neutral-500">
                      {task.difficulty}
                    </span>
                    <span className="text-neutral-500">
                      {task.assignedModel}
                    </span>
                    <span className="text-neutral-600">
                      deps:{" "}
                      {task.dependsOn.length}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
