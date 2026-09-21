import { useEffect, useRef, useState } from "react";
import type { BrowserReviewStep, CaptureReviewRequest, ReviewArtifact, ReviewEvidenceResponse, Task, TaskLogsResponse, TaskReviewResponse } from "@orc/types";
import { api, apiBlob, isAbortError } from "../api/client";
import { WorkspacePreview } from "../components/WorkspacePreview";
import { WorkspaceFiles } from "./WorkspacesView";

const control = "min-h-10 rounded border border-neutral-700 bg-neutral-900 px-3 text-sm focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50";
const explain = (error: unknown) => error instanceof Error ? error.message : "Review could not be loaded. Try again.";
const panel = "min-w-0 space-y-3 rounded-lg border border-neutral-800 p-4";

export function ReviewView({ projectId, taskId, onSelectTask, onAddToPlan }: { projectId: string; taskId: string | null; onSelectTask: (id: string | null) => void; onAddToPlan: (text: string) => void }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError(null);
    api<{ tasks: Task[] }>("listTasks", { params: { id: projectId }, signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setTasks(value.tasks); })
      .catch((err) => { if (!controller.signal.aborted && !isAbortError(err)) setError(explain(err)); });
    return () => controller.abort();
  }, [projectId, refresh]);
  return <section className="mx-auto max-w-7xl space-y-4" aria-label="Review workbench">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold">Review</h1><p className="mt-1 text-sm text-neutral-400">Inspect the product, its changes, and the evidence behind them.</p></div>
      <a className={`${control} inline-flex items-center`} href={`#/p/${projectId}/board${taskId ? `/${encodeURIComponent(taskId)}` : ""}`}>Back to board</a></div>
    {error && <div role="alert" className="text-sm text-red-300">{error} <button className={control} onClick={() => setRefresh((value) => value + 1)}>Retry task list</button></div>}
    {!tasks && !error && <p role="status">Loading tasks…</p>}
    {tasks && <label className="block space-y-1 text-sm">Task to review<select className={`${control} block w-full max-w-xl`} value={taskId ?? ""} onChange={(event) => onSelectTask(event.target.value || null)}>
      <option value="">Choose a task…</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title} · {task.status.replaceAll("_", " ")}</option>)}
    </select></label>}
    {tasks?.length === 0 && <p className="text-sm text-neutral-400">No tasks yet. Create a plan or add work from the board.</p>}
    {!taskId && !!tasks?.length && <p className="text-sm text-neutral-400">Choose a task to review its preview, code, checks and activity.</p>}
    {taskId && <TaskReview key={`${projectId}:${taskId}`} projectId={projectId} taskId={taskId} onAddToPlan={onAddToPlan} />}
  </section>;
}

function TaskReview({ projectId, taskId, onAddToPlan }: { projectId: string; taskId: string; onAddToPlan: (text: string) => void }) {
  const [data, setData] = useState<TaskReviewResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"Preview" | "Changes" | "Checks" | "Activity">("Preview");
  const [refresh, setRefresh] = useState(0);
  const [repair, setRepair] = useState("");
  const [cancelId, setCancelId] = useState<string | null>(null);
  const alive = useRef(true); const acting = useRef(false); const sequence = useRef(0);
  useEffect(() => {
    alive.current = true; const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = sequence.current;
      let delay = 5000;
      try {
        const value = await api<TaskReviewResponse>("taskReview", { params: { id: projectId, taskId }, signal: controller.signal });
        if (value.evidence.some((item) => item.state === "running")) delay = 1000;
        if (!controller.signal.aborted && !acting.current && version === sequence.current) { setData(value); setLoadError(null); }
      } catch (err) { if (!controller.signal.aborted && !isAbortError(err)) setLoadError(explain(err)); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), delay); }
    };
    void poll(); return () => { alive.current = false; controller.abort(); clearTimeout(timer); };
  }, [projectId, taskId, refresh]);
  const params = { id: projectId, taskId };
  async function perform(name: string, action: () => Promise<ReviewEvidenceResponse>): Promise<boolean> {
    if (acting.current) return false;
    acting.current = true; sequence.current++; setBusy(name); setError(null);
    try {
      const result = await action();
      if (alive.current) { setData((old) => old ? { ...old, evidence: [result.evidence, ...old.evidence.filter((item) => item.id !== result.evidence.id)] } : old); setCancelId(null); }
      return true;
    } catch (err) { if (alive.current) setError(explain(err)); return false; }
    finally { acting.current = false; if (alive.current) { setBusy(null); setRefresh((value) => value + 1); } }
  }
  const active = data?.evidence.some((item) => item.state === "running") ?? false;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="min-w-0 break-words font-medium">{data?.task.title ?? "Task review"}</h2><button className={control} disabled={!!busy} onClick={() => setRefresh((value) => value + 1)}>Refresh review</button></div>
    {loadError && <p role="alert" className="text-sm text-red-300">{loadError} Previously loaded information may be out of date.</p>}
    {!data && !loadError && <p role="status">Loading review…</p>}
    {error && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-red-300">{error}</p>}
    {data && <>
      <p className="break-words text-sm text-neutral-400">{data.task.status.replaceAll("_", " ")} · Attempt {data.task.attempts} · {data.workspace.branch ?? "Branch unavailable"} · HEAD {data.workspace.headSha?.slice(0, 7) ?? "unavailable"}{data.workspace.dirty ? " · uncommitted changes" : ""}</p>
      <details className="text-sm"><summary className="flex min-h-10 cursor-pointer items-center focus-visible:ring-2 focus-visible:ring-blue-500">Acceptance criteria</summary>
        {data.task.acceptanceCriteria.length ? <ul className="list-disc space-y-1 pl-5">{data.task.acceptanceCriteria.map((criterion, index) => <li key={index} className="break-words">{criterion}</li>)}</ul> : <p className="text-neutral-400">No task acceptance criteria recorded.</p>}</details>
      <nav className="flex flex-wrap gap-2" aria-label="Review sections">{(["Preview", "Changes", "Checks", "Activity"] as const).map((name) => <button key={name} className={`${control} ${tab === name ? "border-blue-500 text-blue-300" : ""}`} aria-pressed={tab === name} onClick={() => setTab(name)}>{name === "Preview" && data.output === "artifacts" ? "Artifacts" : name}</button>)}</nav>
      {tab === "Preview" && <>
        {data.output === "artifacts" ? <div className={panel}><p>This environment uses checks and artifacts. Review recorded validation in Checks and attach diagnostics below. To use browser evidence, choose web output and configure a preview in Workspaces.</p><button className={control} disabled>Browser check unavailable for artifact output</button></div> : <>
          <WorkspacePreview key={`${projectId}:${taskId}`} projectId={projectId} workspaceId={taskId} />
          <BrowserCheck data={data} busy={busy} active={active} onCapture={(body) => perform("Starting browser check…", () => api<ReviewEvidenceResponse>("captureReview", { params, body }))} />
        </>}
        <EvidenceUpload data={data} busy={busy} onUpload={(body) => perform("Saving evidence…", () => api<ReviewEvidenceResponse>("uploadReviewEvidence", { params, body }))} />
        <section aria-label="Review evidence" className="space-y-3"><h3 className="font-medium">Evidence</h3>
          <p className="text-xs text-neutral-400">Screenshots, traces and diagnostics are retained for 30 days. Browser checks and design feedback do not override required code checks.</p>
          {data.evidence.length === 0 && <p className="text-sm text-neutral-400">No evidence recorded yet. Run a browser check or attach an artifact. Native and batch projects can use files and diagnostics without a preview.</p>}
          {data.evidenceTruncated && <p className="text-sm text-neutral-400">Showing the latest 100 evidence records. Older payloads retain their original expiry.</p>}
          {data.evidence.map((item) => <article key={item.id} className={panel}>
            <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">{item.source === "browser" ? "Browser check" : "Supplied artifact"} · {item.state}</h4>
              <span className={`text-xs ${item.freshness === "current" ? "text-green-300" : "text-amber-300"}`}>{item.freshness}</span></div>
            <p className="whitespace-pre-wrap break-words text-sm text-neutral-300">{item.detail}</p>
            {item.freshnessReason && <p className="text-xs text-amber-300">{item.freshnessReason}</p>}
            <p className="break-words text-xs text-neutral-400">{new Date(item.startedAt).toLocaleString()} · Attempt {item.attempt} · HEAD {item.headSha?.slice(0, 7) ?? "unavailable"} · {item.environment}{item.viewport ? ` · ${item.viewport.width}×${item.viewport.height}` : ""}{item.testedPath ? ` · ${item.testedPath}` : ""}</p>
            <details className="text-xs text-neutral-400"><summary className="flex min-h-10 cursor-pointer items-center focus-visible:ring-2 focus-visible:ring-blue-500">Evidence identity</summary>
              <p className="break-all">{item.source === "upload" ? "Attached at observed HEAD" : "Captured at observed HEAD"}: {item.headSha ?? "unavailable"}</p>
              <p className="break-all">Run: {item.runId ?? "No recorded agent run"} · generation {item.runGeneration} · preview {item.previewId ?? "not associated"}</p>
              {item.testedUrl && <p className="break-all">Tested URL: {item.testedUrl}</p>}
              {item.previewProfile && <p className="break-all">Start command: {item.previewProfile.command} {JSON.stringify(item.previewProfile.args)}</p>}
              <p className="break-all">Evidence: {item.id}</p></details>
            {item.state === "running" && <button className={control} disabled={!!busy} onClick={() => setCancelId(item.id)}>Cancel browser check</button>}
            {cancelId === item.id && <div role="group" aria-label="Confirm cancel browser check" className="space-y-2 rounded border border-amber-800 p-3 text-sm"><p>Cancel this check? Available artifacts will be retained.</p>
              <button className={control} disabled={!!busy} onClick={() => void perform("Cancelling…", () => api<ReviewEvidenceResponse>("cancelReviewCapture", { params: { ...params, evidenceId: item.id } }))}>{busy ?? "Confirm cancel"}</button>
              <button className={`${control} ml-2`} disabled={!!busy} onClick={() => setCancelId(null)}>Keep running</button></div>}
            <div className="space-y-2">{item.artifacts.map((artifact) => <Artifact key={artifact.id} artifact={artifact} projectId={projectId} taskId={taskId} />)}</div>
            <button className={control} onClick={() => setRepair((old) => `${old}${old ? "\n" : ""}Evidence ${item.id}, HEAD ${item.headSha ?? "unavailable"}, attempt ${item.attempt}${item.viewport ? `, ${item.viewport.width}×${item.viewport.height}` : ""}: `)}>Reference in repair</button>
          </article>)}
        </section>
      </>}
      {tab === "Changes" && (data.workspace.state === "available" ? <WorkspaceFiles key={taskId} projectId={projectId} workspace={data.workspace} onAddToPlan={onAddToPlan} /> : <p role="status" className="text-sm text-amber-300">{data.workspace.reason ?? "Workspace unavailable."} Recorded evidence and checks remain available.</p>)}
      {tab === "Checks" && <section className={panel} aria-label="Code checks"><h3 className="font-medium">Required code checks</h3><p className="text-sm text-neutral-400">These are recorded validator decisions for their run. Legacy records do not include a commit hash, so they are historical evidence. Browser or design review cannot override them.</p>
        {data.decisions.length === 0 && <p className="text-sm text-neutral-400">No code-check decisions recorded yet.</p>}
        {data.decisions.map((decision) => <article key={decision.id} className="space-y-2 border-t border-neutral-800 pt-3"><p className="break-words text-sm">{decision.verdict.replaceAll("_", " ")} · {decision.validatorModel} · run {decision.runId}</p><p className="break-words text-xs text-neutral-400">{decision.gate.environment ?? "Validation environment was not recorded."}</p>
          <div className="grid gap-2 sm:grid-cols-3">{(["typecheck", "lint", "build", "tests", "noConflicts", "inScope"] as const).map((name) => <p key={name} className={`text-sm ${decision.gate[name] ? "text-green-300" : "text-red-300"}`}>{name}: {decision.gate[name] ? "passed" : "failed"}</p>)}</div>
          {decision.gate.vacuous && <p className="text-sm text-amber-300">No applicable repository scripts ran; do not treat this as tested code.</p>}
          <p className="whitespace-pre-wrap break-words text-sm text-neutral-300">{decision.reasons.join("\n")}</p>
          <details><summary className="flex min-h-10 cursor-pointer items-center text-sm focus-visible:ring-2 focus-visible:ring-blue-500">Check output</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all bg-neutral-950 p-3 text-xs">{Object.entries(decision.gate.details).map(([name, output]) => `${name}\n${output}`).join("\n\n") || "No check output recorded."}</pre></details>
        </article>)}</section>}
      {tab === "Activity" && <section className={panel} aria-label="Review activity"><h3 className="font-medium">Attempts</h3>
        {!data.runs.length && <p className="text-sm text-neutral-400">No execution attempts recorded.</p>}
        {data.runs.map((run) => <p key={run.id} className="break-words text-sm text-neutral-300">Attempt {run.attempt} · {run.model} · {run.status} · {new Date(run.startedAt).toLocaleString()}{run.exitReason ? ` · ${run.exitReason}` : ""}</p>)}
        <Activity taskId={taskId} refresh={refresh} /></section>}
      <section className={panel} aria-label="Request a focused repair"><label className="block text-sm">What should change?<textarea rows={3} className={`${control} mt-2 block w-full py-2`} value={repair} onChange={(event) => setRepair(event.target.value)} placeholder="Describe the difference you want the agent to fix…" /></label>
        <button className={control} disabled={!repair.trim() || repair.length > 12_000} onClick={() => onAddToPlan(`Review follow-up for task ${data.task.title} (${taskId})\nObserved HEAD: ${data.workspace.headSha ?? "unavailable"}; task status: ${data.task.status}\n\n${repair}`)}>Add repair to plan</button>
        <p className="text-xs text-neutral-400">Preserves your unsent planning message. Review and send it there; this does not change the task or approve a merge.</p></section>
    </>}
  </div>;
}

function BrowserCheck({ data, busy, active, onCapture }: { data: TaskReviewResponse; busy: string | null; active: boolean; onCapture: (body: CaptureReviewRequest) => Promise<boolean> }) {
  const [path, setPath] = useState("/"); const [width, setWidth] = useState(1280); const [height, setHeight] = useState(800);
  const [steps, setSteps] = useState<BrowserReviewStep[]>([]); const [confirm, setConfirm] = useState(false);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const reason = !data.browser.available ? data.browser.reason : data.preview?.state !== "ready" ? "Start a task preview before checking it in the browser." : undefined;
  async function start() {
    const values = { taskUpdatedAt: data.task.updatedAt, previewId: data.preview!.id, path, viewport: { width, height }, steps };
    const key = JSON.stringify(values); if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
    if (await onCapture({ requestId: pending.current.id, ...values })) { pending.current = null; setConfirm(false); }
  }
  return <section className={panel} aria-label="Browser check"><h3 className="font-medium">Check in the browser</h3>
    <p className="text-sm text-neutral-400">Capture this route in a separate Chromium context. Add interactions to reproduce the state you want to review. Requests outside this preview are blocked; external assets or services may be unavailable.</p>
    {reason && <p className="text-sm text-amber-300">{reason}</p>}
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_8rem]"><label className="text-sm">Application path<input className={`${control} mt-1 block w-full`} value={path} onChange={(event) => setPath(event.target.value)} /></label>
      <label className="text-sm">Width<input className={`${control} mt-1 block w-full`} type="number" min={240} max={2560} value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
      <label className="text-sm">Height<input className={`${control} mt-1 block w-full`} type="number" min={240} max={1600} value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label></div>
    {steps.map((step, index) => <div key={index} className="flex flex-col gap-2 rounded border border-neutral-800 p-2 sm:flex-row sm:flex-wrap">
      <select aria-label={`Step ${index + 1} action`} className={control} value={step.action} onChange={(event) => setSteps(steps.map((item, i) => i === index ? { ...item, action: event.target.value as BrowserReviewStep["action"] } : item))}><option value="expectText">Expect text</option><option value="clickText">Click text</option><option value="fillLabel">Fill field by label</option></select>
      <input aria-label={`Step ${index + 1} target`} className={`${control} min-w-0 flex-1`} value={step.target} onChange={(event) => setSteps(steps.map((item, i) => i === index ? { ...item, target: event.target.value } : item))} placeholder="Exact text or field label" />
      {step.action === "fillLabel" && <input aria-label={`Step ${index + 1} value`} className={`${control} min-w-0 flex-1`} value={step.value ?? ""} onChange={(event) => setSteps(steps.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} />}
      <button className={control} onClick={() => setSteps(steps.filter((_, i) => i !== index))}>Remove step {index + 1}</button>
    </div>)}
    <div className="flex flex-wrap gap-2"><button className={control} disabled={steps.length >= 10 || !!busy} onClick={() => setSteps([...steps, { action: "expectText", target: "" }])}>Add interaction</button>
      <button className={control} disabled={!!reason || active || !!busy} onClick={() => setConfirm(true)}>{busy === "Starting browser check…" ? busy : active ? "Browser check running…" : "Run browser check"}</button></div>
    {confirm && <div role="group" aria-label="Confirm browser check" className="space-y-2 rounded border border-amber-800 p-3 text-sm"><p>Navigate to {path} at {width}×{height} and perform {steps.length} interactions? These actions can change the preview app’s data.</p>
      <button className={control} disabled={!!busy || !!reason || active} onClick={() => void start()}>{busy ?? "Confirm browser check"}</button><button className={`${control} ml-2`} disabled={!!busy} onClick={() => setConfirm(false)}>Cancel</button></div>}
  </section>;
}

function EvidenceUpload({ data, busy, onUpload }: { data: TaskReviewResponse; busy: string | null; onUpload: (body: unknown) => Promise<boolean> }) {
  const [file, setFile] = useState<File | null>(null); const [description, setDescription] = useState(""); const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false); const pending = useRef<{ key: string; id: string } | null>(null);
  async function upload() {
    if (!file || reading || busy) return;
    setError(null); setReading(true);
    try {
      const kind = file.name.toLowerCase().endsWith(".png") ? "screenshot" : file.name.toLowerCase().endsWith(".zip") ? "trace" : "text";
      const limit = kind === "screenshot" ? 5 * 1024 * 1024 : kind === "trace" ? 20 * 1024 * 1024 : 256 * 1024;
      if (file.size > limit) throw new Error("File exceeds its limit: PNG 5 MiB, ZIP 20 MiB, text 256 KiB.");
      const contentBase64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.onerror = () => reject(new Error("Could not read this file.")); reader.readAsDataURL(file); });
      const values = { taskUpdatedAt: data.task.updatedAt, kind, name: file.name, description, contentBase64 };
      const key = JSON.stringify(values); if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
      if (await onUpload({ requestId: pending.current.id, ...values })) { pending.current = null; setDescription(""); }
    } catch (err) { setError(explain(err)); } finally { setReading(false); }
  }
  return <details className={panel}><summary className="flex min-h-10 cursor-pointer items-center text-sm focus-visible:ring-2 focus-visible:ring-blue-500">Attach an artifact</summary>
    <p className="text-xs text-neutral-400">For browser, native or batch work: PNG screenshot (5 MiB), ZIP trace (20 MiB), or UTF-8 diagnostics (256 KiB). Supplied evidence is labelled unverified.</p>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    <label className="block text-sm">Artifact file<input type="file" accept=".png,.zip,.txt,.log,.md,.json" className={`${control} mt-1 block w-full max-w-full py-2`} onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
    <label className="block text-sm">What does this artifact show?<textarea rows={2} className={`${control} mt-1 block w-full py-2`} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
    <button className={control} disabled={!file || !description.trim() || reading || !!busy} onClick={() => void upload()}>{reading || busy === "Saving evidence…" ? "Saving evidence…" : "Save artifact"}</button>
  </details>;
}

function Artifact({ artifact, projectId, taskId }: { artifact: ReviewArtifact; projectId: string; taskId: string }) {
  const [url, setUrl] = useState<string | null>(null); const [text, setText] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const alive = useRef(true); const controller = useRef<AbortController | null>(null); const objectUrl = useRef<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }; }, []);
  async function open() {
    if (busy) return; setBusy(true); setError(null); controller.current = new AbortController();
    try {
      const blob = await apiBlob("reviewArtifact", { params: { id: projectId, taskId, artifactId: artifact.id }, signal: controller.current.signal });
      if (!alive.current) return;
      if (artifact.kind === "text") { const content = await blob.text(); if (alive.current) setText(content); }
      else {
        if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = URL.createObjectURL(blob); setUrl(objectUrl.current);
        if (artifact.kind === "trace") { const link = document.createElement("a"); link.href = objectUrl.current; link.download = artifact.name; link.click(); }
      }
    } catch (err) { if (alive.current && !isAbortError(err)) setError(explain(err)); }
    finally { if (alive.current) setBusy(false); }
  }
  return <div className="min-w-0 space-y-2 rounded border border-neutral-800 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="min-w-0 break-all text-xs text-neutral-400">{artifact.name} · {Math.ceil(artifact.bytes / 1024)} KiB · expires {new Date(artifact.expiresAt).toLocaleDateString()}</p>
    <button className={control} disabled={!artifact.available || busy} onClick={() => void open()}>{busy ? "Loading artifact…" : !artifact.available ? "Artifact expired" : artifact.kind === "trace" ? "Download trace" : artifact.kind === "screenshot" ? "View screenshot" : "Read diagnostics"}</button></div>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {url && artifact.kind === "screenshot" && <img src={url} alt={artifact.name} className="h-auto max-h-[40rem] max-w-full rounded object-contain" onError={() => setError("This screenshot could not be decoded. Its record is retained.")} />}
    {text !== null && <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap break-all bg-neutral-950 p-3 text-xs focus-visible:ring-2 focus-visible:ring-blue-500">{text}</pre>}
    {artifact.kind === "trace" && url && <p className="text-xs text-neutral-400">Open the ZIP with your local Playwright Trace Viewer. Traces may contain the preview app’s data.</p>}
  </div>;
}

function Activity({ taskId, refresh }: { taskId: string; refresh: number }) {
  const [logs, setLogs] = useState<TaskLogsResponse | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setError(null);
    api<TaskLogsResponse>("taskLogs", { params: { id: taskId }, query: { limit: "300" }, signal: controller.signal }).then((value) => { if (!controller.signal.aborted) setLogs(value); })
      .catch((err) => { if (!controller.signal.aborted && !isAbortError(err)) setError(explain(err)); });
    return () => controller.abort();
  }, [taskId, refresh]);
  return <div className="space-y-2"><h3 className="font-medium">Recent activity</h3>{error && <p role="alert" className="text-sm text-red-300">{error} Use Refresh review to retry.</p>}
    {!logs && !error && <p role="status" className="text-sm">Loading activity…</p>}{logs?.logs.length === 0 && <p className="text-sm text-neutral-400">No activity recorded.</p>}
    {!!logs?.logs.length && <pre tabIndex={0} className="max-h-96 overflow-auto whitespace-pre-wrap break-all bg-neutral-950 p-3 text-xs focus-visible:ring-2 focus-visible:ring-blue-500">{logs.logs.map((line) => `${new Date(line.ts).toLocaleTimeString()} [${line.source}] ${line.message}`).join("\n")}</pre>}
  </div>;
}
