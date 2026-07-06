import type { Task, TaskStatus } from "@orc/types";
import { formatUsd } from "../lib/format";

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
 * At-a-glance digest of "what happened" on this board — counts, spend, and
 * the most recent terminal event — sitting above the columns so the full
 * picture doesn't require switching to the Audit or Costs page.
 */
export function BoardSummary({
  tasks,
  costUsd,
}: {
  tasks: Task[];
  costUsd: number;
}) {
  if (tasks.length === 0) return null;

  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const active = tasks.filter(
    (t) => t.status === "in_progress" || t.status === "in_review",
  ).length;
  const blocked = tasks.filter(
    (t) => t.status === "blocked" || t.status === "changes_requested",
  ).length;
  const total = tasks.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const last = lastFinished(tasks);

  return (
    <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="font-medium text-neutral-200">
          {done}/{total} tasks done ({pct}%)
        </span>
        {active > 0 && <span className="text-blue-300">{active} active</span>}
        {blocked > 0 && (
          <span className="text-amber-300">{blocked} need attention</span>
        )}
        {failed > 0 && <span className="text-red-300">{failed} failed</span>}
        <span className="text-neutral-400">{formatUsd(costUsd)} spent</span>
      </div>
      {last && (
        <div className="mt-1.5 truncate text-[11px] text-neutral-400">
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
