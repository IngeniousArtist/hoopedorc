import type {
  GateResult,
  LogEvent,
  MergeDecision,
  ModelConfig,
  ModelId,
  Run,
  Task,
  TaskDecisionsResponse,
} from "@orc/types";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { LogPanel } from "./LogPanel";
import { ModelSelect } from "./ModelSelect";

type Tab = "overview" | "logs" | "review" | "pr";
const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "logs", label: "Logs" },
  { key: "review", label: "Review" },
  { key: "pr", label: "PR" },
];

const GATE_KEYS: (keyof Pick<
  GateResult,
  "typecheck" | "lint" | "build" | "tests" | "noConflicts" | "inScope"
>)[] = ["typecheck", "lint", "build", "tests", "noConflicts", "inScope"];

function fmtDuration(startedAt: string, endedAt?: string): string {
  if (!endedAt) return "running…";
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const VERDICT_CLS: Record<MergeDecision["verdict"], string> = {
  approve: "bg-green-900/40 text-green-300",
  escalate: "bg-amber-900/40 text-amber-300",
  request_changes: "bg-red-900/40 text-red-300",
};

/**
 * The right-side task detail drawer (F2). Replaces the old cramped
 * selected-task strip: same fixed-shell/close-button pattern LogPanel used
 * to own alone, now shared across four tabs. Board.tsx still owns
 * logs/diff/actionBusy (WS-live state) and passes them down; this component
 * additionally fetches runs + validator decisions itself, refetching
 * whenever the task's status or attempt count changes.
 */
export function TaskDrawer({
  task,
  models,
  repoUrl,
  logs,
  logsLoading,
  diff,
  actionBusy,
  onClose,
  onViewDiff,
  onRetry,
  onRollback,
  onModelChange,
}: {
  task: Task;
  models: ModelConfig[];
  repoUrl?: string;
  logs: LogEvent[];
  logsLoading: boolean;
  diff: string | null;
  actionBusy: boolean;
  onClose: () => void;
  onViewDiff: () => void;
  onRetry: () => void;
  onRollback: () => void;
  /** U6 — moved here from the kanban card itself: same enable/disable rule
   *  (only non-active tasks), but the card now just shows a static chip. */
  onModelChange: (m: ModelId) => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [runs, setRuns] = useState<Run[]>([]);
  const [decisions, setDecisions] = useState<MergeDecision[]>([]);

  useEffect(() => {
    let cancelled = false;
    api<{ runs: Run[] }>("listTaskRuns", { params: { id: task.id } })
      .then((r) => {
        if (!cancelled) setRuns(r.runs);
      })
      .catch(() => {});
    api<TaskDecisionsResponse>("taskDecisions", { params: { id: task.id } })
      .then((r) => {
        if (!cancelled) setDecisions(r.decisions);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Re-fetch whenever this task's lifecycle moves forward — a new run or a
    // new validator decision most reliably shows up as one of these changing.
  }, [task.id, task.status, task.attempts]);

  const modelName = (id: string) =>
    models.find((m) => m.id === id)?.displayName ?? id;
  const latestGate = decisions[0]?.gate;
  const prUrl = repoUrl && task.prNumber ? `${repoUrl}/pull/${task.prNumber}` : undefined;
  const canRetry =
    task.status === "failed" ||
    task.status === "changes_requested" ||
    task.status === "blocked";

  return (
    <div className="fixed bottom-0 right-0 top-0 z-50 flex w-full flex-col border-l border-neutral-700 bg-neutral-900 shadow-2xl sm:w-[420px]">
      <div className="flex items-center justify-between border-b border-neutral-700 px-4 py-3">
        <div
          className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-200"
          title={task.title}
        >
          {task.title}
        </div>
        <button
          onClick={onClose}
          className="ml-2 rounded p-1 text-neutral-400 hover:text-neutral-200"
          aria-label="Close task drawer"
        >
          {"✕"}
        </button>
      </div>

      <div className="flex border-b border-neutral-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={
              "flex-1 px-2 py-2 text-xs font-medium transition-colors " +
              (tab === t.key
                ? "border-b-2 border-blue-500 text-neutral-100"
                : "text-neutral-500 hover:text-neutral-300")
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === "overview" && (
          <div className="space-y-4 p-4 text-xs">
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                Description
              </div>
              <p className="whitespace-pre-wrap text-neutral-300">
                {task.description || "(none)"}
              </p>
            </div>

            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                Acceptance criteria
              </div>
              {task.acceptanceCriteria.length === 0 ? (
                <p className="text-neutral-500">(none)</p>
              ) : (
                <ul className="space-y-1">
                  {task.acceptanceCriteria.map((c, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 text-neutral-300"
                    >
                      <input
                        type="checkbox"
                        checked
                        disabled
                        className="mt-0.5 shrink-0"
                      />
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                Scope paths
              </div>
              <div className="flex flex-wrap gap-1">
                {task.scopePaths.map((s) => (
                  <span
                    key={s}
                    className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-300"
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                Model
              </div>
              <ModelSelect
                value={task.assignedModel}
                models={models}
                onChange={(m) => {
                  if (m) onModelChange(m);
                }}
                disabled={
                  task.status === "in_progress" || task.status === "in_review"
                }
                disabledReason="Running — wait for this attempt to finish to reassign"
              />
              <p className="mt-1 text-neutral-500">
                May escalate through a fallback chain by difficulty if an
                attempt fails (Settings → Routing)
              </p>
            </div>

            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                Attempts
              </div>
              {runs.length === 0 ? (
                <p className="text-neutral-500">No runs yet.</p>
              ) : (
                <div className="divide-y divide-neutral-800 rounded border border-neutral-800">
                  {runs.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px]"
                    >
                      <span className="text-neutral-300">
                        {modelName(r.model)}
                      </span>
                      <span className="text-neutral-500">
                        {fmtDuration(r.startedAt, r.endedAt)} · $
                        {r.costUsd.toFixed(4)} ·{" "}
                        {r.exitReason ?? r.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "logs" && <LogPanel logs={logs} loading={logsLoading} />}

        {tab === "review" && (
          <div className="space-y-4 p-4 text-xs">
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                Latest gate result
              </div>
              {!latestGate ? (
                <p className="text-neutral-500">No gate result yet.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {GATE_KEYS.map((k) => (
                    <details key={k}>
                      <summary
                        className={
                          "cursor-pointer list-none rounded px-2 py-1 text-[11px] " +
                          (latestGate[k]
                            ? "bg-green-900/40 text-green-300"
                            : "bg-red-900/40 text-red-300")
                        }
                      >
                        {k} {latestGate[k] ? "✓" : "✕"}
                      </summary>
                      <pre className="mt-1 max-h-40 max-w-full overflow-auto rounded border border-neutral-800 bg-neutral-950 p-2 font-mono text-[10px] text-neutral-400">
                        {latestGate.details[k] || "(no output)"}
                      </pre>
                    </details>
                  ))}
                  {latestGate.vacuous && (
                    <span className="rounded bg-amber-900/40 px-2 py-1 text-[11px] text-amber-300">
                      no objective gates ran
                    </span>
                  )}
                </div>
              )}
            </div>

            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                Validator verdicts
              </div>
              {decisions.length === 0 ? (
                <p className="text-neutral-500">No reviews yet.</p>
              ) : (
                <div className="space-y-2">
                  {decisions.map((d) => (
                    <div
                      key={d.id}
                      className="rounded border border-neutral-800 p-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={
                            "rounded px-1.5 py-0.5 text-[11px] " +
                            VERDICT_CLS[d.verdict]
                          }
                        >
                          {d.verdict}
                        </span>
                        <span className="text-[10px] text-neutral-500">
                          confidence {(d.confidence * 100).toFixed(0)}% ·{" "}
                          {modelName(d.validatorModel)}
                        </span>
                      </div>
                      {d.reasons.length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-[11px] text-neutral-400">
                          {d.reasons.map((r, i) => (
                            <li key={i}>• {r}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "pr" && (
          <div className="space-y-3 p-4 text-xs">
            {!task.prNumber ? (
              <p className="text-neutral-500">No PR opened yet.</p>
            ) : (
              <>
                {prUrl ? (
                  <a
                    href={prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block rounded border border-blue-800 px-3 py-1.5 text-blue-300 hover:bg-blue-950/40"
                  >
                    View PR #{task.prNumber} on GitHub {"↗"}
                  </a>
                ) : (
                  <p className="text-neutral-400">PR #{task.prNumber}</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={onViewDiff}
                    disabled={actionBusy}
                    className="rounded border border-neutral-700 px-3 py-1.5 text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
                  >
                    View diff
                  </button>
                  {canRetry && (
                    <button
                      onClick={onRetry}
                      disabled={actionBusy}
                      className="rounded border border-blue-800 px-3 py-1.5 text-blue-300 hover:bg-blue-950/40 disabled:opacity-50"
                    >
                      {actionBusy ? "Working…" : "↻ Retry task"}
                    </button>
                  )}
                  {task.status === "done" && (
                    <button
                      onClick={onRollback}
                      disabled={actionBusy}
                      className="rounded border border-amber-800 px-3 py-1.5 text-amber-300 hover:bg-amber-950/40 disabled:opacity-50"
                    >
                      {actionBusy ? "Working…" : "↩ Rollback merge"}
                    </button>
                  )}
                </div>
                {diff && (
                  <pre className="max-h-96 overflow-auto rounded border border-neutral-800 bg-neutral-950 p-3 font-mono text-[11px] leading-relaxed text-neutral-300">
                    {diff}
                  </pre>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
