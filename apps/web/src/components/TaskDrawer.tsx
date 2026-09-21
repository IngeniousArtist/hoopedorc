import type {
  GateResult,
  LogEvent,
  MergeDecision,
  ModelConfig,
  ModelId,
  RollbackJob,
  Run,
  Task,
  TaskDecisionsResponse,
  TaskEstimate,
} from "@orc/types";
import { useEffect, useId, useState } from "react";
import { api } from "../api/client";
import { Dialog } from "./Dialog";
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

/** VW04: history reads are loading, ready, or failed — never silently empty. */
type LoadState<T> =
  | { status: "loading" }
  | { status: "ready"; items: T[] }
  | { status: "error"; message: string };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function HistoryError({
  what,
  message,
  onRetry,
}: {
  what: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 rounded border border-red-800 bg-red-950/40 px-3 py-2 text-red-200"
    >
      <span className="min-w-0 flex-1">
        Could not load {what}: {message}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="min-h-10 rounded border border-red-700 px-3 py-2 text-[11px] hover:bg-red-900/40 focus-visible:ring-2 focus-visible:ring-red-400"
      >
        Retry
      </button>
    </div>
  );
}

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
  logsOmittedOlder,
  logsError,
  onReloadLogs,
  rollbackError,
  diff,
  rollbackJob,
  estimate,
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
  logsOmittedOlder?: boolean;
  /** VW04: the log history read failed; live lines may still arrive. */
  logsError?: string | null;
  onReloadLogs?: () => void;
  /** VW04: the rollback status read failed (shown on the PR tab). */
  rollbackError?: string | null;
  diff: string | null;
  rollbackJob?: RollbackJob;
  /** VW04: F7's pre-run estimate, shown here now that cards hide it by default. */
  estimate?: TaskEstimate;
  actionBusy: boolean;
  onClose: () => void;
  onViewDiff: () => void;
  onRetry: () => void;
  onRollback: () => void;
  /** U6 — moved here from the kanban card itself: same enable/disable rule
   *  (only non-active tasks), but the card now just shows a static chip. */
  onModelChange: (m: ModelId) => void;
}) {
  const titleId = useId();
  const [tab, setTab] = useState<Tab>("overview");
  const [runsState, setRunsState] = useState<LoadState<Run>>({ status: "loading" });
  const [decisionsState, setDecisionsState] = useState<LoadState<MergeDecision>>({
    status: "loading",
  });
  const [historyReloadNonce, setHistoryReloadNonce] = useState(0);

  useEffect(() => {
    // Each (task, lifecycle step, retry) owns its own reads: a slow response
    // for a previous task can never populate this one, and a failed read is
    // shown as failed instead of as an empty history.
    let cancelled = false;
    setRunsState({ status: "loading" });
    setDecisionsState({ status: "loading" });
    api<{ runs: Run[] }>("listTaskRuns", { params: { id: task.id } })
      .then((r) => {
        if (!cancelled) setRunsState({ status: "ready", items: r.runs });
      })
      .catch((error: unknown) => {
        if (!cancelled) setRunsState({ status: "error", message: describeError(error) });
      });
    api<TaskDecisionsResponse>("taskDecisions", { params: { id: task.id } })
      .then((r) => {
        if (!cancelled) setDecisionsState({ status: "ready", items: r.decisions });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDecisionsState({ status: "error", message: describeError(error) });
        }
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch whenever this task's lifecycle moves forward — a new run or a
    // new validator decision most reliably shows up as one of these changing.
  }, [task.id, task.status, task.attempts, historyReloadNonce]);

  const retryHistory = () => setHistoryReloadNonce((nonce) => nonce + 1);
  const runs = runsState.status === "ready" ? runsState.items : [];
  const decisions = decisionsState.status === "ready" ? decisionsState.items : [];

  const modelName = (id: string) =>
    models.find((m) => m.id === id)?.displayName ?? id;
  const latestGate = decisions[0]?.gate;
  const prUrl = repoUrl && task.prNumber ? `${repoUrl}/pull/${task.prNumber}` : undefined;
  const canRetry =
    task.status === "failed" ||
    task.status === "changes_requested" ||
    task.status === "blocked";

  return (
    <Dialog
      labelledBy={titleId}
      onDismiss={onClose}
      className="bottom-0 left-auto right-0 top-0 m-0 flex h-[100dvh] max-h-none w-full max-w-none flex-col border-0 border-l border-neutral-700 bg-neutral-900 p-0 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-neutral-100 shadow-2xl sm:w-[420px]"
    >
      <div className="flex min-h-12 items-center justify-between border-b border-neutral-700 px-4 py-2">
        <div
          id={titleId}
          className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-200"
          title={task.title}
        >
          {task.title}
        </div>
        <button
          onClick={onClose}
          data-dialog-initial-focus
          className="ml-2 min-h-10 min-w-10 rounded px-2 py-1 text-neutral-400 hover:text-neutral-200 focus-visible:ring-2 focus-visible:ring-blue-500"
          aria-label="Close task drawer"
        >
          {/* VW04: phones show the inspector full-screen as its own history
              entry, so the control reads as Back there; wider layouts keep ✕. */}
          <span className="text-xs sm:hidden">‹ Back</span>
          <span className="hidden sm:inline">{"✕"}</span>
        </button>
      </div>

      <a className="inline-flex min-h-10 items-center px-4 text-sm text-blue-400 underline focus-visible:ring-2 focus-visible:ring-blue-500" href={`#/p/${task.projectId}/review/${encodeURIComponent(task.id)}`}>Open full review</a>
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
            {canRetry && (
              <div className="flex flex-wrap items-center gap-2 rounded border border-blue-900/60 bg-blue-950/20 p-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-blue-200">Recovery available</div>
                  <p className="mt-0.5 text-[11px] text-neutral-400">
                    Requeue this task with priority, even if it failed before opening a PR.
                  </p>
                </div>
                <button
                  onClick={onRetry}
                  disabled={actionBusy}
                  className="w-full rounded border border-blue-800 px-3 py-1.5 text-blue-300 hover:bg-blue-950/40 disabled:opacity-50 sm:w-auto"
                >
                  {actionBusy ? "Working…" : "↻ Retry task"}
                </button>
              </div>
            )}
            {task.dispatchRequestedAt && (
              <div className="rounded border border-blue-900 bg-blue-950/30 px-3 py-2 text-blue-300">
                Priority dispatch queued. It will start when dependencies and scheduler capacity allow.
              </div>
            )}
            {task.statusReason && (
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                  Outcome
                </div>
                <p
                  className={
                    "whitespace-pre-wrap " +
                    (task.status === "done" ? "text-green-400" : "text-amber-400")
                  }
                >
                  {task.statusReason}
                </p>
              </div>
            )}

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

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                  Status
                </div>
                <p className="text-neutral-300">
                  {task.status.replaceAll("_", " ")}
                  {task.dispatchRequestedAt ? " · run next requested" : ""}
                </p>
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                  Difficulty
                </div>
                <p className="text-neutral-300">{task.difficulty}</p>
              </div>
              {estimate && (
                <div className="sm:col-span-2">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                    Estimated cost
                  </div>
                  <p className="text-neutral-300">
                    ~${estimate.expectedUsd.toFixed(2)}
                    <span className="text-neutral-500">
                      {estimate.hasHistory
                        ? ` · up to ${estimate.highUsd.toFixed(2)} across all attempts, from run history`
                        : " · low confidence, no run history yet for this model"}
                    </span>
                  </p>
                </div>
              )}
            </div>

            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                Model
              </div>
              <ModelSelect
                ariaLabel="Assigned model"
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
                May escalate through the fallback models if an attempt fails
                (Settings → Routing → Fallback 1/2)
              </p>
            </div>

            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                Attempts
              </div>
              {runsState.status === "loading" ? (
                <p role="status" className="text-neutral-500">Loading attempts…</p>
              ) : runsState.status === "error" ? (
                <HistoryError what="attempts" message={runsState.message} onRetry={retryHistory} />
              ) : runs.length === 0 ? (
                <p className="text-neutral-500">No runs yet.</p>
              ) : (
                <div className="divide-y divide-neutral-800 rounded border border-neutral-800">
                  {runs.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px]"
                    >
                      <span className="text-neutral-300">
                        {modelName(r.model)} · effort {r.effort ?? "default"}
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

        {tab === "logs" && (
          <LogPanel
            logs={logs}
            loading={logsLoading}
            omittedOlder={logsOmittedOlder}
            error={logsError}
            onRetry={onReloadLogs}
          />
        )}

        {tab === "review" && (
          <div className="space-y-4 p-4 text-xs">
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                Latest gate result
              </div>
              {decisionsState.status === "loading" ? (
                <p role="status" className="text-neutral-500">Loading review history…</p>
              ) : decisionsState.status === "error" ? (
                <HistoryError
                  what="review history"
                  message={decisionsState.message}
                  onRetry={retryHistory}
                />
              ) : !latestGate ? (
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
              {decisionsState.status !== "ready" ? (
                <p className="text-neutral-500">
                  {decisionsState.status === "loading" ? "Loading…" : "Unavailable until the review history loads."}
                </p>
              ) : decisions.length === 0 ? (
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
                {rollbackError && (
                  <p role="alert" className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-red-200">
                    Rollback status could not be loaded: {rollbackError}. Reopen the task to try again.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={onViewDiff}
                    disabled={actionBusy}
                    className="rounded border border-neutral-700 px-3 py-1.5 text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
                  >
                    View diff
                  </button>
                  {task.status === "done" && !rollbackJob && (
                    <button
                      onClick={onRollback}
                      disabled={actionBusy}
                      className="rounded border border-amber-800 px-3 py-1.5 text-amber-300 hover:bg-amber-950/40 disabled:opacity-50"
                    >
                      {actionBusy ? "Working…" : "↩ Rollback merge"}
                    </button>
                  )}
                </div>
                {rollbackJob && (
                  <div className="border-l-2 border-amber-700 pl-3 text-neutral-300">
                    <div className="font-medium text-amber-300">
                      Rollback {rollbackJob.status.replaceAll("_", " ")}
                    </div>
                    {rollbackJob.statusReason && (
                      <p className="mt-1 text-neutral-400">
                        {rollbackJob.statusReason}
                      </p>
                    )}
                    {repoUrl && rollbackJob.rollbackPrNumber && (
                      <a
                        href={`${repoUrl}/pull/${rollbackJob.rollbackPrNumber}`}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-block text-blue-300 hover:text-blue-200"
                      >
                        View rollback PR #{rollbackJob.rollbackPrNumber} {"↗"}
                      </a>
                    )}
                  </div>
                )}
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
    </Dialog>
  );
}
