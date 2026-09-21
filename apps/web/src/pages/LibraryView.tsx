import { useEffect, useRef, useState } from "react";
import type { ImportLibraryResponse, LibraryDetailResponse, LibraryHandoffResponse, LibraryReference, LibraryResponse, LibrarySelection, ReferenceInput, ReferenceKind, SaveLibraryReferenceResponse } from "@orc/types";
import { api, isAbortError } from "../api/client";
import { ActivationPanel } from "./ActivationPanel";

const control = "min-h-10 rounded border border-neutral-700 bg-neutral-900 px-3 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50";
const panel = "min-w-0 space-y-3 rounded-lg border border-neutral-800 p-4";
const blank = (): ReferenceInput => ({ title: "", kind: "design", source: { type: "text", locator: "" }, applicability: "", conflictGroup: "", content: "", archived: false });
const inputOf = (value: LibraryReference): ReferenceInput => ({ title: value.title, kind: value.kind, source: value.source, applicability: value.applicability, conflictGroup: value.conflictGroup, content: value.content, archived: value.archived });
const explain = (error: unknown) => error instanceof Error ? error.message : "Library unavailable. Your draft is preserved.";
type EditorDraft = { id: string; revision: number; input: ReferenceInput };
function restoreDraft(projectId: string): EditorDraft | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(`hoop.library.draft.${projectId}`) ?? "null") as EditorDraft | null;
    if (!value || typeof value.id !== "string" || !Number.isInteger(value.revision) || !value.input || !value.input.source ||
      ![value.input.title, value.input.content, value.input.applicability, value.input.conflictGroup, value.input.kind, value.input.source.type, value.input.source.locator].every((part) => typeof part === "string")) return null;
    return value;
  } catch { return null; }
}

export function LibraryView({ projectId, onAddToPlan }: { projectId: string; onAddToPlan: (text: string) => void }) {
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState("");
  const [capabilities, setCapabilities] = useState(false);
  const [selected, setSelected] = useState<LibrarySelection[]>([]);
  const [detail, setDetail] = useState<LibraryDetailResponse | null>(null);
  const [editing, setEditing] = useState<EditorDraft | null>(() => restoreDraft(projectId));
  const [draftError, setDraftError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const [archive, setArchive] = useState(false);
  const [imported, setImported] = useState<ImportLibraryResponse | null>(null);
  const alive = useRef(true); const acting = useRef(false);
  const pendingSave = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    try {
      const key = `hoop.library.draft.${projectId}`;
      if (editing) sessionStorage.setItem(key, JSON.stringify(editing)); else sessionStorage.removeItem(key);
      setDraftError(null);
    } catch { setDraftError("This browser cannot retain your edit after leaving Library. Save it before navigating away."); }
  }, [editing, projectId]);
  useEffect(() => {
    const controller = new AbortController();
    api<LibraryResponse>("projectLibrary", { params: { id: projectId }, signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) { setData(value); setLoadError(null); } })
      .catch((err) => { if (!controller.signal.aborted && !isAbortError(err)) setLoadError(explain(err)); });
    return () => controller.abort();
  }, [projectId, refresh]);
  async function act(label: string, action: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true; setBusy(label); setError(null);
    try { await action(); }
    catch (err) { if (alive.current) setError(explain(err)); }
    finally { acting.current = false; if (alive.current) setBusy(null); }
  }
  const owner = { id: projectId };
  function select(value: LibrarySelection) {
    setSelected((old) => old.some((item) => item.id === value.id && item.revision === value.revision)
      ? old.filter((item) => item.id !== value.id || item.revision !== value.revision)
      : [...old, { id: value.id, revision: value.revision }]);
  }
  function edit(value?: LibraryReference) {
    setEditing(value ? { id: value.id, revision: value.revision, input: inputOf(value) } : { id: crypto.randomUUID(), revision: 0, input: blank() });
    setDiscard(false); setArchive(false); setError(null); pendingSave.current = null;
  }
  async function save() {
    if (!editing) return;
    const key = JSON.stringify(editing);
    if (pendingSave.current?.key !== key) pendingSave.current = { key, id: crypto.randomUUID() };
    const response = await api<SaveLibraryReferenceResponse>("saveLibraryReference", { params: { ...owner, referenceId: editing.id }, body: { requestId: pendingSave.current.id, expectedRevision: editing.revision, reference: editing.input } });
    if (!alive.current) return;
    setEditing(null); pendingSave.current = null; setDetail({ reference: response.reference, versions: [response.reference] }); setRefresh((value) => value + 1);
  }
  async function archiveReference() {
    if (!detail) return;
    const reference = detail.reference;
    const input = { ...inputOf(reference), archived: !reference.archived };
    const key = JSON.stringify({ id: reference.id, revision: reference.revision, input });
    if (pendingSave.current?.key !== key) pendingSave.current = { key, id: crypto.randomUUID() };
    const response = await api<SaveLibraryReferenceResponse>("saveLibraryReference", { params: { ...owner, referenceId: reference.id }, body: { requestId: pendingSave.current.id, expectedRevision: reference.revision, reference: input } });
    if (!alive.current) return;
    setDetail({ reference: response.reference, versions: [response.reference, ...detail.versions] }); setArchive(false); setRefresh((value) => value + 1); pendingSave.current = null;
  }
  const entries = data?.entries.filter((item) => `${item.title} ${item.kind} ${item.source.locator} ${item.applicability}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <section className="mx-auto max-w-7xl space-y-4" aria-label="Project library">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold">Library</h1><p className="mt-1 text-sm text-neutral-400">Keep the sources your project should follow. Select only what a plan needs.</p></div>
      <button className={control} disabled={!!busy || !!editing} onClick={() => edit()}>New reference</button></div>
    <p className="text-xs text-neutral-400">Task requirements → project rules → existing components and code → design system → defaults. References do not install or enable skills, plugins or MCPs.</p>
    <button className={control} aria-expanded={capabilities} onClick={() => setCapabilities((open) => !open)}>Agent capabilities</button>
    {capabilities && <ActivationPanel projectId={projectId} entries={data?.entries ?? []} onHandoff={onAddToPlan} />}
    <div className="flex flex-wrap gap-2"><button className={control} disabled={!!busy} onClick={() => void act("Importing existing sources…", async () => {
      const result = await api<ImportLibraryResponse>("importProjectLibrary", { params: owner, body: {} });
      if (alive.current) { setImported(result); setRefresh((value) => value + 1); }
    })}>{busy === "Importing existing sources…" ? busy : "Import existing sources"}</button>
      <button className={control} disabled={!!busy} onClick={() => setRefresh((value) => value + 1)}>Refresh library</button></div>
    <p className="text-xs text-neutral-400">Import indexes existing guidance, attachments, Figma references and task handoffs. Original files and tasks are preserved; URLs are not fetched.</p>
    {imported && <div role="status" className={panel}><p className="text-sm">Imported {imported.imported} revisions; {imported.unchanged} unchanged.</p>{imported.issues.map((issue, index) => <p key={index} className="break-words text-sm text-amber-300">{issue}</p>)}</div>}
    {loadError && <p role="alert" className="text-sm text-red-300">{loadError} Use Refresh library to retry.</p>}
    {error && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-red-300">{error}</p>}
    {draftError && <p role="alert" className="text-sm text-amber-300">{draftError}</p>}
    {!data && !loadError && <p role="status">Loading library…</p>}
    {busy && <p role="status" className="text-sm text-neutral-400">{busy}</p>}
    {editing && <section className={panel} aria-label="Reference editor"><h2 className="font-medium">{editing.revision ? `Edit reference · based on revision ${editing.revision}` : "New reference"}</h2>
      <fieldset disabled={!!busy} className="min-w-0"><ReferenceFields value={editing.input} onChange={(input) => setEditing({ ...editing, input })} /></fieldset>
      <div className="flex flex-wrap gap-2"><button className={control} disabled={!!busy || !editing.input.title.trim()} onClick={() => void act("Saving reference…", save)}>{busy === "Saving reference…" ? busy : "Save reference"}</button>
        <button className={control} disabled={!!busy} onClick={() => setDiscard(true)}>Cancel edit</button></div>
      {discard && <div role="group" aria-label="Discard reference edit" className="space-y-2 text-sm"><p>Discard this unsaved edit? Saved revisions are preserved.</p><button className={control} onClick={() => { setEditing(null); setDiscard(false); }}>Discard draft</button><button className={`${control} ml-2`} onClick={() => setDiscard(false)}>Keep editing</button></div>}
      <p className="text-xs text-neutral-400">Unsaved edits are kept in this browser session. A failed save preserves these fields. After a stale-save refusal, open the latest source below, copy your changes and start a new edit.</p>
    </section>}
    <div className="grid min-w-0 gap-4 lg:grid-cols-2"><section className="min-w-0 space-y-3" aria-label="Library sources">
      <label className="block space-y-1 text-sm">Find a source<input className={`${control} block w-full`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, type or source path" /></label>
      {data?.entries.length === 0 && <p className="text-sm text-neutral-400">No references yet. Add a design document, component link or rule, or import existing project sources.</p>}
      {!!data?.entries.length && entries.length === 0 && <p className="text-sm text-neutral-400">No sources match this search.</p>}
      {entries.map((entry) => <article key={entry.id} className={panel}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="min-w-0 break-words font-medium">{entry.title}</h2><span className="text-xs text-neutral-400">{entry.kind} · v{entry.revision}{entry.archived ? " · archived" : ""}</span></div>
        <p className="break-all text-xs text-neutral-400">{entry.source.locator || "Operator text"} · {entry.source.revision ?? "Source version unknown"}</p>
        <p className="break-words text-sm text-neutral-300">{entry.applicability || "No applicability recorded; choose deliberately."}</p>
        {!!entry.conflictsWith.length && <p className="text-sm text-amber-300">Alternative sources share “{entry.conflictGroup}”. Select one for a task; contradictions outside these groups need your review.</p>}
        <div className="flex flex-wrap gap-2"><label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" className="size-5 accent-blue-500" disabled={entry.archived || !!busy} checked={selected.some((item) => item.id === entry.id && item.revision === entry.revision)} onChange={() => select(entry)} />Select {entry.title}</label>
          <button className={control} disabled={!!busy} onClick={() => void act("Loading source…", async () => { const value = await api<LibraryDetailResponse>("libraryReference", { params: { ...owner, referenceId: entry.id } }); if (alive.current) { setDetail(value); setArchive(false); } })}>View {entry.title}</button></div>
        {!!entry.referencedByTasks.length && <details><summary className="flex min-h-10 cursor-pointer items-center text-xs focus-visible:ring-2 focus-visible:ring-blue-500">Referenced by {entry.referencedByTasks.length} tasks</summary><p className="text-xs text-neutral-400">A task marker proves selection, not that a model read or followed the source.</p>{entry.referencedByTasks.map((task) => <a className="flex min-h-10 items-center break-words text-sm text-blue-300 underline" key={task.id} href={`#/p/${projectId}/board/${encodeURIComponent(task.id)}`}>{task.title} · v{task.revisions.join(", ")}</a>)}</details>}
      </article>)}
    </section>
    <div className="min-w-0 space-y-4"><section className={panel} aria-label="Selected references"><h2 className="font-medium">Selected for planning ({selected.length})</h2>
      {!selected.length && <p className="text-sm text-neutral-400">Stored sources stay out of prompts until selected.</p>}
      {selected.map((item) => <div key={`${item.id}:${item.revision}`} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="min-w-0 break-all">{data?.entries.find((entry) => entry.id === item.id)?.title ?? item.id} · v{item.revision}</span><button className={control} disabled={!!busy} onClick={() => select(item)} aria-label={`Remove selection ${item.id} revision ${item.revision}`}>Remove</button></div>)}
      <button className={control} disabled={!!busy || !selected.length || selected.length > 20} onClick={() => void act("Preparing references…", async () => { const result = await api<LibraryHandoffResponse>("libraryHandoff", { params: owner, body: { references: selected } }); if (alive.current) onAddToPlan(result.markdown); })}>{busy === "Preparing references…" ? busy : "Add selected to plan"}</button>
      <p className="text-xs text-neutral-400">Adds pinned revisions to your unsent planning message. Nothing is sent automatically.</p>
    </section>
    {detail && <section className={panel} aria-label="Source details"><h2 className="break-words font-medium">{detail.reference.title} · v{detail.reference.revision}</h2>
      <p className="break-all text-xs text-neutral-400">{detail.reference.provenance} · {new Date(detail.reference.createdAt).toLocaleString()} · SHA-256 {detail.reference.contentSha}</p>
      {detail.reference.source.type === "url" && <a className="inline-flex min-h-10 items-center break-all text-sm text-blue-300 underline" href={detail.reference.source.locator} target="_blank" rel="noopener noreferrer">Open source link</a>}
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-950 p-3 text-xs" aria-label="Reference contents">{detail.reference.content || "No text snapshot; inspect the linked source."}</pre>
      <div className="flex flex-wrap gap-2"><button className={control} disabled={!!busy || !!editing} onClick={() => edit(detail.reference)}>Edit reference</button><button className={control} disabled={!!busy || !!editing} onClick={() => setArchive(true)}>{detail.reference.archived ? "Restore reference" : "Archive reference"}</button></div>
      {archive && <div role="group" aria-label="Confirm archive change" className="space-y-2 text-sm"><p>{detail.reference.archived ? "Restore this source for new selections?" : "Archive this source? Existing task snapshots and history remain available; new selections will be refused."}</p><button className={control} disabled={!!busy} onClick={() => void act("Saving archive state…", archiveReference)}>Confirm {detail.reference.archived ? "restore" : "archive"}</button><button className={`${control} ml-2`} disabled={!!busy} onClick={() => setArchive(false)}>Cancel</button></div>}
      <details><summary className="flex min-h-10 cursor-pointer items-center text-sm focus-visible:ring-2 focus-visible:ring-blue-500">Version history</summary>{detail.versions.map((version) => <div key={version.revision} className="space-y-2 border-t border-neutral-800 py-3"><p className="break-words text-xs">v{version.revision} · {new Date(version.createdAt).toLocaleString()} · {version.archived ? "archived" : "available"}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{version.content || "Source pointer only"}</pre><button className={control} disabled={!!busy || version.archived || detail.reference.archived} onClick={() => select(version)}>{selected.some((item) => item.id === version.id && item.revision === version.revision) ? "Remove" : "Select"} revision {version.revision}</button></div>)}</details>
    </section>}
    </div></div>
  </section>;
}

function ReferenceFields({ value, onChange }: { value: ReferenceInput; onChange: (value: ReferenceInput) => void }) {
  const field = (key: "title" | "applicability" | "conflictGroup", label: string, maxLength: number) => <label className="block space-y-1 text-sm">{label}<input className={`${control} block w-full`} maxLength={maxLength} value={value[key]} onChange={(event) => onChange({ ...value, [key]: event.target.value })} /></label>;
  return <div className="space-y-3">
    {field("title", "Reference title", 160)}
    <div className="grid gap-3 sm:grid-cols-2"><label className="block space-y-1 text-sm">Reference kind<select className={`${control} block w-full`} value={value.kind} onChange={(event) => onChange({ ...value, kind: event.target.value as ReferenceKind })}>{["rules", "design", "tokens", "component", "framework", "figma", "screenshot", "skill", "reference"].map((kind) => <option key={kind}>{kind}</option>)}</select></label>
      <label className="block space-y-1 text-sm">Source type<select className={`${control} block w-full`} value={value.source.type} onChange={(event) => onChange({ ...value, source: { ...value.source, type: event.target.value as ReferenceInput["source"]["type"] } })}>{["text", "url", "repository", "attachment", "legacy-task"].map((kind) => <option key={kind}>{kind}</option>)}</select></label></div>
    <label className="block space-y-1 text-sm">Source link or path<input className={`${control} block w-full`} maxLength={2000} value={value.source.locator} onChange={(event) => onChange({ ...value, source: { ...value.source, locator: event.target.value } })} /></label>
    <label className="block space-y-1 text-sm">Source version (optional)<input className={`${control} block w-full`} maxLength={200} value={value.source.revision ?? ""} onChange={(event) => onChange({ ...value, source: { ...value.source, revision: event.target.value || undefined } })} /></label>
    {field("applicability", "When should this apply?", 500)}{field("conflictGroup", "Alternative source group (optional)", 80)}
    <p className="text-xs text-neutral-400">Use the same group for mutually exclusive sources, such as two competing design systems. This does not detect every semantic contradiction.</p>
    <label className="block space-y-1 text-sm">Reference text<textarea rows={7} className={`${control} block w-full py-2 font-mono text-xs`} maxLength={32000} value={value.content} onChange={(event) => onChange({ ...value, content: event.target.value })} /></label>
    <p className="text-xs text-neutral-400">Stored as a reference snapshot, up to 32 KiB. A repository path or URL is not read or executed when you save this form.</p>
  </div>;
}
