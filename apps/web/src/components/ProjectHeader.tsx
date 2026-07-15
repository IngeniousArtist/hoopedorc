import type { Project, RouteKey } from "@orc/types";
import { useState } from "react";
import { api } from "../api/client";
import { useToast } from "../hooks/useToast";
import { formatSchedule } from "../lib/format";
import {
  ProjectConfigFields,
  projectConfigFormError,
  projectConfigFromForm,
  projectConfigToForm,
} from "./ProjectConfigFields";

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

/**
 * U2: `compact` renders just the name/repo/status/run-controls row — used on
 * every project page except Board, where budget editing and the Advanced
 * accordion have nothing to do with the page's own content (Plan, Costs,
 * Audit, Notifications). Board keeps the full editor (compact omitted).
 */
export function ProjectHeader({ project, compact = false }: { project: Project; compact?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const origBudget = project.budgetUsd != null ? String(project.budgetUsd) : "";
  const [budget, setBudget] = useState(origBudget);
  const origConfigForm = projectConfigToForm(project.config);
  const [configForm, setConfigForm] = useState(origConfigForm);

  async function act(route: RouteKey, body?: unknown) {
    setBusy(true);
    try {
      await api(route, { params: { id: project.id }, body });
      // status update arrives via WS (project.updated) and re-renders this header.
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  function stopNow() {
    if (
      window.confirm(
        "Stop now? Any task currently running will be aborted and requeued to backlog.",
      )
    ) {
      act("pauseProject", { drain: false });
    }
  }

  async function saveBudget() {
    setBusy(true);
    try {
      await api("updateProject", {
        params: { id: project.id },
        body: { budgetUsd: budget === "" ? null : parseFloat(budget) },
      });
      toast("Budget saved.", "success");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig() {
    // B22: a partially-filled schedule (e.g. hour set, minute blank) would
    // otherwise silently drop the whole schedule object on save — block it
    // here too, not just via the disabled button, in case the two ever
    // disagree.
    if (projectConfigFormError(configForm)) return;
    setBusy(true);
    try {
      await api("updateProject", {
        params: { id: project.id },
        body: { config: projectConfigFromForm(configForm) ?? null },
      });
      toast("Advanced settings saved.", "success");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  const running = project.status === "running";
  const startLabel = project.status === "paused" ? "Resume" : "Start";
  const budgetDirty = budget !== origBudget;
  const configDirty = JSON.stringify(configForm) !== JSON.stringify(origConfigForm);
  const configError = projectConfigFormError(configForm);
  const scheduleLabel = formatSchedule(project.config?.schedule);

  return (
    <div className="mb-4 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-neutral-100">
            {project.name}
          </div>
          <div className="truncate text-[11px] text-neutral-400" title={project.repoUrl}>
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
        {scheduleLabel && (
          <span
            className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400"
            title="Auto-start schedule (Advanced settings)"
          >
            {scheduleLabel}
          </span>
        )}

        <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
          {running ? (
            <>
              <button
                onClick={() => act("pauseProject", { drain: true })}
                disabled={busy}
                className="rounded border border-amber-800 px-3 py-1 text-xs text-amber-300 hover:bg-amber-950/40 disabled:opacity-50"
                title="Stop dispatching new tasks; let anything already running finish"
              >
                {busy ? "…" : "⏸ Pause (finish current)"}
              </button>
              <button
                onClick={stopNow}
                disabled={busy}
                className="rounded border border-red-800 px-3 py-1 text-xs text-red-300 hover:bg-red-950/40 disabled:opacity-50"
                title="Abort any running task immediately and requeue it to backlog"
              >
                {busy ? "…" : "⏹ Stop now"}
              </button>
            </>
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

      {!compact && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-neutral-400">
            <label htmlFor="project-budget-editor">Budget $</label>
            <input
              id="project-budget-editor"
              type="text"
              inputMode="decimal"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="none"
              className="w-28 rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-neutral-200"
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

          <div className="mt-2">
            <ProjectConfigFields form={configForm} onChange={setConfigForm} />
            {configDirty && (
              <div className="mt-1 flex items-center gap-2 text-[11px]">
                <button
                  onClick={saveConfig}
                  disabled={busy || !!configError}
                  title={configError ?? undefined}
                  className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
                >
                  Save advanced settings
                </button>
                {configError ? (
                  <span className="text-amber-400">{configError}</span>
                ) : (
                  <span className="text-amber-400">unsaved</span>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
