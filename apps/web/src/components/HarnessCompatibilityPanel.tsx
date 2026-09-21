import { useEffect, useRef, useState } from "react";
import type { HarnessCompatibilityResponse } from "@orc/types";
import { api } from "../api/client";

export function HarnessCompatibilityPanel() {
  const [data, setData] = useState<HarnessCompatibilityResponse>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const pending = useRef(false);
  async function refresh() {
    if (pending.current) return;
    pending.current = true; setLoading(true); setError(undefined);
    try { setData(await api<HarnessCompatibilityResponse>("harnessCompatibility")); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { pending.current = false; setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  return <section aria-label="Harness compatibility" className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-medium">Harness compatibility</h2><button disabled={loading} onClick={() => void refresh()} className="min-h-10 rounded border border-neutral-700 px-3 text-sm focus-visible:outline focus-visible:outline-2 disabled:opacity-50">{loading ? "Checking versions…" : "Refresh versions"}</button></div>
    <p className="text-sm text-neutral-400">Checks run on the server, without model calls. A detected version does not prove provider access. Test a configured model explicitly in Models; that test can use your quota.</p>
    {error && <p role="alert" className="break-words text-sm text-red-400">{error} Use Refresh versions to retry.</p>}
    {loading && !data && <p role="status" className="text-sm">Reading installed versions…</p>}
    {data && !data.harnesses.length && <p>No compatibility information is available. Refresh to try again.</p>}
    <div className="grid gap-3 lg:grid-cols-2">{data?.harnesses.map((entry) => <article key={entry.runner} className="min-w-0 space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <h3 className="font-medium">{entry.label}</h3>
      <p className="text-sm">{entry.probe === "mock" ? "Demo · not probed" : entry.installedVersion ? `Installed ${entry.installedVersion}` : "Unavailable"}<span className="block text-neutral-400">Inspected version {entry.verifiedVersion}</span></p>
      <dl className="grid grid-cols-2 gap-2 text-sm">{[["Native execution", entry.native ? "Available" : "Not verified"], ["Selected skills / MCPs", entry.selective ? "Version supported" : "Not verified"], ["Isolated execution", entry.isolated ? "Worker check required" : "Not verified"], ["Selected plugin bundles", "Not verified"], ["Provider access", "Model test required"]].map(([label, value]) => <div key={label}><dt className="text-neutral-400">{label}</dt><dd>{value}</dd></div>)}</dl>
      <p className="break-words text-xs leading-relaxed text-neutral-400">{entry.detail}</p>
    </article>)}</div>
  </section>;
}
