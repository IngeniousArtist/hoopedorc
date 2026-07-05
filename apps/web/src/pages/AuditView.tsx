import type {
  AuditEntry,
  AuditLogResponse,
  RunSummaryDetail,
  ServerEvent,
} from "@orc/types";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { useWS } from "../hooks/useWS";

const KIND_ICON: Record<string, string> = {
  merge_decision: "⚖️",
  approval_requested: "🔔",
  approval_resolved: "✅",
  task_done: "🟢",
  task_failed: "🔴",
  rollback: "↩️",
  task_added: "➕",
  stopped: "⏹️",
  run_summary: "🏁",
};

function fmtDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${totalMinutes % 60}m`;
}

/** F8 — one autonomous-loop start-to-finish cycle's report card. */
function RunReportCard({ entry }: { entry: AuditEntry }) {
  const s = entry.detail as unknown as RunSummaryDetail | undefined;
  if (!s) return null;
  const ok = s.finalStatus === "completed";

  return (
    <div className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-900 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className={"text-sm font-medium " + (ok ? "text-green-400" : "text-amber-400")}>
          {ok ? "🏁" : "⚠️"} {s.finalStatus} · {fmtDuration(s.durationMs)}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-neutral-400">
          {new Date(entry.ts).toLocaleString()}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-neutral-400">
        <span className="text-green-400">{s.tasksDone} done</span>
        {s.tasksFailed > 0 && <span className="text-red-400">{s.tasksFailed} failed</span>}
        <span>${s.totalCostUsd.toFixed(4)} spent</span>
        {s.approvalsRequired > 0 && (
          <span className="text-amber-400">
            {s.approvalsRequired} approval{s.approvalsRequired === 1 ? "" : "s"} required
          </span>
        )}
      </div>
      {s.prLinks.length > 0 && (
        <div className="space-y-0.5 text-[11px]">
          {s.prLinks.map((pr) => (
            <div key={pr.taskId}>
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                className="text-blue-400 hover:underline"
              >
                {pr.title} (#{pr.prNumber}) ↗
              </a>
            </div>
          ))}
        </div>
      )}
      {s.topFailureReasons.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-neutral-400">
          {s.topFailureReasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AuditView({ projectId }: { projectId: string }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchAudit = useCallback(async () => {
    try {
      const res = await api<AuditLogResponse>("auditLog", {
        params: { id: projectId },
      });
      setEntries(res.entries);
    } catch (e) {
      setError(String(e));
    }
  }, [projectId]);

  useEffect(() => {
    fetchAudit();
  }, [fetchAudit]);

  const onWS = useCallback(
    (event: ServerEvent) => {
      if (
        event.type === "task.updated" ||
        event.type === "merge.decision" ||
        event.type === "notification" ||
        // A run's finalStatus lands on the project right before its summary
        // is persisted (F8) — this is what tells an open Audit tab to refresh.
        event.type === "project.updated"
      ) {
        fetchAudit();
      }
    },
    [fetchAudit],
  );
  useWS(projectId, onWS);

  if (error) return <div className="text-sm text-red-400">Error: {error}</div>;

  const runReports = entries.filter((e) => e.kind === "run_summary");
  const otherEntries = entries.filter((e) => e.kind !== "run_summary");

  return (
    <div className="max-w-3xl space-y-6">
      <h2 className="text-lg font-semibold">Audit Log</h2>

      {runReports.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-neutral-300">Run Reports</h3>
          <div className="space-y-2">
            {runReports.map((e) => (
              <RunReportCard key={e.id} entry={e} />
            ))}
          </div>
        </section>
      )}

      {entries.length === 0 && (
        <p className="text-sm text-neutral-400">
          No audit entries yet. Merge decisions, approvals, completions, and
          rollbacks are recorded here as the engine runs.
        </p>
      )}

      <ol className="space-y-2">
        {otherEntries.map((e) => (
          <li
            key={e.id}
            className="flex gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-3"
          >
            <span className="text-lg leading-none">
              {KIND_ICON[e.kind] ?? "•"}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm text-neutral-200">{e.summary}</span>
                <span className="shrink-0 font-mono text-[10px] text-neutral-400">
                  {new Date(e.ts).toLocaleString()}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-neutral-400">
                <span className="rounded bg-neutral-800 px-1.5 py-0.5">
                  {e.kind}
                </span>
                <span>{e.actor}</span>
              </div>
              {e.detail?.reasons != null &&
                Array.isArray(e.detail.reasons) &&
                e.detail.reasons.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-[11px] text-neutral-400">
                    {(e.detail.reasons as string[]).slice(0, 5).map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
