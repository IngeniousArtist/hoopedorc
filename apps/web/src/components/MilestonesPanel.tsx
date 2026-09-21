import { useEffect, useRef, useState } from "react";
import type { MilestonesResponse, MilestoneRepairDraftResponse, PlanChangeContextResponse } from "@orc/types";
import { api, isAbortError } from "../api/client";

const control = "inline-flex min-h-10 items-center justify-center rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50";
export function MilestonesPanel({ projectId, compact = false }: { projectId: string; compact?: boolean }) {
  const [data, setData] = useState<MilestonesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0); const acting = useRef(false);
  useEffect(() => {
    const current = ++generation.current; const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    acting.current = false; setBusy(false); setData(null); setError(null); setCreated(null); setConfirm(null);
    async function load() {
      try {
        const value = await api<MilestonesResponse>("milestones", { params: { id: projectId }, signal: controller.signal });
        if (!controller.signal.aborted && !acting.current) { setData(value); setError(null); }
      } catch (err) { if (!controller.signal.aborted && !isAbortError(err)) setError(err instanceof Error ? err.message : "Milestones could not be loaded."); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void load(), 5000); }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); generation.current = current + 1; };
  }, [projectId, refresh]);
  async function repair(taskId: string) {
    if (acting.current) return;
    const current = generation.current; acting.current = true; setBusy(true); setError(null);
    try {
      const context = await api<PlanChangeContextResponse>("planChangeContext", { params: { id: projectId } });
      if (current !== generation.current) return;
      await api<MilestoneRepairDraftResponse>("milestoneRepairDraft", { params: { id: projectId, taskId }, body: { revisionId: context.revisionId, sessionVersion: context.sessionVersion, taskGeneration: context.taskGeneration } });
      if (current === generation.current) { setCreated(taskId); setConfirm(null); }
    } catch (err) { if (current === generation.current) setError(err instanceof Error ? err.message : "Repair draft could not be prepared."); }
    finally { if (current === generation.current) { acting.current = false; setBusy(false); } }
  }
  return <section aria-label="Milestone acceptance" className="min-w-0 space-y-3 rounded-lg border border-neutral-800 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">Milestones</h2>{data && <span className="text-sm text-neutral-400">{data.milestones.filter((item) => item.state === "accepted").length} of {data.milestones.length} accepted</span>}</div>
    {error && <div role="alert" className="space-y-2 text-sm text-red-300"><p>{error}</p><button className={control} disabled={busy} onClick={() => setRefresh((value) => value + 1)}>Refresh milestones</button></div>}
    {!data && !error && <p role="status" className="text-sm text-neutral-400">Loading milestone evidence…</p>}
    {data?.milestones.length === 0 && <p className="text-sm text-neutral-400">No milestone criteria were approved for this plan. Task completion does not prove the full brief works. Add a verification milestone in Plan.</p>}
    {data?.milestones.map((item) => <article key={item.task.id} className="min-w-0 space-y-3 border-t border-neutral-800 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="min-w-0 break-words font-medium">{item.task.title}</h3><span className={`text-sm ${item.state === "accepted" ? "text-green-300" : "text-amber-300"}`}>{item.state.replaceAll("_", " ")}</span></div>
      <p className="break-words text-sm text-neutral-300">{item.reason}</p>
      {!compact && <>
        <ol className="list-decimal space-y-3 pl-5 text-sm">{item.task.acceptanceCriteria.map((criterion, index) => <li key={index} className="break-words"><p>{criterion}</p><p className="mt-1 text-neutral-400">{item.decision?.criterionEvidence?.find((entry) => entry.criterion === criterion)?.evidence ?? "No criterion evidence recorded."}</p></li>)}</ol>
        <details><summary className="flex min-h-10 cursor-pointer items-center text-sm focus-visible:ring-2 focus-visible:ring-blue-500">Contributing work and verification identity</summary>
          <ul className="space-y-1 text-sm">{item.contributors.map((task) => <li key={task.id}><a className={`${control} max-w-full break-words`} href={`#/p/${projectId}/board/${encodeURIComponent(task.id)}`}>{task.title} · {task.status.replaceAll("_", " ")}</a></li>)}</ul>
          <p className="mt-2 break-all text-xs text-neutral-400">Verified HEAD: {item.decision?.milestoneProof?.headSha ?? "unavailable"} · Current observed HEAD: {item.currentHead ?? "unavailable"}</p>
          <p className="break-words text-xs text-neutral-400">{item.decision?.milestoneProof?.environment ?? "No verified environment"}</p>
          {item.decision && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs text-neutral-400">{Object.entries(item.decision.gate.details).map(([name, output]) => `${name}: ${output}`).join("\n")}</pre>}
        </details>
        <p className="text-sm text-neutral-400">Repair rounds {item.repairRounds}/{item.task.milestone!.maxRepairRounds} · admitted calls {item.calls}/{item.task.milestone!.maxInvocations} · observed ${item.observedCostUsd.toFixed(2)}/${item.task.milestone!.maxCostUsd.toFixed(2)}{item.deadline ? ` · deadline ${new Date(item.deadline).toLocaleString()}` : ` · ${item.task.milestone!.maxDurationMinutes} minutes from first verification`}</p>
        <p className="text-xs text-neutral-400">Calls include subscription activity. Spending is an observed cutoff; an in-flight call can exceed it. {item.unknownSpendCalls > 0 ? `${item.unknownSpendCalls} admitted call(s) have unknown or unsettled spending.` : ""}</p>
      </>}
      <div className="flex flex-wrap gap-2"><a className={control} href={`#/p/${projectId}/board/${encodeURIComponent(item.verificationTask.id)}`}>Inspect verification task</a>
        {compact ? <a className={control} href={`#/p/${projectId}/review`}>Review evidence</a> : <button className={control} disabled={busy || !!item.repairUnavailableReason || created === item.task.id} onClick={() => setConfirm(item.task.id)}>Prepare repair draft</button>}</div>
      {!compact && item.repairUnavailableReason && <p className="text-xs text-neutral-400">{item.repairUnavailableReason}</p>}
      {confirm === item.task.id && <div role="group" aria-label="Confirm milestone repair" className="space-y-3 rounded border border-amber-800 p-3 text-sm"><p>Prepare one repair task and one verification task using the original criteria and remaining limits? Review the draft in Plan before applying it. Existing planning work is preserved.</p><div className="flex flex-wrap gap-2"><button className={control} disabled={busy} onClick={() => void repair(item.task.id)}>{busy ? "Preparing draft…" : "Confirm repair draft"}</button><button className={control} disabled={busy} onClick={() => setConfirm(null)}>Cancel</button></div></div>}
      {created === item.task.id && <p role="status" className="text-sm text-green-300">Repair draft saved. <a className={control} href={`#/p/${projectId}/plan`}>Review repair in Plan</a></p>}
    </article>)}
  </section>;
}
