import type { CreateProjectResponse } from "@orc/types";
import { useState } from "react";
import { api } from "../api/client";

export function NewProject({
  onProjectCreated,
}: {
  onProjectCreated?: (p: CreateProjectResponse["project"]) => void;
}) {
  const [name, setName] = useState("");
  const [createRepo, setCreateRepo] = useState(true);
  const [repoUrl, setRepoUrl] = useState("");
  const [repoName, setRepoName] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [budgetUsd, setBudgetUsd] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createProject() {
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const res = await api<CreateProjectResponse>("createProject", {
        body: {
          name,
          createRepo,
          repoName: createRepo ? repoName || undefined : undefined,
          repoUrl: createRepo ? undefined : repoUrl || undefined,
          localPath: localPath.trim() || undefined,
          defaultBranch,
          budgetUsd: budgetUsd ? parseFloat(budgetUsd) : undefined,
        },
      });
      onProjectCreated?.(res.project);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  const inputCls =
    "w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200";

  return (
    <div className="max-w-xl space-y-6">
      <h2 className="text-lg font-semibold">New Project</h2>
      <p className="text-xs text-neutral-500">
        Create the project, then use the{" "}
        <span className="font-medium text-neutral-300">Plan</span> tab to chat
        with Claude and build the task list before starting the run.
      </p>

      {error && (
        <div className="rounded border border-red-800 bg-red-950/50 px-4 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <section className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="mb-1 block text-xs text-neutral-400">
              Project name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My project"
              className={inputCls}
            />
          </div>

          <div className="col-span-2 flex gap-4 text-xs">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={createRepo}
                onChange={() => setCreateRepo(true)}
              />
              <span className="text-neutral-300">Create a new private repo</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={!createRepo}
                onChange={() => setCreateRepo(false)}
              />
              <span className="text-neutral-300">Use an existing repo</span>
            </label>
          </div>

          {createRepo ? (
            <div className="col-span-2">
              <label className="mb-1 block text-xs text-neutral-400">
                Repo name (defaults to a slug of the project name)
              </label>
              <input
                type="text"
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
                placeholder="my-project"
                className={inputCls}
              />
            </div>
          ) : (
            <div className="col-span-2">
              <label className="mb-1 block text-xs text-neutral-400">
                Repo URL *
              </label>
              <input
                type="text"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/user/repo"
                className={inputCls}
              />
            </div>
          )}

          <div className="col-span-2">
            <label className="mb-1 block text-xs text-neutral-400">
              Local directory (optional)
            </label>
            <input
              type="text"
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              placeholder="~/projects/my-app (defaults to Settings → Default projects dir)"
              className={inputCls}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-neutral-400">
              Default branch
            </label>
            <input
              type="text"
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              className={inputCls}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-neutral-400">
              Budget (USD, optional)
            </label>
            <input
              type="number"
              value={budgetUsd}
              onChange={(e) => setBudgetUsd(e.target.value)}
              placeholder="e.g. 5"
              className={inputCls}
            />
          </div>
        </div>

        <button
          onClick={createProject}
          disabled={!name || creating || (!createRepo && !repoUrl)}
          className="rounded bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create Project →"}
        </button>
      </section>
    </div>
  );
}
