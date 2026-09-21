import { useEffect, useRef, useState } from "react";
import type { PreviewLaunchResponse, PreviewProfile, WorkspacePreviewResponse } from "@orc/types";
import { api, isAbortError } from "../api/client";

const control = "min-h-10 rounded border border-neutral-700 bg-neutral-900 px-3 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50";
const detail = (error: unknown) => error instanceof Error ? error.message : "Preview action failed. Try again.";
const initial: PreviewProfile = { command: "npm", args: ["run", "dev", "--", "--host", "{host}", "--port", "{port}"], readinessPath: "/", startupTimeoutSeconds: 30 };

export function WorkspacePreview({ projectId, workspaceId }: { projectId: string; workspaceId: string }) {
  const [data, setData] = useState<WorkspacePreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<"start" | "stop" | null>(null);
  const [draft, setDraft] = useState(initial);
  const [args, setArgs] = useState(JSON.stringify(initial.args));
  const [reviewedVersion, setReviewedVersion] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const action = useRef(false);
  const sequence = useRef(0);
  const alive = useRef(true);
  const loaded = useRef(false);
  const params = { id: projectId, workspaceId };
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = sequence.current;
      try {
        const value = await api<WorkspacePreviewResponse>("workspacePreview", { params: { id: projectId, workspaceId }, signal: controller.signal });
        if (controller.signal.aborted || action.current || version !== sequence.current) return;
        setData(value);
        if (!loaded.current) {
          const profile = value.profile ?? initial;
          setDraft(profile); setArgs(JSON.stringify(profile.args)); setReviewedVersion(value.projectUpdatedAt); loaded.current = true;
        }
        if (value.preview?.state !== "ready") setUrl(null);
      } catch (err) { if (!controller.signal.aborted && !isAbortError(err) && version === sequence.current && !action.current) setError(detail(err)); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000); }
    };
    void poll();
    return () => { alive.current = false; controller.abort(); clearTimeout(timer); };
  }, [projectId, workspaceId, refresh]);

  async function perform(name: string, operation: () => Promise<void>) {
    if (action.current) return;
    action.current = true; sequence.current += 1; setBusy(name); setError(null); setNotice(null);
    try { await operation(); if (alive.current) setConfirmation(null); }
    catch (err) { if (alive.current) setError(detail(err)); }
    finally { action.current = false; if (alive.current) setBusy(null); }
  }
  const save = () => perform("Saving…", async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(args); } catch { throw new Error("Arguments must be a JSON array, for example [\"run\", \"dev\"]."); }
    if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== "string")) throw new Error("Every preview argument must be a string.");
    const value = await api<WorkspacePreviewResponse>("setPreviewProfile", { params: { id: projectId }, body: { profile: { ...draft, args: parsed }, projectUpdatedAt: reviewedVersion } });
    if (alive.current) { setNotice("Preview command saved. It will be used on the next start."); setReviewedVersion(value.projectUpdatedAt); setData((old) => old ? { ...old, profile: value.profile, projectUpdatedAt: value.projectUpdatedAt } : value); }
  });
  const change = (kind: "start" | "stop") => perform(kind === "start" ? "Starting…" : "Stopping…", async () => {
    const value = await api<WorkspacePreviewResponse>(kind === "start" ? "startWorkspacePreview" : "stopWorkspacePreview", {
      params, ...(kind === "start" ? { body: { projectUpdatedAt: data!.projectUpdatedAt } } : {}),
    });
    if (alive.current) { setData(value); setUrl(null); }
  });
  function open(newTab: boolean) {
    if (action.current) return;
    const popup = newTab ? window.open("about:blank", "_blank") : null;
    if (popup) popup.opener = null;
    void perform("Opening…", async () => {
      try {
        if (newTab && !popup) throw new Error("The browser blocked a new tab. Allow popups or use Show preview here.");
        const launch = await api<PreviewLaunchResponse>("openWorkspacePreview", { params });
        if (popup) popup.location.href = launch.url;
        else if (alive.current) setUrl(launch.url);
      } catch (err) { popup?.close(); throw err; }
    });
  }
  const preview = data?.preview;
  const active = preview && ["starting", "ready", "stopping"].includes(preview.state);
  return <section aria-label="Workspace preview" className="min-w-0 space-y-3 rounded-lg border border-neutral-800 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">Preview</h2>
      <button className={control} disabled={!!busy} onClick={() => { setError(null); setRefresh((value) => value + 1); }}>Refresh preview</button></div>
    {!data && !error && <p role="status" className="text-sm text-neutral-400">Loading preview…</p>}
    {error && <p role="alert" className="break-words text-sm text-red-300">{error}</p>}
    {notice && <p role="status" className="text-sm text-neutral-300">{notice}</p>}
    {data && <>
      {!data.available && <p className="text-sm text-neutral-400">{data.reason}</p>}
      {preview && <div className="space-y-1 text-sm"><p role="status" className="capitalize">{preview.state} · Native host process</p>
        <p className="break-words text-neutral-400">{preview.detail}</p>
        <p className="break-words text-xs text-neutral-500">Started {new Date(preview.startedAt).toLocaleString()} · HEAD {preview.headSha?.slice(0, 7) ?? "not captured"}{preview.dirty ? " · uncommitted changes" : ""}. Live files may change after this observation.</p></div>}
      <div className="flex flex-wrap gap-2">
        <button className={control} disabled={!!busy || !!active || !data.available || !data.profile} onClick={() => setConfirmation("start")}>{busy === "Starting…" ? busy : "Start preview"}</button>
        <button className={control} disabled={!!busy || !active || preview?.state === "stopping"} onClick={() => setConfirmation("stop")}>{busy === "Stopping…" ? busy : "Stop preview"}</button>
        <button className={control} disabled={!!busy || preview?.state !== "ready"} onClick={() => open(false)}>{busy === "Opening…" ? busy : "Show preview here"}</button>
        <button className={control} disabled={!!busy || preview?.state !== "ready"} onClick={() => open(true)}>Open in new tab</button>
      </div>
      {!data.profile && <p className="text-sm text-neutral-400">Save a start command below before launching a task preview.</p>}
      {confirmation && <div role="group" aria-label={`Confirm ${confirmation} preview`} className="space-y-3 rounded border border-amber-800 p-3 text-sm">
        <p>{confirmation === "start" ? "This runs repository code on the host in this task’s worktree. It is not a sandbox. Review the saved command before starting." : "Stop this preview and close its browser connections? Workspace files will be preserved."}</p>
        {confirmation === "start" && <pre className="whitespace-pre-wrap break-all text-xs">{data.profile?.command} {JSON.stringify(data.profile?.args)}</pre>}
        <div className="flex gap-2"><button className={control} disabled={!!busy} onClick={() => void change(confirmation)}>{busy ?? `Confirm ${confirmation}`}</button>
          <button className={control} disabled={!!busy} onClick={() => setConfirmation(null)}>Cancel</button></div>
      </div>}
      <details className="text-sm"><summary className="flex min-h-10 cursor-pointer items-center focus-visible:ring-2 focus-visible:ring-blue-500">Preview command</summary>
        <form className="space-y-3 pt-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <p className="text-xs text-neutral-400">Uses installed dependencies in the task worktree. Arguments are passed directly, without a shell. Use {"{host}"} and {"{port}"} for the assigned address. Changes apply to the next start.</p>
          <label className="block">Command<input className={`${control} mt-1 block w-full`} value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} /></label>
          <label className="block">Arguments (JSON array)<textarea rows={3} className={`${control} mt-1 block w-full py-2 font-mono`} value={args} onChange={(event) => setArgs(event.target.value)} /></label>
          <div className="grid gap-3 sm:grid-cols-2"><label>Readiness path<input className={`${control} mt-1 block w-full`} value={draft.readinessPath} onChange={(event) => setDraft({ ...draft, readinessPath: event.target.value })} /></label>
            <label>Startup timeout (seconds)<input type="number" min={5} max={120} className={`${control} mt-1 block w-full`} value={draft.startupTimeoutSeconds} onChange={(event) => setDraft({ ...draft, startupTimeoutSeconds: Number(event.target.value) })} /></label></div>
          {reviewedVersion !== data.projectUpdatedAt && <p className="text-amber-300">Project settings changed. Your draft is preserved. Review the current settings before saving.</p>}
          <div className="flex flex-wrap gap-2"><button className={control} type="submit" disabled={!!busy || reviewedVersion !== data.projectUpdatedAt}>{busy === "Saving…" ? busy : "Save preview command"}</button>
            <button className={control} type="button" disabled={!!busy} onClick={() => { const current = data.profile ?? initial; setDraft(current); setArgs(JSON.stringify(current.args)); setReviewedVersion(data.projectUpdatedAt); }}>Load current command</button></div>
        </form>
      </details>
      {preview && <details className="text-sm"><summary className="flex min-h-10 cursor-pointer items-center focus-visible:ring-2 focus-visible:ring-blue-500">Preview logs</summary>
        <pre tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-950 p-3 text-xs focus-visible:ring-2 focus-visible:ring-blue-500">{preview.logs || "No preview output recorded."}</pre></details>}
      {url && preview?.state === "ready" && <div className="space-y-2"><p className="text-xs text-neutral-400">If this app refuses embedding or access expires, reopen it in a new tab. Background work continues when you leave this page.</p>
        <iframe title="Task workspace preview" src={url} referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" className="h-[32rem] w-full rounded border border-neutral-700 bg-white" /></div>}
    </>}
  </section>;
}
