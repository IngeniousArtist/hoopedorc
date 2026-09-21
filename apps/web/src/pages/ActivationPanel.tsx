import { useEffect, useRef, useState } from "react";
import type { ActivationPolicy, ActivationResponse, LibraryEntry, SaveActivationRequest, SaveActivationResponse } from "@orc/types";
import { api, isAbortError } from "../api/client";

const control = "min-h-10 rounded border border-neutral-700 bg-neutral-900 px-3 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50";
const field = `${control} w-full`;
export function ActivationPanel({ projectId, entries, onHandoff }: { projectId: string; entries: LibraryEntry[]; onHandoff: (markdown: string) => void }) {
  const key = `hoop.activation.draft.${projectId}`;
  const [data, setData] = useState<ActivationResponse | null>(null);
  const [draft, setDraft] = useState<SaveActivationRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [discard, setDiscard] = useState(false);
  const acting = useRef(false); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setError(null);
    void api<ActivationResponse>("projectActivation", { params: { id: projectId }, signal: controller.signal }).then((value) => {
      if (controller.signal.aborted) return;
      setData(value);
      setDraft((current) => {
        if (current) return current;
        try {
          const text = sessionStorage.getItem(key);
          if (text) { const stored = JSON.parse(text) as SaveActivationRequest; if (stored.policy && Array.isArray(stored.policy.mcps) && Array.isArray(stored.policy.skills) && Number.isInteger(stored.expectedRevision) && typeof stored.requestId === "string") return stored; }
        } catch { setStorageError("The saved activation draft could not be restored. New edits remain on this screen."); }
        return { requestId: crypto.randomUUID(), expectedRevision: value.current.revision, policy: value.current.policy };
      });
    }).catch((reason: unknown) => { if (!isAbortError(reason) && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Activation settings are unavailable."); });
    return () => controller.abort();
  }, [projectId, key, refresh]);
  function edit(policy: ActivationPolicy) {
    if (!draft || acting.current) return;
    const next = { ...draft, requestId: crypto.randomUUID(), policy }; setDraft(next); setSaved(false);
    try { sessionStorage.setItem(key, JSON.stringify(next)); setStorageError(null); } catch { setStorageError("This browser cannot preserve the draft across navigation. Keep this screen open until saved."); }
  }
  async function save() {
    if (!draft || acting.current) return;
    acting.current = true; setBusy(true); setError(null); setSaved(false);
    try {
      const response = await api<SaveActivationResponse>("saveProjectActivation", { params: { id: projectId }, body: draft });
      if (!alive.current) return;
      setDraft({ requestId: crypto.randomUUID(), expectedRevision: response.revision.revision, policy: response.revision.policy });
      try { sessionStorage.removeItem(key); } catch { setStorageError("Saved, but this browser could not remove its local draft."); }
      setSaved(true); setRefresh((value) => value + 1);
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "Could not save activation. Your draft is preserved."); }
    finally { acting.current = false; if (alive.current) setBusy(false); }
  }
  const policy = draft?.policy;
  return <section aria-label="Agent capabilities" className="min-w-0 space-y-4 rounded-lg border border-neutral-700 p-4">
    <div><h2 className="font-semibold">Agent capabilities</h2><p className="mt-1 text-sm text-neutral-400">Choose what a call loads. Saving creates a new project default; running calls keep their resolved revision.</p></div>
    {error && <div role="alert" className="space-y-2 text-sm text-red-300"><p>{error}</p><button className={control} disabled={busy} onClick={() => setRefresh((value) => value + 1)}>Reload activation</button></div>}
    {storageError && <p role="alert" className="text-sm text-amber-300">{storageError}</p>}
    {!data || !policy ? <p role="status" className="text-sm text-neutral-400">{error ? "Activation is unavailable. Existing settings are preserved." : "Loading activation…"}</p> : <>
      <label className="block space-y-1 text-sm">Configuration mode<select className={field} value={policy.mode} disabled={busy} onChange={(event) => edit({ ...policy, mode: event.target.value as ActivationPolicy["mode"] })}><option value="inherit">Use the harness's existing configuration</option><option value="selected">Load selected capabilities</option></select></label>
      <p className="text-sm text-neutral-400">{policy.mode === "inherit" ? "Existing CLI skills, plugins and MCPs may load. The selections below are stored but do not restrict inherited configuration." : "Selective mode requires Claude Code 2.1.278. Codex and OpenCode calls will be blocked. Repository CLAUDE.md and managed policy still apply; this setting does not isolate the filesystem."}</p>
      <fieldset disabled={busy || policy.mode !== "selected"} className="space-y-2"><legend className="mb-2 text-sm font-medium">Skill instructions</legend>
        <p className="text-xs text-neutral-400">Explicit Library snapshots are appended to calls. Native skill catalogs stay disabled.</p>
        {entries.filter((entry) => entry.kind === "skill" && !entry.archived).map((entry) => {
          const selected = policy.skills.find((skill) => skill.id === entry.id);
          return <label key={entry.id} className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={!!selected} onChange={(event) => edit({ ...policy, skills: event.target.checked ? [...policy.skills, { id: entry.id, revision: entry.revision }] : policy.skills.filter((skill) => skill.id !== entry.id) })} />{entry.title} · revision {selected?.revision ?? entry.revision}</label>;
        })}
        {!entries.some((entry) => entry.kind === "skill" && !entry.archived) && <p className="text-sm text-neutral-400">Create a Library reference with kind Skill to select its instructions here.</p>}
        {policy.skills.filter((skill) => !entries.some((entry) => entry.id === skill.id && !entry.archived)).map((skill) => <div key={skill.id} className="flex flex-wrap items-center gap-2 text-sm"><span>{skill.id}@{skill.revision} · archived or unavailable</span><button className={control} onClick={() => edit({ ...policy, skills: policy.skills.filter((item) => item.id !== skill.id) })}>Remove selection</button></div>)}
      </fieldset>
      <fieldset disabled={busy} className="min-w-0 space-y-3"><legend className="mb-2 text-sm font-medium">MCP registrations</legend>
        <p className="text-xs text-neutral-400">Registration does not install or connect. Enabled entries launch at invocation time in selective mode. Use installed commands or HTTP URLs; keep credentials in the owning CLI, never in arguments or URLs.</p>
        {policy.mcps.length === 0 && <p className="text-sm text-neutral-400">No MCPs registered. Selective mode excludes inherited MCP connections.</p>}
        {policy.mcps.map((mcp, index) => {
          const update = (value: typeof mcp) => edit({ ...policy, mcps: policy.mcps.map((entry, i) => i === index ? value : entry) });
          return <div key={index} className="min-w-0 space-y-2 rounded border border-neutral-800 p-3">
            <label className="block text-sm">MCP name<input aria-label={`MCP ${index + 1} name`} className={field} value={mcp.id} onChange={(event) => update({ ...mcp, id: event.target.value })} /></label>
            <div className="flex flex-wrap items-center gap-3"><label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={mcp.enabled} onChange={(event) => update({ ...mcp, enabled: event.target.checked })} />Activate in selective mode</label><select aria-label={`MCP ${index + 1} transport`} className={control} value={mcp.transport.type} onChange={(event) => update({ ...mcp, transport: event.target.value === "stdio" ? { type: "stdio", command: "", args: [] } : { type: "http", url: "" } })}><option value="stdio">Installed command</option><option value="http">HTTP server</option></select><button className={control} onClick={() => edit({ ...policy, mcps: policy.mcps.filter((_, i) => i !== index) })}>Remove MCP {index + 1}</button></div>
            {mcp.transport.type === "stdio" ? <><label className="block text-sm">Absolute command path<input className={field} value={mcp.transport.command} onChange={(event) => update({ ...mcp, transport: { type: "stdio", command: event.target.value, args: mcp.transport.type === "stdio" ? mcp.transport.args : [] } })} placeholder="/usr/local/bin/my-mcp" /></label><label className="block text-sm">Arguments · one literal argument per line<textarea className={`${field} min-h-20 py-2`} value={mcp.transport.args.join("\n")} onChange={(event) => update({ ...mcp, transport: { type: "stdio", command: mcp.transport.type === "stdio" ? mcp.transport.command : "", args: event.target.value ? event.target.value.split("\n") : [] } })} /></label></> : <label className="block text-sm">MCP URL<input className={field} value={mcp.transport.url} onChange={(event) => update({ ...mcp, transport: { type: "http", url: event.target.value } })} placeholder="https://example.com/mcp" /></label>}
          </div>;
        })}
        <button className={control} disabled={policy.mcps.length >= 12} onClick={() => edit({ ...policy, mcps: [...policy.mcps, { id: `connection-${policy.mcps.length + 1}`, enabled: false, transport: { type: "http", url: "" } }] })}>Register MCP</button>
      </fieldset>
      <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" disabled={busy || policy.mode !== "selected"} checked={policy.browser} onChange={(event) => edit({ ...policy, browser: event.target.checked })} />Task browser · Playwright checks and review artifacts</label>
      <p className="text-xs text-neutral-400">Requires a saved preview profile and Chromium. Granted only to author and reviewer workspaces, separately from the operator's Review controls.</p>
      <div className="rounded border border-neutral-800 p-3 text-sm"><p className="font-medium">Native plugins · unavailable in selective mode</p><p className="mt-1 text-neutral-400">{data.nativePlugins.reason}</p></div>
      <div className="flex flex-wrap gap-2"><button className={control} disabled={busy} onClick={() => void save()}>{busy ? "Saving activation…" : "Save activation"}</button><button className={control} disabled={busy} onClick={() => setDiscard(true)}>Discard draft</button></div>
      {discard && <div role="group" aria-label="Discard activation draft" className="space-y-2 text-sm"><p>Discard these edits and reload the saved project default?</p><div className="flex flex-wrap gap-2"><button className={control} onClick={() => { try { sessionStorage.removeItem(key); } catch { setStorageError("The local draft could not be removed."); } setDraft({ requestId: crypto.randomUUID(), expectedRevision: data.current.revision, policy: data.current.policy }); setDiscard(false); setSaved(false); }}>Discard edits</button><button className={control} onClick={() => setDiscard(false)}>Keep editing</button></div></div>}
      {saved && <p role="status" className="text-sm text-green-300">Activation saved. Installation and authentication were not changed.</p>}
      <details className="text-sm"><summary className="min-h-10 cursor-pointer py-2 focus-visible:ring-2">Saved revisions and invocation history</summary><div className="mt-2 space-y-3">
        {data.revisions.map((revision) => <div key={revision.revision} className="flex flex-wrap items-center gap-2"><span>Revision {revision.revision} · {revision.policy.mode}</span><button className={control} onClick={() => onHandoff(`Use hoop-activation:${revision.revision} in the description of each applicable task. Preserve this exact marker; it selects a saved project activation policy. Do not infer tool activation from a reference.`)}>Use revision {revision.revision} in Plan</button></div>)}
        {!data.manifests.length && <p className="text-neutral-400">No invocation manifests yet. Saving does not run a model.</p>}
        {data.manifests.map((manifest) => <article key={manifest.id} className="space-y-1 break-words rounded border border-neutral-800 p-3"><p>{manifest.stage} · {manifest.runner} · revision {manifest.revision} · {manifest.state}</p><p className="text-xs text-neutral-500">{manifest.taskId ?? "Project planning"} · {manifest.createdAt}{manifest.cliVersion && ` · CLI ${manifest.cliVersion}`}</p><p className="text-neutral-400">{manifest.detail}</p>{manifest.skills.length > 0 && <p>Skills: {manifest.skills.map((skill) => `${skill.id}@${skill.revision}`).join(", ")}</p>}{manifest.servers.map((server) => <p key={server.id}>{server.id}: {server.tools.map((tool) => tool.name).join(", ") || "No tools"}</p>)}</article>)}
      </div></details>
    </>}
  </section>;
}
