import { routingEvaluationExample, type EvaluateRoutingResponse, type RoutingEvaluationRecord, type RoutingEvaluationsResponse } from "@orc/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useConfirmation } from "./ConfirmationDialog";

const DRAFT_KEY = "hoopedorc.routing-evaluation-draft.v1";
const button = "min-h-10 rounded border border-neutral-700 px-3 py-2 text-sm hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-blue-400 disabled:opacity-50";
interface Draft { text: string; requestId?: string }
function initialDraft(): Draft {
  try { const value = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "{}") as Partial<Draft>; if (typeof value.text === "string" && value.text.length <= 512_000) return { text: value.text, requestId: typeof value.requestId === "string" ? value.requestId : undefined }; } catch { /* no retained draft available */ }
  return { text: "" };
}
const statusLabel = (status: RoutingEvaluationRecord["report"]["status"]) => ({ insufficient_evidence: "More evidence needed", keep_static: "Keep static routing", candidate_for_pilot: "Candidate for a separate pilot" })[status];
function downloadText(value: string, filename: string) {
  const url = URL.createObjectURL(new Blob([value], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function download(value: unknown, filename: string) { downloadText(JSON.stringify(value, null, 2), filename); }
const money = (value: number) => `$${value.toFixed(4)}`;
export function RoutingEvaluationPanel({ active }: { active: boolean }) {
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [storageError, setStorageError] = useState<string>();
  const [history, setHistory] = useState<RoutingEvaluationsResponse>();
  const [historyError, setHistoryError] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [record, setRecord] = useState<RoutingEvaluationRecord>();
  const draftRef = useRef(draft);
  const pending = useRef(false); const refreshing = useRef(false);
  const { requestConfirmation, confirmationDialog } = useConfirmation();
  const refresh = useCallback(async () => {
    if (refreshing.current) return; refreshing.current = true; setLoading(true); setHistoryError(undefined);
    try { setHistory(await api<RoutingEvaluationsResponse>("routingEvaluations")); }
    catch (e) { setHistoryError(e instanceof Error ? e.message : String(e)); }
    finally { refreshing.current = false; setLoading(false); }
  }, []);
  useEffect(() => { if (active) void refresh(); }, [active, refresh]);
  function saveDraft(next: Draft) {
    draftRef.current = next; setDraft(next); setError(undefined);
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(next)); setStorageError(undefined); }
    catch { setStorageError("This browser could not retain the draft. Keep this page open and download the input before leaving."); }
  }
  function replaceDraft(text: string) {
    const apply = () => saveDraft({ text });
    if (draftRef.current.text.trim()) requestConfirmation({ title: "Replace evaluation draft?", description: "The current input will be replaced. Saved reports remain available below.", confirmLabel: "Replace draft", action: apply }); else apply();
  }
  async function importFile(file: File) {
    if (pending.current) return;
    if (file.size > 512_000) { setError("Use a dataset of at most 512 KB."); return; }
    pending.current = true; setBusy(true);
    try { replaceDraft(await file.text()); }
    catch { setError("Could not read the file. Your draft is preserved."); }
    finally { pending.current = false; setBusy(false); }
  }
  async function evaluate() {
    if (pending.current) return;
    if (new Blob([draft.text]).size > 512_000) { setError("Use a dataset of at most 512 KB."); return; }
    let dataset: unknown;
    try { dataset = JSON.parse(draft.text) as unknown; } catch { setError("Enter valid JSON. Your draft is preserved."); return; }
    const requestId = draft.requestId ?? crypto.randomUUID(); saveDraft({ ...draft, requestId }); pending.current = true; setBusy(true);
    try { const result = await api<EvaluateRoutingResponse>("evaluateRouting", { body: { requestId, dataset } }); setRecord(result.evaluation); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { pending.current = false; setBusy(false); }
  }
  async function reopen(id: string) {
    if (pending.current) return; pending.current = true; setBusy(true); setError(undefined);
    try { setRecord((await api<EvaluateRoutingResponse>("routingEvaluation", { params: { id } })).evaluation); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section aria-label="Routing evaluation" className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
    {confirmationDialog}
    <h3 className="font-medium">Evaluate Jev routing</h3>
    <p className="text-sm text-neutral-400">Compare recorded Jev choices with static routing, including validation, repairs and classifier overhead. This evaluation is separate from Save Settings. No provider is called and live routing stays unchanged.</p>
    <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => replaceDraft(JSON.stringify(routingEvaluationExample(), null, 2))}>Load synthetic example</button>
      <label className={`${button} inline-flex cursor-pointer items-center focus-within:outline-2 focus-within:outline-blue-400`}>Import dataset<input aria-label="Import routing dataset" type="file" accept=".json,application/json" disabled={busy} className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; void importFile(file); }} /></label>
      <button className={button} disabled={!draft.text.trim()} onClick={() => downloadText(draft.text, "routing-dataset.json")}>Download input</button>
    </div>
    <label className="block space-y-2 text-sm"><span>Recorded dataset JSON</span><textarea aria-label="Recorded routing dataset" value={draft.text} disabled={busy} onChange={(e) => saveDraft({ text: e.target.value })} rows={8} maxLength={512_000} spellCheck={false} className="w-full min-w-0 rounded border border-neutral-700 bg-neutral-950 p-3 font-mono text-xs focus-visible:outline-2 focus-visible:outline-blue-400" /></label>
    <p className="text-xs text-neutral-400">Start with the example format. Use held-out tasks and independently reviewed outcomes for both allocations; null means unknown. Imported evidence is operator-supplied, not independently verified by this tool. Drafts are retained in this browser tab.</p>
    {storageError && <p role="alert" className="text-sm text-amber-300">{storageError}</p>}
    {error && <p role="alert" className="break-words text-sm text-red-400">{error}</p>}
    <div className="flex flex-wrap items-center gap-3"><button className={button} disabled={busy || !draft.text.trim()} onClick={() => void evaluate()}>{busy ? "Working…" : "Evaluate and save report"}</button><span className="text-xs text-neutral-400">Automatic Jev routing: off · measured pilot approval required</span></div>
    {record && <div className="space-y-3 border-t border-neutral-800 pt-4" aria-label="Evaluation report">
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">{statusLabel(record.report.status)}</h4><button className={button} onClick={() => download(record, `routing-evaluation-${record.id}.json`)}>Download report</button></div>
      <p className="break-words text-sm">{record.dataset.name} · {record.dataset.provenance === "synthetic" ? "Synthetic data — not a measured benefit" : "Imported observations"}</p>
      <p className="text-xs text-neutral-400">{record.report.comparedCases}/{record.report.heldOutCases} matched held-out cases · Saved {new Date(record.createdAt).toLocaleString()}</p>
      <p className="break-words text-xs text-neutral-400">Recorded classifier: {record.report.classifierModels.join(", ") || "unknown"}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-300">{record.report.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{(["static", "proposed"] as const).map((kind) => { const total = record.report[kind]; return <div className="space-y-2 rounded border border-neutral-700 p-3" key={kind}><h5 className="font-medium">{kind === "static" ? "Static allocation" : "Jev with static fallback"}</h5><p className="text-xl tabular-nums">{money(total.costUsd)}</p><p className="text-xs text-neutral-400">Matched cases only · includes {money(total.repairCostUsd)} repair cost{kind === "proposed" ? " and classifier overhead" : ""}</p><dl className="grid grid-cols-2 gap-2 text-sm"><div><dt className="text-neutral-400">Unacceptable</dt><dd>{total.unacceptable}</dd></div><div><dt className="text-neutral-400">Calls / attempts</dt><dd>{total.calls}</dd></div><div><dt className="text-neutral-400">Tokens</dt><dd>{total.tokens.toLocaleString()}</dd></div><div><dt className="text-neutral-400">Total time</dt><dd>{Math.round(total.durationMs / 1000)}s</dd></div></dl></div>; })}</div>
      <p className="text-xs text-neutral-400">All held-out classifier cost reported: {money(record.report.classifierCostUsd)} · {record.report.unknownClassifierCosts} unknown. Subscription dollars do not measure remaining quota.</p>
      <details><summary className="min-h-10 cursor-pointer py-2 text-sm focus-visible:outline-2">Allocation and fallback details</summary><div className="space-y-2 text-sm">{record.report.assignments.map((item) => <p className="break-words" key={item.model}>{item.model}: {item.static} static → {item.proposed} proposed assignments</p>)}{record.report.cases.map((item) => <p className="break-words text-xs text-neutral-400" key={item.id}>{item.id}: {item.staticModel} → {item.selectedModel} · {item.reason.replaceAll("_", " ")}{item.complete ? "" : " · incomplete evidence"}</p>)}</div></details>
    </div>}
    <div className="space-y-2 border-t border-neutral-800 pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">Saved evaluations</h4><button className={button} disabled={loading} onClick={() => void refresh()}>{loading ? "Loading reports…" : "Refresh reports"}</button></div>
      {historyError && <p role="alert" className="text-sm text-red-400">{historyError} Use Refresh reports to retry.</p>}
      {history?.evaluations.length === 0 && <p className="text-sm text-neutral-400">No saved evaluations. Run the synthetic example to inspect the comparison.</p>}
      {history?.evaluations.map((item) => <button key={item.id} disabled={busy} onClick={() => void reopen(item.id)} className={`${button} block w-full break-words text-left`}>{item.name || "Untitled evaluation"} · {item.provenance} · {statusLabel(item.status)}</button>)}
    </div>
  </section>;
}
