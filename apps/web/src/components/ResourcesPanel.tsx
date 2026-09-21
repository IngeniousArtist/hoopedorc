import type { AccountPool, RecoverResourceRequest, ResourcesResponse, Settings } from "@orc/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";

const input = "min-h-10 w-full min-w-0 rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-blue-400";
const button = "min-h-10 rounded border border-neutral-700 px-3 py-2 text-sm hover:bg-neutral-800 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-blue-400";

export function ResourcesPanel({ settings, active, onChange }: { settings: Settings; active: boolean; onChange: (patch: Pick<Settings, "models" | "accountPools">) => void }) {
  const [status, setStatus] = useState<ResourcesResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirm, setConfirm] = useState<{ kind: "remove" | "recover"; id: string }>();
  const [busy, setBusy] = useState(false);
  const recovery = useRef<{ id: string; request: RecoverResourceRequest }>();
  const refreshing = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true; setLoading(true);
    try { setStatus(await api<ResourcesResponse>("resources")); setError(undefined); }
    catch (e) { setError(e instanceof Error ? e.message : "Resource status is unavailable. Try again."); }
    finally { setLoading(false); refreshing.current = false; }
  }, []);
  useEffect(() => {
    if (!active) return;
    void refresh(); const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [active, refresh]);
  const pools = settings.accountPools ?? [];
  function patch(id: string, change: Partial<AccountPool>) { onChange({ models: settings.models, accountPools: pools.map((pool) => pool.id === id ? { ...pool, ...change } : pool) }); }
  function quota(id: string, key: "windowHours" | "maxCalls" | "maxCostUsd", value: string) {
    const pool = pools.find((item) => item.id === id)!;
    const next = { windowHours: 24, ...pool.quota, [key]: value ? Number(value) : undefined };
    patch(id, { quota: next.maxCalls === undefined && next.maxCostUsd === undefined ? undefined : { ...next, windowHours: next.windowHours ?? 24 } });
  }
  async function recover() {
    const pending = recovery.current; if (!pending || busy) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      await api("recoverResource", { params: { reservationId: pending.id }, body: pending.request });
      setConfirm(undefined); recovery.current = undefined; setNotice("Worker capacity released. Interrupted usage remains in history."); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Recovery failed. Refresh and try again."); }
    finally { setBusy(false); }
  }
  return <section className="space-y-5" aria-label="Shared account resources">
    <div className="space-y-2"><h3 className="font-medium">Share capacity across model profiles</h3>
      <p className="text-sm text-neutral-400">Group profiles that use the same authenticated account. Pools control calls made by this app; they do not sign in or switch accounts. Provider allowance and usage outside Hoopedorc are unknown.</p>
      <p className="text-xs text-neutral-500">Save settings to apply your edits. Usage below reflects saved settings and refreshes every 10 seconds.</p></div>
    <div className="flex flex-wrap items-center gap-3"><button className={button} disabled={loading} onClick={() => void refresh()} aria-busy={loading}>{loading ? "Refreshing…" : "Refresh usage"}</button>
      <button className={button} onClick={() => onChange({ models: settings.models, accountPools: [...pools, { id: `account-${crypto.randomUUID()}`, name: "New account", billing: "subscription", maxConcurrent: 2, reviewSlots: 1 }] })}>Add account pool</button></div>
    {error && <p role="alert" className="break-words rounded border border-red-900 p-3 text-sm text-red-300">{error} Your settings edits are preserved.</p>}
    {notice && <p role="status" className="text-sm text-green-300">{notice}</p>}
    {!status && loading && <p role="status" className="text-sm text-neutral-400">Loading account usage…</p>}
    {pools.length === 0 && <p className="rounded border border-neutral-800 p-4 text-sm text-neutral-400">No shared pools yet. Profiles keep their individual limits until you assign them to an account.</p>}
    {pools.map((pool, index) => {
      const usage = status?.pools.find((item) => item.pool.id === pool.id);
      const occupied = usage ? usage.active + usage.reserved + usage.unresolved : 0;
      const prefix = `Account ${index + 1}`;
      return <fieldset key={pool.id} className="min-w-0 space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <legend className="px-1 text-sm font-medium">{prefix}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-neutral-400">Name<input className={input} aria-label={`${prefix} name`} maxLength={160} value={pool.name} onChange={(e) => patch(pool.id, { name: e.target.value })} /></label>
          <label className="space-y-1 text-xs text-neutral-400">Billing<select className={input} aria-label={`${prefix} billing`} value={pool.billing} onChange={(e) => patch(pool.id, { billing: e.target.value as AccountPool["billing"], quota: e.target.value === "subscription" ? pool.quota?.maxCalls ? { windowHours: pool.quota.windowHours, maxCalls: pool.quota.maxCalls } : undefined : pool.quota })}><option value="subscription">Subscription · $0 incremental cost</option><option value="metered">Metered usage</option></select></label>
          <label className="space-y-1 text-xs text-neutral-400">Concurrent calls<input className={input} aria-label={`${prefix} concurrent calls`} type="number" min={1} max={100} value={pool.maxConcurrent} onChange={(e) => patch(pool.id, { maxConcurrent: Number(e.target.value) })} /></label>
          <label className="space-y-1 text-xs text-neutral-400">Slots reserved for reviews<input className={input} aria-label={`${prefix} review slots`} type="number" min={0} max={pool.maxConcurrent - 1} value={pool.reviewSlots} onChange={(e) => patch(pool.id, { reviewSlots: Number(e.target.value) })} /></label>
          <label className="space-y-1 text-xs text-neutral-400">Rolling call limit (optional)<input className={input} aria-label={`${prefix} call limit`} type="number" min={1} value={pool.quota?.maxCalls ?? ""} onChange={(e) => quota(pool.id, "maxCalls", e.target.value)} /></label>
          <label className="space-y-1 text-xs text-neutral-400">Window in hours<input className={input} aria-label={`${prefix} window hours`} type="number" min={0.01} step="any" disabled={!pool.quota} value={pool.quota?.windowHours ?? 24} onChange={(e) => quota(pool.id, "windowHours", e.target.value)} /></label>
          {pool.billing === "metered" && <label className="space-y-1 text-xs text-neutral-400">Observed cost limit in USD (optional)<input className={input} aria-label={`${prefix} cost limit`} type="number" min={0.01} step="any" value={pool.quota?.maxCostUsd ?? ""} onChange={(e) => quota(pool.id, "maxCostUsd", e.target.value)} /></label>}
        </div>
        <p className="text-xs text-neutral-400">Review slots stay available to validators. Other calls wait for worker capacity. Limits block new calls; already running calls may exceed an observed cost limit.</p>
        {usage ? <div className="space-y-1 rounded bg-neutral-950 p-3 text-sm" aria-label={`${prefix} saved usage`}>
          <p>{usage.active} active · {usage.reserved} reserved · {usage.unresolved} unresolved · {usage.authorSlotsAvailable} worker slots free</p>
          <p className="text-neutral-400">{usage.observedCalls} calls including reservations · ${usage.meteredCostUsd.toFixed(2)} incremental cost · {usage.tokens.toLocaleString()} tokens in {usage.windowHours}h</p>
          {usage.unknownSpendCalls > 0 && <p className="text-amber-300">{usage.unknownSpendCalls} interrupted calls have incomplete usage.</p>}
          {usage.reason && <p className="break-words text-amber-300">{usage.reason}</p>}
        </div> : <p className="text-xs text-neutral-500">{status ? "No saved usage for this pool yet." : "Usage is unavailable until status loads."}</p>}
        <button className={button} disabled={occupied > 0} onClick={() => setConfirm({ kind: "remove", id: pool.id })}>Remove account pool</button>
        {occupied > 0 && <p className="text-xs text-neutral-400">Finish or resolve active reservations before removing this pool.</p>}
        {confirm?.kind === "remove" && confirm.id === pool.id && <div role="group" aria-label="Confirm pool removal" className="space-y-2 rounded border border-amber-800 p-3"><p className="text-sm">Remove this pool and unassign its profiles? This takes effect when you save.</p><div className="flex flex-wrap gap-2"><button className={button} onClick={() => { onChange({ accountPools: pools.filter((item) => item.id !== pool.id), models: settings.models.map((model) => model.accountPoolId === pool.id ? { ...model, accountPoolId: undefined } : model) }); setConfirm(undefined); }}>Remove pool from draft</button><button className={button} onClick={() => setConfirm(undefined)}>Cancel</button></div></div>}
      </fieldset>;
    })}
    <section className="space-y-3"><h3 className="font-medium">Profile membership</h3><p className="text-xs text-neutral-400">Existing per-model limits still apply. Assign each profile to the account used by its CLI login.</p>
      {settings.models.map((model) => <label key={model.id} className="grid items-center gap-2 text-sm sm:grid-cols-2"><span className="break-words">{model.displayName}</span><select className={input} aria-label={`${model.displayName} account pool`} value={model.accountPoolId ?? ""} onChange={(e) => onChange({ accountPools: pools, models: settings.models.map((item) => item.id === model.id ? { ...item, accountPoolId: e.target.value || undefined } : item) })}><option value="">Individual limits only</option>{pools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name || "Unnamed account"}</option>)}</select></label>)}
    </section>
    {!!status?.unresolved.length && <section className="space-y-3"><h3 className="font-medium">Workers needing attention</h3><p className="text-sm text-neutral-400">A restart interrupted these calls. Stop or verify the old worker on its host before releasing capacity. This action does not terminate a process.</p>
      {status.unresolved.map((item) => <div key={item.id} className="space-y-2 rounded border border-amber-900 p-3"><p className="break-words text-sm">{item.model} · {item.stage} · {item.taskId ?? item.projectId ?? "Model health"}</p><p className="break-all text-xs text-neutral-500">{item.id}</p>
        {confirm?.kind === "recover" && confirm.id === item.id ? <div role="group" aria-label="Confirm stopped worker" className="space-y-2"><p className="text-sm">Confirm that this worker has stopped. Releasing a live worker could exceed the account limit.</p><div className="flex flex-wrap gap-2"><button className={button} disabled={busy} aria-busy={busy} onClick={() => void recover()}>{busy ? "Releasing…" : "Worker is stopped · release slot"}</button><button className={button} disabled={busy} onClick={() => { setConfirm(undefined); recovery.current = undefined; }}>Cancel</button></div></div> : <button className={button} disabled={busy} onClick={() => { recovery.current = { id: item.id, request: { requestId: crypto.randomUUID(), expectedUpdatedAt: item.updatedAt, confirmWorkerStopped: true } }; setConfirm({ kind: "recover", id: item.id }); }}>Resolve worker</button>}
      </div>)}
    </section>}
  </section>;
}
