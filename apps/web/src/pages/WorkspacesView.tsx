import type { ListWorkspacesResponse, WorkspaceSummary, WorkspaceFilesResponse, WorkspaceFileResponse, WorkspaceDiffResponse } from "@orc/types";
import { useEffect, useState } from "react";
import { api, isAbortError } from "../api/client";
import { WorkspacePreview } from "../components/WorkspacePreview";

const control = "min-h-10 rounded border border-neutral-700 bg-neutral-900 px-3 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50";
const message = (error: unknown) => error instanceof Error ? error.message : "Could not load workspace. Try again.";

export function WorkspacesView({ projectId, onAddToPlan }: { projectId: string; onAddToPlan: (text: string) => void }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState("primary");
  useEffect(() => {
    const controller = new AbortController();
    setWorkspaces(null); setError(null);
    api<ListWorkspacesResponse>("listWorkspaces", { params: { id: projectId }, signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setWorkspaces(value.workspaces); })
      .catch((err) => { if (!isAbortError(err) && !controller.signal.aborted) setError(message(err)); });
    return () => controller.abort();
  }, [projectId, refresh]);
  const workspace = workspaces?.find((item) => item.id === selected);
  return <section className="mx-auto max-w-7xl space-y-4" aria-label="Project workspaces">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-semibold">Workspaces</h1><p className="mt-1 text-sm text-neutral-400">Inspect the primary clone and each task’s work. Files are read-only.</p></div>
      <button className={control} onClick={() => setRefresh((value) => value + 1)}>Refresh workspaces</button>
    </div>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {!workspaces && !error && <p role="status">Loading workspaces…</p>}
    {workspaces?.length === 0 && <p>No workspaces are recorded yet.</p>}
    {!!workspaces?.length && <>
      <label className="block space-y-1 text-sm">Workspace
        <select className={`${control} block w-full max-w-xl`} value={selected} onChange={(event) => setSelected(event.target.value)}>
          {workspaces.map((item) => <option key={item.id} value={item.id}>{item.title}{item.state === "unavailable" ? " — unavailable" : ""}</option>)}
        </select>
      </label>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {workspaces.map((item) => <button key={item.id} onClick={() => setSelected(item.id)} aria-pressed={selected === item.id}
          className={`min-h-20 min-w-0 rounded-lg border p-3 text-left focus-visible:ring-2 focus-visible:ring-blue-500 ${selected === item.id ? "border-blue-500 bg-neutral-900" : "border-neutral-800"}`}>
          <span className="block break-words text-sm font-medium">{item.title}</span>
          <span className="mt-1 block break-all text-xs text-neutral-400">{item.branch ?? "Branch unavailable"} · {item.headSha?.slice(0, 7) ?? "No commit"}</span>
          <span className="mt-1 block text-xs text-neutral-400">{item.state === "available" ? `${item.dirty ? "Uncommitted changes" : "Working tree clean"} · ${item.changedFiles ?? 0} changed files` : "Workspace unavailable"}</span>
          {item.worker && <span className="mt-1 block break-words text-xs text-neutral-400">{item.worker} · {item.taskStatus}</span>}
        </button>)}
      </div>
      {workspace?.state === "unavailable" && <div role="status" className="rounded-lg border border-amber-800 p-4 text-sm text-amber-200">{workspace.reason} Nothing is cleaned up here.</div>}
      {workspace?.taskId && <a className="inline-flex min-h-10 items-center text-sm text-blue-400 underline" href={`#/p/${projectId}/board/${encodeURIComponent(workspace.taskId)}`}>View task and recovery</a>}
      {workspace?.taskId && <a className="ml-4 inline-flex min-h-10 items-center text-sm text-blue-400 underline" href={`#/p/${projectId}/review/${encodeURIComponent(workspace.taskId)}`}>Open full review</a>}
      {workspace && <WorkspacePreview key={`${projectId}:${workspace.id}`} projectId={projectId} workspaceId={workspace.id} />}
      {workspace?.state === "available" && <WorkspaceFiles key={`${projectId}:${workspace.id}:${refresh}`} projectId={projectId} workspace={workspace} onAddToPlan={onAddToPlan} />}
    </>}
  </section>;
}

export function WorkspaceFiles({ projectId, workspace, onAddToPlan }: { projectId: string; workspace: WorkspaceSummary; onAddToPlan: (text: string) => void }) {
  const [inventory, setInventory] = useState<WorkspaceFilesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<"file" | "diff">("file");
  const [file, setFile] = useState<WorkspaceFileResponse | null>(null);
  const [diff, setDiff] = useState<WorkspaceDiffResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [start, setStart] = useState(1);
  const [end, setEnd] = useState(1);
  useEffect(() => {
    const controller = new AbortController();
    api<WorkspaceFilesResponse>("workspaceFiles", { params: { id: projectId, workspaceId: workspace.id }, signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setInventory(value); })
      .catch((err) => { if (!isAbortError(err) && !controller.signal.aborted) setError(message(err)); });
    return () => controller.abort();
  }, [projectId, workspace.id]);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setFile(null); setDiff(null); setError(null); setBusy(true); setStart(1); setEnd(1);
    const request = { params: { id: projectId, workspaceId: workspace.id }, query: { path }, signal: controller.signal };
    const promise = mode === "file" ? api<WorkspaceFileResponse>("workspaceFile", request).then((value) => {
      if (!controller.signal.aborted) setFile(value);
    }) : api<WorkspaceDiffResponse>("workspaceDiff", request).then((value) => { if (!controller.signal.aborted) setDiff(value); });
    promise.catch((err) => { if (!isAbortError(err) && !controller.signal.aborted) setError(message(err)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [projectId, workspace.id, path, mode]);
  const lines = file?.content.split("\n") ?? [];
  const selection = lines.slice(start - 1, end).join("\n");
  const validSelection = !!file && Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && end <= lines.length && end - start < 200 && selection.length <= 16_000;
  const files = inventory?.files.filter((entry) => entry.path.toLowerCase().includes(query.toLowerCase()));
  return <div className="grid min-w-0 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
    <aside className="min-w-0 space-y-2 rounded-lg border border-neutral-800 p-3">
      <label className="block text-sm">Find file<input value={query} onChange={(event) => setQuery(event.target.value)} className={`${control} mt-1 w-full`} placeholder="Filter paths…" /></label>
      {!inventory && !error && <p role="status" className="text-sm">Loading files…</p>}
      {inventory?.truncated && <p className="text-xs text-amber-300">Showing the first 5,000 files.</p>}
      {files?.length === 0 && <p className="text-sm text-neutral-400">No matching files.</p>}
      <div className="max-h-72 overflow-y-auto lg:max-h-[32rem]">{files?.map((entry) => <button key={entry.path} aria-pressed={path === entry.path} onClick={() => setPath(entry.path)}
        className={`block min-h-10 w-full break-all rounded px-2 py-2 text-left font-mono text-xs focus-visible:ring-2 focus-visible:ring-blue-500 ${path === entry.path ? "bg-neutral-800" : "hover:bg-neutral-900"}`}>
        {entry.changed && <span aria-label="Changed" className="mr-2 text-amber-300">●</span>}{entry.path}{entry.untracked ? " (new)" : ""}
      </button>)}</div>
    </aside>
    <div className="min-w-0 space-y-3 rounded-lg border border-neutral-800 p-3">
      {!path && <p className="text-sm text-neutral-400">Choose a file to read its code or changes.</p>}
      {path && <><h2 className="break-all font-mono text-sm">{path}</h2><div className="flex gap-2">
        <button className={control} aria-pressed={mode === "file"} onClick={() => setMode("file")}>Code</button>
        <button className={control} aria-pressed={mode === "diff"} onClick={() => setMode("diff")}>Changes</button>
      </div></>}
      {busy && <p role="status" className="text-sm">Loading {mode === "file" ? "code" : "changes"}…</p>}
      {error && <p role="alert" className="text-sm text-red-300">{error} Use Refresh workspaces to retry.</p>}
      {(file || diff) && <p className="break-words text-xs text-neutral-400">Working copy observed {new Date((file ?? diff)!.observedAt).toLocaleTimeString()} · HEAD {(file ?? diff)!.workspace.headSha?.slice(0, 7) ?? "unborn"}{diff && ` · base ${diff.workspace.baseSha?.slice(0, 7) ?? "unavailable"}`}. Files may change while agents work.</p>}
      {file && <>
        <pre aria-label="File contents" tabIndex={0} className="max-h-[32rem] overflow-auto rounded bg-neutral-950 p-3 font-mono text-xs leading-6 focus-visible:ring-2 focus-visible:ring-blue-500">{lines.map((line, index) => <span key={index} className="block"><span className="mr-4 inline-block w-8 select-none text-right text-neutral-500">{index + 1}</span>{line || " "}</span>)}</pre>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">From line<input type="number" min={1} max={lines.length} value={start} onChange={(event) => setStart(Number(event.target.value))} className={`${control} mt-1 block w-24`} /></label>
          <label className="text-xs">To line<input type="number" min={start} max={lines.length} value={end} onChange={(event) => setEnd(Number(event.target.value))} className={`${control} mt-1 block w-24`} /></label>
          <button className={control} disabled={!validSelection} onClick={() => onAddToPlan(`Workspace reference: ${workspace.title}\nFile: ${path}:${start}-${end}\nHEAD: ${file.workspace.headSha ?? "unborn"}; working-copy SHA-256: ${file.contentSha}\nObserved: ${file.observedAt}\n\n\u0060\u0060\u0060\n${selection}\n\u0060\u0060\u0060`)}>Add lines to plan</button>
        </div>
        <p className="text-xs text-neutral-400">Adds up to 200 lines / 16,000 characters to your message. Review it before sending.</p>
      </>}
      {diff && <pre aria-label="File changes" tabIndex={0} className="max-h-[32rem] overflow-auto rounded bg-neutral-950 p-3 font-mono text-xs leading-6 focus-visible:ring-2 focus-visible:ring-blue-500">{diff.diff || "No tracked changes against this base. New untracked files are available under Code."}</pre>}
    </div>
  </div>;
}
