import type { Task, TaskStatus } from "@orc/types";
import { formatUsd } from "../lib/format";
import { groupCounts, type BoardGroupKey } from "../lib/boardGroups";

const STATUS_LABEL: Partial<Record<TaskStatus, string>> = {
  done: "done",
  failed: "failed",
  in_progress: "running",
  in_review: "in review",
  changes_requested: "changes requested",
  blocked: "blocked",
};

/** Most recently updated task that's actually finished (done/failed). */
function lastFinished(tasks: Task[]): Task | null {
  const finished = tasks.filter((t) => t.status === "done" || t.status === "failed");
  if (finished.length === 0) return null;
  return finished.reduce((latest, t) =>
    new Date(t.updatedAt) > new Date(latest.updatedAt) ? t : latest,
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * VW04: one compact line above the board — progress, what is moving, what
 * needs a decision, and spend against budget — instead of a stacked runtime
 * dashboard. The attention count is a control: it takes the operator to the
 * "Needs attention" group. Details (per-agent rows, last event) stay one
 * disclosure away.
 */
export function BoardSummary({
  tasks,
  costUsd,
  budgetUsd,
  onFocusGroup,
}: {
  tasks: Task[];
  costUsd: number;
  budgetUsd?: number;
  /** Scroll to / switch to a group on the board (kanban column or phone list tab). */
  onFocusGroup?: (group: BoardGroupKey) => void;
}) {
  if (tasks.length === 0) return null;

  const counts = groupCounts(tasks);
  const total = tasks.length;
  const pct = total > 0 ? Math.round((counts.done / total) * 100) : 0;
  const last = lastFinished(tasks);
  const budgetPct =
    budgetUsd && budgetUsd > 0 ? Math.min(100, (costUsd / budgetUsd) * 100) : null;

  return (
    <div
      data-testid="board-summary"
      className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900/50 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <div className="flex min-w-[10rem] flex-1 items-center gap-2">
          <span className="shrink-0 font-medium text-neutral-200">
            {counts.done}/{total} done
          </span>
          <div
            role="progressbar"
            aria-label="Tasks done"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={counts.done}
            className="h-1.5 min-w-16 flex-1 overflow-hidden rounded bg-neutral-800"
          >
            <div className="h-full bg-green-600" style={{ width: `${pct}%` }} />
          </div>
        </div>
        {counts.working > 0 && (
          <span className="text-green-300">{counts.working} working</span>
        )}
        {counts.review > 0 && (
          <span className="text-violet-300">{counts.review} in review</span>
        )}
        {counts.planned > 0 && (
          <span className="text-neutral-400">{counts.planned} planned</span>
        )}
        {counts.attention > 0 && (
          <button
            type="button"
            onClick={() => onFocusGroup?.("attention")}
            className="rounded border border-amber-800 px-2 py-0.5 text-[11px] font-medium text-amber-300 hover:bg-amber-950/40 focus-visible:ring-2 focus-visible:ring-amber-400"
          >
            Needs attention · {counts.attention}
          </button>
        )}
        <span
          className="text-neutral-400"
          title={budgetUsd ? `${formatUsd(costUsd)} spent of a ${formatUsd(budgetUsd)} budget` : undefined}
        >
          {formatUsd(costUsd)} spent{budgetUsd ? ` of ${formatUsd(budgetUsd)}` : ""}
        </span>
        {budgetPct !== null && (
          <div
            role="progressbar"
            aria-label="Budget used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(budgetPct)}
            className="h-1.5 w-20 overflow-hidden rounded bg-neutral-800"
          >
            <div
              className={
                "h-full " +
                (budgetPct > 90
                  ? "bg-red-500"
                  : budgetPct > 70
                    ? "bg-amber-500"
                    : "bg-green-600")
              }
              style={{ width: `${budgetPct}%` }}
            />
          </div>
        )}
      </div>
      {last && (
        <div className="mt-1 truncate text-[11px] text-neutral-400">
          Last: <span className="text-neutral-300">{last.title}</span>
          {" → "}
          <span className={last.status === "done" ? "text-green-400" : "text-red-400"}>
            {STATUS_LABEL[last.status] ?? last.status}
          </span>
          {last.prNumber && ` (PR #${last.prNumber})`} · {timeAgo(last.updatedAt)}
        </div>
      )}
    </div>
  );
}
