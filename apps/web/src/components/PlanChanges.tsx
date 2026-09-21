import { useEffect, useRef, useState } from "react";
import type { PlanChangeContextResponse, PlanChangeReview, PlanChangeReviewResponse, PlanCommitResponse, ReviewPlanChangesRequest, Task } from "@orc/types";
import { api } from "../api/client";

type Draft = Omit<ReviewPlanChangesRequest, "taskGeneration" | "tasks"> & { tasks: ReviewPlanChangesRequest["tasks"] };
const editable = (task: Task) => !task.milestone && !task.repairFor && ["ready", "backlog", "blocked"].includes(task.status) && task.attempts === 0 && task.runGeneration === 0 && !task.branch && !task.worktreePath && task.prNumber === undefined;
const control = "min-h-10 rounded border border-neutral-600 px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-300 disabled:opacity-50";

/** The reviewed payload lives on the server. A click never applies a new, unseen diff. */
export function PlanChanges({ projectId, draftTitles, prepareDraft, onApplied, onApplying, disabled, fixedDependencies = [] }: {
  fixedDependencies?: (string[] | undefined)[];
  projectId: string; draftTitles: string[]; prepareDraft: () => Promise<Draft>;
  onApplying: (active: boolean) => void;
  onApplied: (response: PlanCommitResponse) => void; disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<PlanChangeContextResponse | null>(null);
  const [review, setReview] = useState<PlanChangeReview | null>(null);
  const [targets, setTargets] = useState<Record<number, string>>({});
  const [dependencies, setDependencies] = useState<Record<number, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"apply" | "pause" | null>(null);
  const visit = useRef(0);
  useEffect(() => { const generation = ++visit.current; return () => { visit.current = generation + 1; }; }, [projectId]);

  async function load() {
    const generation = visit.current;
    setBusy("Loading comparison…"); setError(null); setConfirm(null);
    try {
      const result = await api<PlanChangeContextResponse>("planChangeContext", { params: { id: projectId } });
      if (visit.current !== generation) return;
      setContext(result); setReview(result.latestReview);
      if (result.latestReview) {
        setTargets(Object.fromEntries(result.latestReview.input.tasks.map((t, i) => [i, t.existingTaskId ?? ""])));
        setDependencies(Object.fromEntries(result.latestReview.input.tasks.map((t, i) => [i, t.existingDependsOn])));
      }
    } catch (e) { if (visit.current === generation) setError(String(e)); }
    finally { if (visit.current === generation) setBusy(null); }
  }

  async function compare() {
    if (!context) return;
    const generation = visit.current;
    setBusy("Saving draft and preparing comparison…"); setError(null); setConfirm(null);
    try {
      const draft = await prepareDraft();
      if (visit.current !== generation) return;
      const result = await api<PlanChangeReviewResponse>("reviewPlanChanges", { params: { id: projectId }, body: {
        ...draft, taskGeneration: context.taskGeneration,
        tasks: draft.tasks.map((task, index) => ({ ...task, existingTaskId: task.repairFor ? undefined : targets[index] || undefined, existingDependsOn: task.repairFor ? task.existingDependsOn : dependencies[index] ?? task.existingDependsOn ?? [] })),
      } });
      if (visit.current !== generation) return;
      setReview(result.review);
      setContext((current) => current ? { ...current, sessionVersion: result.review.input.sessionVersion } : current);
    } catch (e) { if (visit.current === generation) setError(String(e)); }
    finally { if (visit.current === generation) setBusy(null); }
  }

  async function act(action: "apply" | "pause") {
    if (!review && action === "apply") return;
    const generation = visit.current;
    if (action === "apply") onApplying(true);
    setBusy(action === "apply" ? "Applying reviewed changes…" : "Pausing dispatch…"); setError(null); setConfirm(null);
    try {
      if (action === "pause") {
        await api("pauseProject", { params: { id: projectId }, body: { drain: true } });
        if (visit.current === generation) await load();
      } else {
        const result = await api<PlanCommitResponse>("applyPlanChanges", { params: { id: projectId }, body: { reviewId: review!.id } });
        if (visit.current === generation) onApplied(result);
      }
    } catch (e) { if (visit.current === generation) setError(String(e)); }
    finally { if (visit.current === generation) { setBusy(null); if (action === "apply") onApplying(false); } }
  }

  const stale = review && context && (review.input.taskGeneration !== context.taskGeneration || review.input.revisionId !== context.revisionId || (review.state === "reviewed" && review.input.sessionVersion !== context.sessionVersion));
  const pending = review?.state === "applying";
  const labels = new Map([...(context?.tasks ?? []), ...(review?.changes.map((c) => c.after) ?? [])].map((task) => [task.id, task.title]));
  return <section aria-label="Plan changes" className="min-w-0 space-y-3 rounded border border-neutral-700 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="text-sm font-medium">Change an existing plan</h3><p className="mt-1 text-xs text-neutral-400">Review additions or revise unstarted tasks. Active and completed work is preserved.</p></div>
      {!open && <button type="button" className={control} disabled={disabled} onClick={() => { setOpen(true); void load(); }}>Review plan changes</button>}
      {open && <button type="button" className={control} disabled={!!busy} onClick={() => void load()}>Refresh task state</button>}
    </div>
    {open && <>
      {busy && <p role="status" className="text-xs text-neutral-300">{busy}</p>}
      {error && <p role="alert" className="break-words text-sm text-red-300">{error} Your draft and comparison are kept. Refresh task state if the plan moved.</p>}
      {!context && !busy && <p className="text-xs text-neutral-400">Task state is unavailable. Refresh to try again.</p>}
      {context && <>
        {context.executionActive && <div className="space-y-2 rounded border border-amber-700 p-3 text-xs text-amber-200">
          <p>You can prepare a proposal while work continues. To apply it, pause dispatch and let active work finish, then refresh and review the latest comparison.</p>
          <button type="button" className={control} disabled={!!busy || disabled} onClick={() => setConfirm("pause")}>Pause to apply changes</button>
        </div>}
        {!context.tasks.length && <p className="text-xs text-neutral-400">No existing tasks. Every proposed task will be added.</p>}
        {!pending && <fieldset disabled={!!busy || disabled} className="space-y-3">
          {draftTitles.map((title, index) => <div key={index} className="min-w-0 space-y-2 rounded bg-neutral-900 p-3">
            <p className="break-words text-sm">{index + 1}. {title}</p>
            <label className="block text-xs text-neutral-400">Apply task {index + 1} as
              <select disabled={fixedDependencies[index] !== undefined} aria-label={`Apply task ${index + 1} as`} value={targets[index] ?? ""} onChange={(event) => {
                const id = event.target.value; setTargets((s) => ({ ...s, [index]: id }));
                setDependencies((s) => ({ ...s, [index]: context.tasks.find((t) => t.id === id)?.dependsOn ?? [] })); setReview(null);
              }} className={`${control} mt-1 w-full min-w-0 bg-neutral-950`}>
                <option value="">Add a new task</option>
                {context.tasks.filter(editable).map((task) => <option key={task.id} value={task.id}>Revise: {task.title}</option>)}
              </select>
            </label>
            <details><summary className="min-h-10 cursor-pointer py-3 text-xs">Dependencies on existing tasks ({(fixedDependencies[index] ?? dependencies[index] ?? []).length})</summary>
              <div className="max-h-48 overflow-y-auto">{context.tasks.filter((t) => t.id !== targets[index]).map((task) => <label key={task.id} className="flex min-h-10 items-center gap-2 text-xs">
                <input type="checkbox" disabled={fixedDependencies[index] !== undefined} checked={(fixedDependencies[index] ?? dependencies[index] ?? []).includes(task.id)} onChange={(event) => {
                  const checked = event.target.checked; setDependencies((s) => ({ ...s, [index]: checked ? [...(s[index] ?? []), task.id] : (s[index] ?? []).filter((id) => id !== task.id) })); setReview(null);
                }} /><span className="break-words">{task.title} · {task.status}</span>
              </label>)}</div>
            </details>
          </div>)}
          <button type="button" className={control} onClick={() => void compare()}>Prepare change comparison</button>
        </fieldset>}
        {review && <div className="space-y-3" aria-label="Reviewed comparison">
          <h4 className="text-sm font-medium">{review.changes.filter((c) => !c.before).length} added · {review.changes.filter((c) => c.before).length} revised · {review.retainedTasks.length} retained</h4>
          <p className="text-xs text-neutral-400">Applying makes no model call. Execution cost and time depend on routing, retries, and checks; no reliable estimate is available.</p>
          <details><summary className="min-h-10 cursor-pointer py-3 text-xs">Accepted brief → proposed brief and guidance</summary>
            <div className="grid min-w-0 gap-3 md:grid-cols-2"><textarea aria-label="Accepted brief" readOnly value={review.previousPrd} rows={5} className="w-full rounded bg-neutral-950 p-2 text-xs" /><textarea aria-label="Proposed brief" readOnly value={review.input.prdMarkdown} rows={5} className="w-full rounded bg-neutral-950 p-2 text-xs" /></div>
            <textarea aria-label="Proposed project guidance" readOnly value={review.input.agentsMd ?? ""} rows={3} className="mt-3 w-full rounded bg-neutral-950 p-2 text-xs" />
          </details>
          {review.changes.map(({ before, after }) => <details key={after.id} className="rounded border border-neutral-700 px-3">
            <summary className="min-h-10 cursor-pointer break-words py-3 text-sm">{before ? "Revise" : "Add"}: {after.title}</summary>
            <div className="grid min-w-0 gap-3 pb-3 md:grid-cols-2">
              {[before, after].map((task, index) => <div key={index} className="min-w-0 space-y-2 text-xs"><strong>{index === 0 ? "Before" : "After"}</strong>{task ? <>
                <p className="whitespace-pre-wrap break-words">{task.title}{"\n"}{task.description}</p>
                <p>{task.difficulty} · {task.assignedModel}</p><p className="break-words">Scope: {task.scopePaths.join(", ") || "None"}</p>
                <p className="break-words">Depends on: {task.dependsOn.map((id) => labels.get(id) ?? id).join(", ") || "None"}</p>
                <ul className="list-inside list-disc">{task.acceptanceCriteria.map((criterion, i) => <li key={i} className="break-words">{criterion}</li>)}</ul>
              </> : <p>New work</p>}</div>)}
            </div>
          </details>)}
          <details><summary className="min-h-10 cursor-pointer py-3 text-xs">Retained work ({review.retainedTasks.length})</summary><ul className="space-y-2 text-xs">{review.retainedTasks.map((task) => <li key={task.id} className="break-words">{task.title} · {task.status}</li>)}</ul></details>
          {stale && <p role="alert" className="text-xs text-amber-300">Tasks changed after this comparison. Prepare a new comparison before applying.</p>}
          {pending && <p className="text-xs text-amber-300">Application is pending persistence. Retry this exact comparison to finish; tasks remain locked until it succeeds.</p>}
          <button type="button" className={control} disabled={!!busy || disabled || context.executionActive || !!stale} onClick={() => setConfirm("apply")}>{pending ? "Retry reviewed application" : "Apply reviewed changes"}</button>
        </div>}
      </>}
      {confirm && <div role="group" aria-label="Confirm plan action" className="space-y-3 rounded border border-amber-700 p-3 text-sm">
        <p>{confirm === "pause" ? "Pause new dispatches and let current work finish? The proposal will still need review before it is applied." : "Apply exactly this reviewed brief and task comparison? The project will stay paused; resume it when ready."}</p>
        <div className="flex flex-wrap gap-2"><button type="button" className={control} disabled={!!busy} onClick={() => void act(confirm)}>Confirm {confirm === "pause" ? "pause" : "apply"}</button><button type="button" className={control} onClick={() => setConfirm(null)}>Keep reviewing</button></div>
      </div>}
    </>}
  </section>;
}
