import type { AuditEntry, AuditLogResponse, ServerEvent } from "@orc/types";
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
};

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
        event.type === "notification"
      ) {
        fetchAudit();
      }
    },
    [fetchAudit],
  );
  useWS(projectId, onWS);

  if (error) return <div className="text-sm text-red-400">Error: {error}</div>;

  return (
    <div className="max-w-3xl space-y-4">
      <h2 className="text-lg font-semibold">Audit Log</h2>

      {entries.length === 0 && (
        <p className="text-sm text-neutral-400">
          No audit entries yet. Merge decisions, approvals, completions, and
          rollbacks are recorded here as the engine runs.
        </p>
      )}

      <ol className="space-y-2">
        {entries.map((e) => (
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
