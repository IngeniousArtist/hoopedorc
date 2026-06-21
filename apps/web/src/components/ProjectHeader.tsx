import type { Project, RouteKey } from "@orc/types";
import { useState } from "react";
import { api } from "../api/client";

const STATUS_COLOR: Record<string, string> = {
  created: "bg-neutral-700 text-neutral-200",
  planning: "bg-blue-900/60 text-blue-200",
  planned: "bg-blue-900/60 text-blue-200",
  running: "bg-green-900/60 text-green-300",
  paused: "bg-amber-900/60 text-amber-300",
  completed: "bg-neutral-700 text-neutral-300",
  failed: "bg-red-900/60 text-red-300",
};

const STARTABLE = ["created", "planned", "paused", "completed", "failed"];

export function ProjectHeader({ project }: { project: Project }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const origBudget = project.budgetUsd != null ? String(project.budgetUsd) : "";
  const [budget, setBudget] = useState(origBudget);

  async function act(route: RouteKey) {
    setBusy(true);
    setError(null);
    try {
      await api(route, { params: { id: project.id } });
      // status update arrives via WS (project.updated) and re-renders this header.
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveBudget() {
    setBusy(true);
    setError(null);
    try {
      await api("updateProject", {
        params: { id: project.id },
        body: { budgetUsd: budget === "" ? null : parseFloat(budget) },
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const running = project.status === "running";
  const startLabel = project.status === "paused" ? "Resume" : "Start";
  const budgetDirty = budget !== origBudget;

  return (
    <div className="mb-4 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-neutral-100">
            {project.name}
          </div>
          <div className="truncate text-[11px] text-neutral-500">
            {project.repoUrl}
            {project.budgetUsd != null && (
              <> · budget ${project.budgetUsd}</>
            )}
          </div>
        </div>
        <span
          className={
            "rounded px-2 py-0.5 text-[11px] " +
            (STATUS_COLOR[project.status] ?? "bg-neutral-700 text-neutral-200")
          }
        >
          {project.status}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {running ? (
            <button
              onClick={() => act("pauseProject")}
              disabled={busy}
              className="rounded border border-amber-800 px-3 py-1 text-xs text-amber-300 hover:bg-amber-950/40 disabled:opacity-50"
            >
              {busy ? "…" : "Pause"}
            </button>
          ) : (
            <button
              onClick={() => act("startProject")}
              disabled={busy || !STARTABLE.includes(project.status)}
              className="rounded bg-green-700 px-3 py-1 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-50"
            >
              {busy ? "…" : `▶ ${startLabel}`}
            </button>
          )}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 text-[11px] text-neutral-500">
        <span>Budget $</span>
        <input
          type="number"
          min={0}
          step={0.5}
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          placeholder="none"
          className="w-24 rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-neutral-200"
        />
        <button
          onClick={saveBudget}
          disabled={busy || !budgetDirty}
          className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
        >
          Save
        </button>
        {budgetDirty && <span className="text-amber-400">unsaved</span>}
      </div>

      {error && (
        <div className="mt-2 text-[11px] text-red-400">{error}</div>
      )}
    </div>
  );
}
