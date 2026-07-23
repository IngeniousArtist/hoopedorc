import type {
  Difficulty,
  DraftTask,
  FigmaCapabilityIssue,
  FigmaVerificationFailureDetails,
  GetProjectResponse,
  GetSettingsResponse,
  ListPlanAttachmentsResponse,
  ListPlanSessionArchivesResponse,
  ModelConfig,
  ModelId,
  PlanAttachment,
  PlanChatMessage,
  PlanChatResponse,
  PlanCommitResponse,
  PlanDeconstructResponse,
  PlanningSessionResponse,
  PlanSessionArchive,
  Project,
  Role,
  VerifiedFigmaReference,
} from "@orc/types";
import { useEffect, useRef, useState } from "react";
import { ApiRequestError, api, apiUpload } from "../api/client";
import { ModelSelect } from "../components/ModelSelect";
import { useToast } from "../hooks/useToast";
import { useWS } from "../hooks/useWS";
import { formatUsd } from "../lib/format";

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

/** UI-side draft task: deps tracked by stable UUID key, not array index. */
interface UiTask {
  key: string;
  title: string;
  description: string;
  difficulty: Difficulty;
  role?: Role;
  assignedModel: ModelId;
  scopePaths: string[];
  acceptanceCriteria: string[];
  dependsOnKeys: string[];
}

const PLAN_COMPLETE_TOKEN = "[PLAN_COMPLETE]";

/** Strip the readiness token from a message and return whether it was present. */
function extractPlanComplete(text: string): { content: string; ready: boolean } {
  const idx = text.indexOf(PLAN_COMPLETE_TOKEN);
  if (idx === -1) return { content: text, ready: false };
  return {
    content: text.slice(0, idx).trimEnd(),
    ready: true,
  };
}

const newKey = () => crypto.randomUUID();

function figmaFailureDetails(value: unknown): FigmaVerificationFailureDetails | null {
  if (!value || typeof value !== "object") return null;
  const details = value as Partial<FigmaVerificationFailureDetails>;
  if (
    !details.issue ||
    typeof details.issue !== "object" ||
    typeof details.issue.message !== "string" ||
    !Array.isArray(details.issue.actions)
  ) {
    return null;
  }
  return {
    issue: details.issue as FigmaCapabilityIssue,
    costUsd: typeof details.costUsd === "number" ? details.costUsd : 0,
  };
}

function uiTasksFromDraft(drafts: DraftTask[]): UiTask[] {
  const keys: string[] = drafts.map(() => newKey());
  return drafts.map((t, i) => ({
    key: keys[i]!,
    title: t.title,
    description: t.description,
    difficulty: t.difficulty,
    role: t.role,
    assignedModel: t.assignedModel,
    scopePaths: t.scopePaths,
    acceptanceCriteria: t.acceptanceCriteria,
    dependsOnKeys: t.dependsOn
      .map((d) => keys[d])
      .filter((k): k is string => Boolean(k)),
  }));
}

function draftTasksFromUi(tasks: UiTask[]): DraftTask[] {
  const keyIndex = new Map(tasks.map((t, i) => [t.key, i]));
  return tasks.map((t) => ({
    title: t.title,
    description: t.description,
    difficulty: t.difficulty,
    role: t.role,
    acceptanceCriteria: t.acceptanceCriteria.filter((c) => c.trim()),
    dependsOn: t.dependsOnKeys
      .map((k) => keyIndex.get(k))
      .filter((n): n is number => n !== undefined),
    scopePaths: t.scopePaths.filter((p) => p.trim()),
    assignedModel: t.assignedModel,
  }));
}

export function PlanView({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: () => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [models, setModels] = useState<ModelConfig[]>([]);
  // F37: whichever model routing.planner resolves to may be Claude, Codex,
  // or (rejected server-side) opencode — name it instead of hardcoding
  // "Claude" throughout the chat UI below.
  const [plannerModelId, setPlannerModelId] = useState<ModelId | null>(null);
  // Deconstruct can be routed to its own model (routing.deconstructor);
  // unset means "same as planner".
  const [deconstructorModelId, setDeconstructorModelId] = useState<ModelId | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  // Read-only archive of every past planning session (F28's markdown files)
  // — this is what keeps the chat history visible after a commit clears the
  // live session, including for the whole time the tasks are running.
  const [archives, setArchives] = useState<PlanSessionArchive[]>([]);

  // Planning writes are locked server-side (409) while the project runs;
  // mirror that here: banner instead of the input row, buttons disabled.
  // project.updated events flip this live when the run finishes.
  const running = project?.status === "running";
  useWS(projectId, (e) => {
    if (e.type === "project.updated" && e.payload.id === projectId) {
      setProject(e.payload);
    }
  });

  // Chat
  const [messages, setMessages] = useState<PlanChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [chatting, setChatting] = useState(false);
  const [planCost, setPlanCost] = useState(0);
  const [plannerReady, setPlannerReady] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // F27: planning-context attachments (images/PDFs/reference files) —
  // seeded from GET on mount so they survive a reload, uploaded/removed
  // against the same list the planner reads from disk.
  const [attachments, setAttachments] = useState<PlanAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Draft plan
  const [prd, setPrd] = useState<string | null>(null);
  // F38: generated AGENTS.md content — operator-editable alongside the PRD,
  // same lifecycle (set on deconstruct, restored on reload, cleared on
  // commit/no-draft).
  const [agentsMd, setAgentsMd] = useState<string | null>(null);
  const [tasks, setTasks] = useState<UiTask[] | null>(null);
  const [verifiedFigmaReferences, setVerifiedFigmaReferences] = useState<
    VerifiedFigmaReference[]
  >([]);
  const [figmaIssue, setFigmaIssue] = useState<FigmaCapabilityIssue | null>(null);
  const [deconstructing, setDeconstructing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState<PlanCommitResponse | null>(null);

  // Auto-save draft edits debounced (1 s after last change)
  const saveDraftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load session on mount / project change ──
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    setCommitted(null);
    setError(null);
    setFigmaIssue(null);
    setPlannerReady(false);
    Promise.all([
      api<GetProjectResponse>("getProject", { params: { id: projectId } }),
      api<PlanningSessionResponse>("planSession", { params: { id: projectId } }),
      api<GetSettingsResponse>("getSettings"),
      api<ListPlanAttachmentsResponse>("listPlanAttachments", {
        params: { id: projectId },
      }),
      api<ListPlanSessionArchivesResponse>("planSessionArchives", {
        params: { id: projectId },
      }),
    ])
      .then(([projRes, sessionRes, settingsRes, attachmentsRes, archivesRes]) => {
        setProject(projRes.project ?? null);
        setModels(settingsRes.settings.models);
        setPlannerModelId(settingsRes.settings.routing.planner);
        setDeconstructorModelId(
          settingsRes.settings.routing.deconstructor ??
            settingsRes.settings.routing.planner,
        );
        setArchives(archivesRes.sessions);
        // Strip [PLAN_COMPLETE] tokens from restored messages and detect readiness.
        const cleaned = sessionRes.messages.map((m) => {
          if (m.role !== "assistant") return m;
          const { content, ready } = extractPlanComplete(m.content);
          if (ready) setPlannerReady(true);
          return { ...m, content };
        });
        setMessages(cleaned);
        setPlanCost(sessionRes.planCostUsd);
        setVerifiedFigmaReferences(sessionRes.verifiedFigmaReferences ?? []);
        if (sessionRes.draftTasks && sessionRes.draftTasks.length > 0) {
          setTasks(uiTasksFromDraft(sessionRes.draftTasks));
          setPrd(sessionRes.prd ?? null);
          setAgentsMd(sessionRes.agentsMd ?? null);
        } else {
          setTasks(null);
          setPrd(null);
          setAgentsMd(null);
        }
        setAttachments(attachmentsRes.attachments);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [projectId]);

  // F27: upload from the hidden file input; errors surface as a toast
  // rather than the page-level error banner, since a failed attachment
  // shouldn't block the chat itself.
  async function handleAttachFiles(files: FileList | null) {
    if (!projectId || !files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const res = await apiUpload<ListPlanAttachmentsResponse>(
          "uploadPlanAttachment",
          { params: { id: projectId }, file },
        );
        setAttachments(res.attachments);
      }
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function removeAttachment(name: string) {
    if (!projectId) return;
    try {
      const res = await api<ListPlanAttachmentsResponse>("deletePlanAttachment", {
        params: { id: projectId, name },
      });
      setAttachments(res.attachments);
    } catch (e) {
      toast(String(e), "error");
    }
  }

  // Scroll chat to bottom on new messages
  useEffect(() => {
    const chat = chatEndRef.current?.parentElement;
    if (!chat) return;
    chat.scrollTo({
      top: chat.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, [messages, chatting]);

  // Auto-save draft tasks whenever they change (debounced)
  useEffect(() => {
    if (!tasks || committed || !projectId) return;
    if (saveDraftTimer.current) clearTimeout(saveDraftTimer.current);
    saveDraftTimer.current = setTimeout(() => {
      api("planSaveDraft", {
        params: { id: projectId },
        body: {
          prdMarkdown: prd ?? "",
          tasks: draftTasksFromUi(tasks),
          agentsMd: agentsMd ?? "",
        },
      }).catch(() => {});
    }, 1000);
    return () => {
      if (saveDraftTimer.current) clearTimeout(saveDraftTimer.current);
    };
  }, [tasks, prd, agentsMd, committed, projectId]);

  async function sendChat() {
    if (!projectId || !input.trim() || chatting || running) return;
    const next: PlanChatMessage[] = [
      ...messages,
      { role: "user", content: input.trim() },
    ];
    setMessages(next);
    setInput("");
    setChatting(true);
    setError(null);
    setPlannerReady(false); // reset until the planner confirms again
    try {
      const res = await api<PlanChatResponse>("planChat", {
        params: { id: projectId },
        body: { messages: next },
      });
      const { content, ready } = extractPlanComplete(res.reply);
      if (ready) setPlannerReady(true);
      setMessages([...next, { role: "assistant", content }]);
      setPlanCost((c) => c + res.costUsd);
    } catch (e) {
      setError(String(e));
      setMessages(messages); // roll back optimistic user turn
    } finally {
      setChatting(false);
    }
  }

  async function generateTable(
    figmaVerification: "live" | "attachments" = "live",
  ) {
    if (!projectId || deconstructing || running) return;
    setDeconstructing(true);
    setError(null);
    try {
      const res = await api<PlanDeconstructResponse>("planDeconstruct", {
        params: { id: projectId },
        body: {
          messages,
          ...(figmaVerification === "attachments"
            ? { figmaVerification }
            : {}),
        },
      });
      setPlanCost((c) => c + res.costUsd);
      setPrd(res.prdMarkdown);
      setAgentsMd(res.agentsMd ?? null);
      setTasks(uiTasksFromDraft(res.tasks));
      setVerifiedFigmaReferences(res.verifiedFigmaReferences ?? []);
      setFigmaIssue(null);
    } catch (e) {
      const details =
        e instanceof ApiRequestError &&
        e.code === "FIGMA_VERIFICATION_FAILED"
          ? figmaFailureDetails(e.details)
          : null;
      if (details) {
        setPlanCost((cost) => cost + details.costUsd);
        setFigmaIssue(details.issue);
      } else {
        setError(String(e));
      }
    } finally {
      setDeconstructing(false);
    }
  }

  function patchTask(key: string, patch: Partial<UiTask>) {
    setTasks((ts) =>
      ts ? ts.map((t) => (t.key === key ? { ...t, ...patch } : t)) : ts,
    );
  }

  function removeTask(key: string) {
    setTasks((ts) =>
      ts
        ? ts
            .filter((t) => t.key !== key)
            .map((t) => ({
              ...t,
              dependsOnKeys: t.dependsOnKeys.filter((k) => k !== key),
            }))
        : ts,
    );
  }

  function addTask() {
    const fallback =
      models.find((m) => m.enabled)?.id ?? ("deepseek-flash" as ModelId);
    setTasks((ts) => [
      ...(ts ?? []),
      {
        key: newKey(),
        title: "New task",
        description: "",
        difficulty: "medium",
        assignedModel: fallback,
        scopePaths: ["**/*"],
        acceptanceCriteria: [],
        dependsOnKeys: [],
      },
    ]);
  }

  function moveTask(idx: number, dir: -1 | 1) {
    setTasks((ts) => {
      if (!ts) return ts;
      const j = idx + dir;
      if (j < 0 || j >= ts.length) return ts;
      const copy = [...ts];
      [copy[idx], copy[j]] = [copy[j]!, copy[idx]!];
      return copy;
    });
  }

  async function commit() {
    if (!projectId || !tasks || tasks.length === 0) return;
    setCommitting(true);
    setError(null);
    try {
      const res = await api<PlanCommitResponse>("planCommit", {
        params: { id: projectId },
        body: {
          prdMarkdown: prd ?? "",
          tasks: draftTasksFromUi(tasks),
          agentsMd: agentsMd ?? "",
        },
      });
      setCommitted(res);
      setTasks(null);
      setAgentsMd(null);
      setVerifiedFigmaReferences([]);
      setFigmaIssue(null);
      // The commit just finalized this session's archive file — refresh the
      // history list so the conversation stays visible right away.
      api<ListPlanSessionArchivesResponse>("planSessionArchives", {
        params: { id: projectId },
      })
        .then((r) => setArchives(r.sessions))
        .catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setCommitting(false);
    }
  }

  const inputCls =
    "w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200";

  const plannerDisplayName =
    models.find((m) => m.id === plannerModelId)?.displayName ?? "the planner";
  const deconstructorDisplayName =
    models.find((m) => m.id === deconstructorModelId)?.displayName ??
    plannerDisplayName;

  if (loading) {
    return <div className="text-sm text-neutral-400">Loading planning session…</div>;
  }

  if (!project) {
    return (
      <div className="text-sm text-neutral-400">
        No project selected. Create one from{" "}
        <button className="underline" onClick={() => {}}>
          New Project
        </button>
        .
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
          Plan — {project.name}
          <span
            className={
              "rounded px-2 py-0.5 text-[11px] " +
              (project.status === "planned"
                ? "bg-blue-900/60 text-blue-200"
                : project.status === "running"
                  ? "bg-green-900/60 text-green-300"
                  : "bg-neutral-700 text-neutral-400")
            }
          >
            {project.status}
          </span>
        </h2>
        <span className="text-[11px] text-neutral-400">
          planning cost {formatUsd(planCost)}
        </span>
      </div>

      {error && (
        <div className="rounded border border-red-800 bg-red-950/50 px-4 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {figmaIssue && (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-amber-700/70 bg-amber-950/30 p-4 text-sm text-amber-100"
        >
          <div>
            <p className="font-medium">Figma verification needs attention</p>
            <p className="mt-1 text-xs text-amber-200">{figmaIssue.message}</p>
          </div>
          <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-amber-400">Stage</dt>
              <dd>Deconstruction</dd>
            </div>
            <div>
              <dt className="text-amber-400">Model / runner</dt>
              <dd>
                {figmaIssue.model} / {figmaIssue.runner}
              </dd>
            </div>
            {figmaIssue.nodeId && (
              <div className="sm:col-span-2">
                <dt className="text-amber-400">Reference</dt>
                <dd className="break-all">node {figmaIssue.nodeId}</dd>
              </div>
            )}
          </dl>
          <div className="text-xs">
            <p className="text-amber-400">Try:</p>
            <ol className="ml-5 mt-1 list-decimal space-y-1">
              {figmaIssue.actions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ol>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => generateTable()}
              disabled={deconstructing || running}
              className="min-h-10 rounded bg-amber-600 px-4 py-2 text-xs font-medium text-neutral-950 hover:bg-amber-500 focus-visible:ring-2 focus-visible:ring-amber-300 disabled:opacity-50"
            >
              {deconstructing ? "Retrying…" : "Retry verification"}
            </button>
            <button
              type="button"
              onClick={() => generateTable("attachments")}
              disabled={
                deconstructing || running || attachments.length === 0
              }
              title={
                attachments.length === 0
                  ? "Attach at least one screenshot in planning chat first"
                  : "Use uploaded attachments without claiming live Figma verification"
              }
              className="min-h-10 rounded border border-amber-700 px-4 py-2 text-xs hover:bg-amber-900/40 focus-visible:ring-2 focus-visible:ring-amber-300 disabled:opacity-50"
            >
              Use attachments instead
            </button>
            <a
              href="#/settings"
              className="inline-flex min-h-10 items-center rounded border border-amber-700 px-4 py-2 text-xs hover:bg-amber-900/40 focus-visible:ring-2 focus-visible:ring-amber-300"
            >
              Open model settings
            </a>
          </div>
        </div>
      )}

      {verifiedFigmaReferences.length > 0 && (
        <section className="space-y-3 rounded-lg border border-violet-800/70 bg-violet-950/20 p-4">
          <div>
            <h3 className="text-sm font-medium text-violet-200">
              Verified Figma screens
            </h3>
            <p className="mt-1 text-xs text-neutral-400">
              Opened by the routed deconstructor; these exact selections are
              restored with this planning session.
            </p>
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {verifiedFigmaReferences.map((reference) => (
              <li
                key={`${reference.fileKey}:${reference.nodeId}`}
                className="min-w-0 rounded border border-violet-900/80 bg-neutral-950/50 p-3 text-xs"
              >
                <a
                  href={reference.canonicalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-violet-200 underline decoration-violet-700 underline-offset-2"
                >
                  {reference.name}
                </a>
                <p className="mt-1 break-all text-neutral-400">
                  node {reference.nodeId}
                  {reference.width && reference.height
                    ? ` · ${reference.width}×${reference.height}`
                    : ""}
                </p>
                <p className="mt-1 text-neutral-500">
                  {reference.verifiedModel} / {reference.verifiedRunner}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Committed banner ── */}
      {committed && (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-green-800 bg-green-950/20 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-green-300">
              {committed.tasks.length} tasks created
            </p>
            <p className="text-xs text-neutral-400">
              Project is planned. Use Start on the Board to run.
            </p>
          </div>
          <button
            onClick={onDone}
            className="rounded bg-green-700 px-4 py-2 text-xs font-medium text-white hover:bg-green-600"
          >
            Go to Board →
          </button>
        </div>
      )}

      {/* ── Chat panel ── */}
      {!committed && (
        <section className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <h3 className="text-sm font-medium text-neutral-300">
            Chat with {plannerDisplayName}
          </h3>

          {/* Iteration hint: project.prd is only set after a prior commit, so
              its presence means this is a follow-up planning round. */}
          {project?.prd && messages.length === 0 && (
            <div className="rounded border border-blue-900/50 bg-blue-950/20 px-3 py-2 text-xs text-blue-200">
              This project already has a plan and shipped work. Describe the
              changes or additions you want — {plannerDisplayName} reads the
              prior PRD, completed tasks, and activity log, then appends only
              the new tasks to the board.
            </div>
          )}

          <div className="max-h-96 space-y-2 overflow-y-auto rounded border border-neutral-800 bg-neutral-950 p-3">
            {messages.length === 0 && (
              <p className="text-xs text-neutral-400">
                Describe what you want to build. Refine it conversationally
                ("split that task", "add tests", "don't touch the DB"), then
                generate the task table below.
              </p>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={
                  "rounded px-3 py-2 text-xs leading-relaxed " +
                  (m.role === "user"
                    ? "bg-blue-950/40 text-blue-100"
                    : "bg-neutral-800/60 text-neutral-200")
                }
              >
                <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-400">
                  {m.role === "user" ? "You" : plannerDisplayName}
                </div>
                <div className="whitespace-pre-wrap">{m.content}</div>
              </div>
            ))}
            {chatting && (
              <div className="px-3 py-2 text-xs text-neutral-400">
                {plannerDisplayName} is thinking…
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* F27: planning-context attachments — chips seeded from GET on
              mount so they survive a reload; the planner reads these from
              context/attachments/ in the project's clone. */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((a) => (
                <span
                  key={a.name}
                  className="flex items-center gap-1.5 rounded border border-neutral-700 bg-neutral-800/60 px-2 py-1 text-[11px] text-neutral-300"
                >
                  📎 {a.name}
                  <button
                    aria-label={`Remove attachment ${a.name}`}
                    onClick={() => removeAttachment(a.name)}
                    title="Remove attachment"
                    className="text-neutral-500 hover:text-red-400"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          {running ? (
            <div className="rounded border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
              Tasks are running — planning re-opens when the run finishes. Your
              chat history stays available in "Past planning sessions" below.
            </div>
          ) : (
            <div className="space-y-1.5">
              <label
                htmlFor="planning-message"
                className="block text-xs font-medium text-neutral-300"
              >
                Planning message
              </label>
              <div className="flex items-start gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.md,.txt,.csv,.json"
                  className="hidden"
                  onChange={(e) => handleAttachFiles(e.target.files)}
                />
                <button
                  type="button"
                  aria-label="Attach planning files"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  title="Attach images, PDFs, or reference files for the planner to read"
                  className="min-h-10 shrink-0 rounded border border-neutral-700 px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
                >
                  {uploading ? "…" : "📎"}
                </button>
                <textarea
                  id="planning-message"
                  aria-describedby="planning-message-help"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      sendChat();
                    }
                  }}
                  placeholder="Describe what to build…"
                  rows={5}
                  className="min-h-28 min-w-0 flex-1 resize-y rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm leading-relaxed text-neutral-200 focus-visible:ring-2 focus-visible:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={sendChat}
                  disabled={!input.trim() || chatting}
                  className="min-h-10 shrink-0 rounded bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
                >
                  Send
                </button>
              </div>
              <p
                id="planning-message-help"
                className="text-xs text-neutral-400"
              >
                Drag the lower-right corner to resize. Ctrl/Cmd+Enter sends.
              </p>
            </div>
          )}

          {!running && messages.some((m) => m.role === "assistant") && (
            <div className="space-y-2">
              {plannerReady && !deconstructing && (
                <div className="rounded border border-green-700/50 bg-green-900/20 px-3 py-2 text-xs text-green-300">
                  {plannerDisplayName} is done planning — click below to generate the task breakdown.
                </div>
              )}
              <button
                onClick={() => generateTable()}
                disabled={deconstructing}
                className={
                  "rounded px-4 py-2 text-xs font-medium text-white disabled:opacity-50 " +
                  (plannerReady && !deconstructing
                    ? "animate-pulse bg-green-600 hover:bg-green-500"
                    : "bg-green-700 hover:bg-green-600")
                }
              >
                {deconstructing
                  ? `Deconstructing with ${deconstructorDisplayName}…`
                  : tasks
                    ? "Re-generate task table"
                    : "Generate task table →"}
              </button>
            </div>
          )}
        </section>
      )}

      {/* ── Editable task table ── */}
      {tasks && !committed && (
        <section className="space-y-4">
          {prd && (
            <details className="rounded-lg border border-neutral-800 bg-neutral-900">
              <summary className="cursor-pointer px-4 py-2 text-xs font-medium text-neutral-400 hover:text-neutral-200">
                PRD (click to expand)
              </summary>
              <pre className="max-h-60 overflow-y-auto px-4 pb-4 pt-2 font-mono text-xs leading-relaxed text-neutral-300 whitespace-pre-wrap">
                {prd}
              </pre>
            </details>
          )}

          {/* F38: generated AGENTS.md — the project-context file coding
              agents read (natively for Codex/opencode; Claude Code via a
              committed CLAUDE.md import). Editable before commit, unlike the
              read-only PRD preview above. */}
          {agentsMd && (
            <details className="rounded-lg border border-neutral-800 bg-neutral-900">
              <summary className="cursor-pointer px-4 py-2 text-xs font-medium text-neutral-400 hover:text-neutral-200">
                AGENTS.md (click to expand — edit before approving)
              </summary>
              <textarea
                aria-label="AGENTS.md draft"
                value={agentsMd}
                onChange={(e) => setAgentsMd(e.target.value)}
                rows={16}
                className="w-full resize-y border-t border-neutral-800 bg-neutral-950 px-4 py-3 font-mono text-xs leading-relaxed text-neutral-300"
              />
            </details>
          )}

          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-neutral-300">
                Tasks ({tasks.length}) — edit before approving
              </h3>
              <button
                onClick={addTask}
                className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
              >
                + Add task
              </button>
            </div>

            <div className="space-y-3">
              {tasks.map((t, idx) => (
                <div
                  key={t.key}
                  className="rounded border border-neutral-800 bg-neutral-950 p-3"
                >
                  <div className="mb-2 flex items-start gap-2">
                    <span className="mt-2 text-[11px] text-neutral-600">
                      {idx + 1}
                    </span>
                    <input
                      aria-label={`Task ${idx + 1} title`}
                      value={t.title}
                      onChange={(e) =>
                        patchTask(t.key, { title: e.target.value })
                      }
                      className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-200"
                    />
                    <button
                      aria-label={`Move ${t.title || `task ${idx + 1}`} up`}
                      onClick={() => moveTask(idx, -1)}
                      disabled={idx === 0}
                      className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      aria-label={`Move ${t.title || `task ${idx + 1}`} down`}
                      onClick={() => moveTask(idx, 1)}
                      disabled={idx === tasks.length - 1}
                      className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      aria-label={`Remove ${t.title || `task ${idx + 1}`}`}
                      onClick={() => removeTask(t.key)}
                      className="rounded border border-red-900 px-2 py-1 text-[11px] text-red-400 hover:bg-red-950/50"
                    >
                      ✕
                    </button>
                  </div>

                  <textarea
                    aria-label={`Description for ${t.title || `task ${idx + 1}`}`}
                    value={t.description}
                    onChange={(e) =>
                      patchTask(t.key, { description: e.target.value })
                    }
                    placeholder="Description"
                    rows={2}
                    className="mb-2 w-full resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300"
                  />

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                        Difficulty
                      </label>
                      <select
                        aria-label={`Difficulty for ${t.title || `task ${idx + 1}`}`}
                        value={t.difficulty}
                        onChange={(e) =>
                          patchTask(t.key, {
                            difficulty: e.target.value as Difficulty,
                          })
                        }
                        className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
                      >
                        {DIFFICULTIES.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                        Assigned model
                      </label>
                      <ModelSelect
                        ariaLabel={`Assigned model for ${t.title || "task"}`}
                        value={t.assignedModel}
                        models={models}
                        onChange={(m) =>
                          m && patchTask(t.key, { assignedModel: m })
                        }
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                        Scope paths (comma-separated globs)
                      </label>
                      <input
                        aria-label={`Scope paths for ${t.title || `task ${idx + 1}`}`}
                        value={t.scopePaths.join(", ")}
                        onChange={(e) =>
                          patchTask(t.key, {
                            scopePaths: e.target.value
                              .split(",")
                              .map((s) => s.trim()),
                          })
                        }
                        className={inputCls}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                        Acceptance criteria (one per line)
                      </label>
                      <textarea
                        aria-label={`Acceptance criteria for ${t.title || `task ${idx + 1}`}`}
                        value={t.acceptanceCriteria.join("\n")}
                        onChange={(e) =>
                          patchTask(t.key, {
                            acceptanceCriteria: e.target.value.split("\n"),
                          })
                        }
                        rows={2}
                        className="w-full resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                        Depends on
                      </label>
                      <div className="flex flex-wrap gap-2">
                        {tasks.filter((o) => o.key !== t.key).length === 0 && (
                          <span className="text-[11px] text-neutral-600">
                            (no other tasks)
                          </span>
                        )}
                        {tasks
                          .filter((o) => o.key !== t.key)
                          .map((o) => {
                            const oIdx = tasks.findIndex(
                              (x) => x.key === o.key,
                            );
                            const on = t.dependsOnKeys.includes(o.key);
                            return (
                              <label
                                key={o.key}
                                className="flex items-center gap-1 text-[11px] text-neutral-400"
                              >
                                <input
                                  type="checkbox"
                                  checked={on}
                                  onChange={(e) =>
                                    patchTask(t.key, {
                                      dependsOnKeys: e.target.checked
                                        ? [...t.dependsOnKeys, o.key]
                                        : t.dependsOnKeys.filter(
                                            (k) => k !== o.key,
                                          ),
                                    })
                                  }
                                />
                                #{oIdx + 1} {o.title.slice(0, 20)}
                              </label>
                            );
                          })}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={commit}
                disabled={committing || tasks.length === 0 || running}
                className="rounded bg-green-700 px-4 py-2 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-50"
              >
                {committing ? "Creating tasks…" : "Approve & Create Tasks"}
              </button>
              <span className="text-[11px] text-neutral-400">
                Edits are auto-saved. Tasks appear on the Board after approval.
              </span>
            </div>
          </div>
        </section>
      )}

      {/* ── Past planning sessions (read-only archive) ── */}
      {archives.length > 0 && (
        <section className="rounded-lg border border-neutral-800 bg-neutral-900">
          <div className="px-4 pt-3">
            <h3 className="text-sm font-medium text-neutral-300">
              Past planning sessions
            </h3>
            <p className="pt-1 text-[11px] text-neutral-500">
              Every planning chat for this project, kept after commit — the
              full transcript, the deconstructed task list, and when it was
              committed.
            </p>
          </div>
          <div className="space-y-1 p-3">
            {archives.map((s) => (
              <details
                key={s.name}
                className="rounded border border-neutral-800 bg-neutral-950"
              >
                <summary className="cursor-pointer px-3 py-2 text-xs text-neutral-300 hover:text-neutral-100">
                  {s.startedLabel}
                </summary>
                <pre className="max-h-96 overflow-y-auto border-t border-neutral-800 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-neutral-300">
                  {s.markdown}
                </pre>
              </details>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
