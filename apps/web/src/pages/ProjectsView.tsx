import type { ListProjectsResponse, Project, RouteKey } from "@orc/types";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { useToast } from "../hooks/useToast";
import { formatSchedule } from "../lib/format";

const STATUS_COLOR: Record<string, string> = {
  created: "bg-neutral-700 text-neutral-200",
  planning: "bg-blue-900/60 text-blue-200",
  planned: "bg-blue-900/60 text-blue-200",
  running: "bg-green-900/60 text-green-300",
  paused: "bg-amber-900/60 text-amber-300",
  completed: "bg-neutral-700 text-neutral-300",
  failed: "bg-red-900/60 text-red-300",
};

/** F12: statuses from which Start makes sense — mirrors ProjectHeader's
 *  own STARTABLE list so the two inline controls stay consistent. */
const STARTABLE = ["created", "planned", "paused", "completed", "failed"];

export function ProjectsView({
  selectedProjectId,
  onSelect,
  onDeleted,
}: {
  selectedProjectId: string;
  onSelect: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const toast = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await api<ListProjectsResponse>("listProjects");
      setProjects(res.projects);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Inline Start/Pause (F12) — re-fetches the list afterward so the status
   *  badge updates immediately; this view doesn't otherwise subscribe to WS. */
  async function act(id: string, route: RouteKey, body?: unknown) {
    setBusyId(id);
    try {
      await api(route, { params: { id }, body });
      await refresh();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteProject(id: string) {
    const name = projects.find((p) => p.id === id)?.name ?? "Project";
    setDeletingId(id);
    try {
      await api("deleteProject", { params: { id } });
      setProjects((prev) => prev.filter((p) => p.id !== id));
      setConfirmId(null);
      onDeleted(id);
      toast(`${name} deleted.`, "success");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) {
    return <div className="text-sm text-neutral-400">Loading projects…</div>;
  }

  return (
    <div className="max-w-4xl space-y-4">
      <h2 className="text-lg font-semibold">Projects</h2>

      {error && (
        <div className="rounded border border-red-800 bg-red-950/50 px-4 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {projects.length === 0 && (
        <p className="text-sm text-neutral-400">
          No projects yet — create one from New Project.
        </p>
      )}

      <div className="space-y-2">
        {projects.map((p) => {
          const scheduleLabel = formatSchedule(p.config?.schedule);
          return (
          <div
            key={p.id}
            className={
              "rounded-lg border bg-neutral-900 p-3 " +
              (p.id === selectedProjectId
                ? "border-blue-700"
                : "border-neutral-800")
            }
          >
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => onSelect(p.id)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="text-sm font-medium text-neutral-100">
                  {p.name}
                  {p.id === selectedProjectId && (
                    <span className="ml-2 text-[10px] text-blue-400">
                      (selected)
                    </span>
                  )}
                </div>
                <div className="truncate text-[11px] text-neutral-400" title={p.repoUrl}>
                  {p.repoUrl}
                </div>
                <div className="truncate font-mono text-[10px] text-neutral-600" title={p.localPath}>
                  {p.localPath}
                </div>
              </button>
              <span
                className={
                  "rounded px-2 py-0.5 text-[11px] " +
                  (STATUS_COLOR[p.status] ?? "bg-neutral-700 text-neutral-200")
                }
              >
                {p.status}
              </span>
              {p.budgetUsd != null && (
                <span className="text-[11px] text-neutral-400">
                  budget ${p.budgetUsd}
                </span>
              )}
              {scheduleLabel && (
                <span
                  className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400"
                  title="Auto-start schedule"
                >
                  {scheduleLabel}
                </span>
              )}

              {p.status === "running" ? (
                <>
                  <button
                    onClick={() => act(p.id, "pauseProject", { drain: true })}
                    disabled={busyId === p.id}
                    title="Stop dispatching new tasks; let anything already running finish"
                    className="rounded border border-amber-800 px-2 py-1 text-[11px] text-amber-300 hover:bg-amber-950/40 disabled:opacity-50"
                  >
                    {busyId === p.id ? "…" : "⏸ Pause"}
                  </button>
                  <button
                    onClick={() => {
                      if (
                        window.confirm(
                          "Stop now? Any task currently running will be aborted and requeued to backlog.",
                        )
                      ) {
                        act(p.id, "pauseProject", { drain: false });
                      }
                    }}
                    disabled={busyId === p.id}
                    title="Abort any running task immediately and requeue it to backlog"
                    className="rounded border border-red-800 px-2 py-1 text-[11px] text-red-300 hover:bg-red-950/40 disabled:opacity-50"
                  >
                    {busyId === p.id ? "…" : "Stop now"}
                  </button>
                </>
              ) : (
                <button
                  onClick={() => act(p.id, "startProject")}
                  disabled={busyId === p.id || !STARTABLE.includes(p.status)}
                  className="rounded bg-green-700 px-2 py-1 text-[11px] font-medium text-white hover:bg-green-600 disabled:opacity-50"
                >
                  {busyId === p.id ? "…" : p.status === "paused" ? "▶ Resume" : "▶ Start"}
                </button>
              )}

              {confirmId === p.id ? (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-red-400">
                    Delete + remove local clone?
                  </span>
                  <button
                    onClick={() => deleteProject(p.id)}
                    disabled={deletingId === p.id}
                    className="rounded bg-red-700 px-2 py-1 text-[11px] font-medium text-white hover:bg-red-600 disabled:opacity-50"
                  >
                    {deletingId === p.id ? "Deleting…" : "Confirm"}
                  </button>
                  <button
                    onClick={() => setConfirmId(null)}
                    className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmId(p.id)}
                  disabled={p.status === "running"}
                  title={
                    p.status === "running"
                      ? "Pause the project before deleting"
                      : undefined
                  }
                  className="rounded border border-red-900 px-2 py-1 text-[11px] text-red-400 hover:bg-red-950/50 disabled:opacity-30"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}
