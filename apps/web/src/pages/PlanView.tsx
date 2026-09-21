import { PlanChanges } from "../components/PlanChanges";
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
  PlanningOperation,
  PlanOperationResponse,
  PlanSessionArchive,
  Project,
  RepositoryDriftDetails,
  RepositoryInspection,
  Role,
  SaveDraftResponse,
  VerifiedFigmaReference,
} from "@orc/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, api, apiUpload, isAbortError } from "../api/client";
import { ModelSelect } from "../components/ModelSelect";
import { useToast } from "../hooks/useToast";
import { useWS } from "../hooks/useWS";
import { formatUsd } from "../lib/format";
import { afterPlanningWrites, queuePlanningWrite } from "../lib/planningWrites";

import { followPlanningOperation, planningActive, planningResult } from "../lib/planningOperations";

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

function repositoryDriftDetails(value: unknown): RepositoryDriftDetails | null {
  if (!value || typeof value !== "object") return null;
  const details = value as Partial<RepositoryDriftDetails>;
  return typeof details.plannedCommit === "string" &&
    typeof details.currentCommit === "string"
    ? { plannedCommit: details.plannedCommit, currentCommit: details.currentCommit }
    : null;
}

function describeRepository(repository: RepositoryInspection): string {
  const parts = [
    repository.state === "empty"
      ? "Empty repository — the first task will scaffold it"
      : "Planning against the existing codebase",
  ];
  const where = [
    repository.branch ?? null,
    repository.commit ? `@ ${repository.commit.slice(0, 7)}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  if (where) parts.push(where);
  if (repository.stack.length > 0) parts.push(repository.stack.join(", "));
  if (repository.packageScripts && repository.packageScripts.length > 0) {
    parts.push(`npm scripts: ${repository.packageScripts.join(", ")}`);
  }
  return parts.join(" · ");
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
  saveDebounceMs = 1000,
}: {
  projectId: string;
  onDone: () => void;
  /** VW02: debounce for draft auto-save; tests shorten it. */
  saveDebounceMs?: number;
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

  // VW07: proposal scratch is editable during execution. Legacy approval
  // still waits; reviewed application uses the settled scheduler boundary.
  // Project deltas flip this live during a healthy connection; the global
  // project snapshot restores the same status after reconnect downtime.
  const running = project?.status === "running";
  const projectAuthorityRef = useRef(0);
  useWS(projectId, (e) => {
    if (e.type === "planning.updated" && e.payload.id === operationRef.current?.id) {
      setObservedOperation(e.payload);
    } else if (e.type === "project.updated" && e.payload.id === projectId) {
      projectAuthorityRef.current += 1;
      setProject(e.payload);
    } else if (e.type === "projects.snapshot") {
      const current = e.payload.projects.find((item) => item.id === projectId);
      if (current) {
        projectAuthorityRef.current += 1;
        setProject(current);
      }
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
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const versionsRef = useRef(new Map<string, number>());
  const [operation, setOperation] = useState<PlanningOperation | null>(null);
  const [operationConnection, setOperationConnection] = useState<string | null>(null);
  const [operationAction, setOperationAction] = useState(false);
  const [confirmPlanningCancel, setConfirmPlanningCancel] = useState(false);
  const operationRef = useRef<PlanningOperation | null>(null);
  const pendingOperationId = useRef<string | null>(null);
  const setObservedOperation = useCallback((value: PlanningOperation | null) => {
    operationRef.current = value;
    setOperation(value);
  }, []);

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
  // VW03: what the planner actually planned against, and a commit refused
  // because the repository moved since then (operator decides how to proceed).
  const [repository, setRepository] = useState<RepositoryInspection | null>(null);
  const [repositoryDrift, setRepositoryDrift] = useState<RepositoryDriftDetails | null>(null);
  const [deconstructing, setDeconstructing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState<PlanCommitResponse | null>(null);

  // VW02: truthful draft saving. Every operator edit bumps `editSeq`; a save
  // request carries the sequence it captured, and only an acknowledgement for
  // the newest sequence may show "Saved". `saveGenerationRef` invalidates
  // in-flight results on project change, deconstruct, commit, reload, and
  // unmount so a stale completion can never repaint state for another draft.
  const saveDraftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadGenerationRef = useRef(0);
  const [editSeq, setEditSeq] = useState(0);
  const [savedSeq, setSavedSeq] = useState(0);
  const [savesInFlight, setSavesInFlight] = useState(0);
  const [saveError, setSaveError] = useState<{
    message: string;
    stale: boolean;
  } | null>(null);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const [recoveredDraft, setRecoveredDraft] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const editSeqRef = useRef(0);
  const savedSeqRef = useRef(0);
  // Highest edit sequence a save was issued for: the auto-save never issues
  // a second request for a sequence already in flight or already failed
  // (an explicit Retry does), so an older acknowledgement cannot trigger a
  // duplicate that repaints the error state.
  const requestedSeqRef = useRef(0);
  const saveGenerationRef = useRef(0);
  // Latest rendered draft, readable from async completions and effect
  // cleanups without capturing stale closures.
  const draftRef = useRef<{
    projectId: string;
    revisionId: string | null;
    prd: string | null;
    agentsMd: string | null;
    tasks: UiTask[] | null;
    committed: boolean;
  }>({
    projectId,
    revisionId: null,
    prd: null,
    agentsMd: null,
    tasks: null,
    committed: false,
  });
  // Unsaved edits stashed per project when the operator switches projects
  // mid-save; restored only while the server still reports the same revision.
  // In-memory only, scoped to project + revision, never containing secrets.
  const unsavedDraftsRef = useRef(
    new Map<
      string,
      {
        revisionId: string;
        sessionVersion?: number;
        prd: string | null;
        agentsMd: string | null;
        tasks: UiTask[];
      }
    >(),
  );
  // VW02: a chat turn the server has not accepted yet — shown in the
  // transcript, kept with its error when the send fails, and merged into
  // `messages` only once the planner's reply arrives.
  const [pendingTurn, setPendingTurn] = useState<{
    content: string;
    error: string | null;
  } | null>(null);

  // A switch-time flush must wait for replacement: save the old edits if it
  // fails, but never overwrite a successfully generated/committed draft.
  const replacementRef = useRef<{
    projectId: string;
    settled: Promise<boolean>;
    finish: (replaced: boolean) => void;
  } | null>(null);
  function beginReplacement() {
    let finish!: (replaced: boolean) => void;
    const settled = new Promise<boolean>((resolve) => { finish = resolve; });
    const replacement = { projectId, settled, finish };
    replacementRef.current = replacement;
    return replacement;
  }

  const chatDraftRef = useRef({ projectId, input, pendingTurn, revisionId, messages });
  const chatDraftsRef = useRef(new Map<string, typeof chatDraftRef.current>());
  useEffect(() => {
    chatDraftRef.current = { projectId, input, pendingTurn, revisionId, messages };
  }, [projectId, input, pendingTurn, revisionId, messages]);

  useEffect(() => {
    draftRef.current = {
      projectId,
      revisionId,
      prd,
      agentsMd,
      tasks,
      committed: committed !== null,
    };
  }, [projectId, revisionId, prd, agentsMd, tasks, committed]);
  useEffect(() => {
    editSeqRef.current = editSeq;
  }, [editSeq]);
  useEffect(() => {
    savedSeqRef.current = savedSeq;
  }, [savedSeq]);

  const cancelScheduledSave = () => {
    if (saveDraftTimer.current) {
      clearTimeout(saveDraftTimer.current);
      saveDraftTimer.current = null;
    }
  };
  /** Drop every in-flight save result; the caller owns the next draft state. */
  const invalidateSaves = () => {
    cancelScheduledSave();
    saveGenerationRef.current += 1;
    setSavesInFlight(0);
    setSaveError(null);
  };
  const markEdited = () => setEditSeq((seq) => seq + 1);

  // ── Load session on mount / project change ──
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    // The stash Map itself is stable; a local copy keeps the cleanup honest
    // about which container it consults (react-hooks/exhaustive-deps).
    const unsavedDrafts = unsavedDraftsRef.current;
    const chatDrafts = chatDraftsRef.current;
    const versions = versionsRef.current;
    const loadGeneration = ++loadGenerationRef.current;
    setLoading(true);
    setObservedOperation(null);
    setOperationConnection(null);
    setOperationAction(false);
    setConfirmPlanningCancel(false);
    pendingOperationId.current = null;
    setCommitted(null);
    setError(null);
    setFigmaIssue(null);
    setPlannerReady(false);
    setRevisionId(null);
    // VW02: a new session owns fresh save/turn state; the previous project's
    // in-flight work was flushed or stashed by this effect's cleanup.
    if (saveDraftTimer.current) {
      clearTimeout(saveDraftTimer.current);
      saveDraftTimer.current = null;
    }
    saveGenerationRef.current += 1;
    requestedSeqRef.current = 0;
    setEditSeq(0);
    setSavedSeq(0);
    setSavesInFlight(0);
    setSaveError(null);
    setDraftNotice(null);
    setRecoveredDraft(null);
    setPendingTurn(null);
    setInput("");
    setChatting(false);
    setDeconstructing(false);
    setCommitting(false);
    setUploading(false);
    setRepository(null);
    setRepositoryDrift(null);
    const authorityAtRequest = projectAuthorityRef.current;
    const request = { params: { id: projectId }, signal: controller.signal };
    Promise.all([
      api<GetProjectResponse>("getProject", request),
      afterPlanningWrites(projectId, () => api<PlanningSessionResponse>("planSession", request)),
      api<GetSettingsResponse>("getSettings", { signal: controller.signal }),
      api<ListPlanAttachmentsResponse>("listPlanAttachments", request),
      api<ListPlanSessionArchivesResponse>("planSessionArchives", request),
    ])
      .then(([projRes, sessionRes, settingsRes, attachmentsRes, archivesRes]) => {
        if (loadGenerationRef.current !== loadGeneration) return;
        if (projectAuthorityRef.current === authorityAtRequest) {
          setProject(projRes.project ?? null);
        }
        setModels(settingsRes.settings.models);
        setPlannerModelId(settingsRes.settings.routing.planner);
        setDeconstructorModelId(
          settingsRes.settings.routing.deconstructor ??
            settingsRes.settings.routing.planner,
        );
        setArchives(archivesRes.sessions);
        // Strip [PLAN_COMPLETE] tokens from restored messages and detect readiness.
        let ready = false;
        const cleaned = sessionRes.messages.map((m) => {
          if (m.role !== "assistant") return m;
          const extracted = extractPlanComplete(m.content);
          ready = extracted.ready;
          return { ...m, content: extracted.content };
        });
        setMessages(cleaned);
        setPlannerReady(ready);
        const chatDraft = chatDrafts.get(projectId);
        chatDrafts.delete(projectId);
        if (chatDraft) {
          setInput(chatDraft.input);
          if (chatDraft.pendingTurn) {
            const accepted = sessionRes.revisionId === chatDraft.revisionId &&
              cleaned.length === chatDraft.messages.length + 2 &&
              chatDraft.messages.every((m, i) => cleaned[i]?.role === m.role && cleaned[i]?.content === m.content) &&
              cleaned[chatDraft.messages.length]?.role === "user" &&
              cleaned[chatDraft.messages.length]?.content === chatDraft.pendingTurn.content &&
              cleaned.at(-1)?.role === "assistant";
            if (accepted) {
              setPendingTurn(null);
            } else if (chatDraft.revisionId === sessionRes.revisionId) {
              setPendingTurn({ ...chatDraft.pendingTurn, error: "Check the server before retrying this interrupted turn." });
            } else {
              setInput([chatDraft.pendingTurn.content, chatDraft.input].filter(Boolean).join("\n\n"));
              setDraftNotice("The planning revision changed. Your unsent message is preserved in the composer for review.");
            }
          }
        }
        setRevisionId(sessionRes.revisionId);
        if (sessionRes.sessionVersion !== undefined) versions.set(projectId, sessionRes.sessionVersion);
        setObservedOperation(sessionRes.operation ?? null);
        if (sessionRes.operation?.error?.code === "FIGMA_VERIFICATION_FAILED") {
          setFigmaIssue(figmaFailureDetails(sessionRes.operation.error.details)?.issue ?? null);
        }
        if (sessionRes.operation && planningActive(sessionRes.operation)) {
          const active = sessionRes.operation;
          setChatting(active.kind === "chat");
          setDeconstructing(active.kind === "deconstruct");
          setPendingTurn(null);
          void followPlanningOperation(active, () => loadGenerationRef.current === loadGeneration,
            setObservedOperation, setOperationConnection).then(() => {
              if (loadGenerationRef.current === loadGeneration) setReloadNonce((n) => n + 1);
            }).catch((error) => {
              if (loadGenerationRef.current === loadGeneration && !isAbortError(error)) setError(String(error));
            });
        }
        setPlanCost(sessionRes.planCostUsd);
        setVerifiedFigmaReferences(sessionRes.verifiedFigmaReferences ?? []);
        setRepository(sessionRes.repository ?? null);
        // VW02: edits stashed when this project was left mid-save win over
        // the server copy only while the revision is unchanged; they are
        // marked unsaved so the auto-save resumes immediately.
        const stash = unsavedDrafts.get(projectId);
        unsavedDrafts.delete(projectId);
        if (stash && stash.revisionId === sessionRes.revisionId && (stash.sessionVersion === undefined || stash.sessionVersion === sessionRes.sessionVersion)) {
          setTasks(stash.tasks);
          setPrd(stash.prd);
          setAgentsMd(stash.agentsMd);
          setSavedSeq(0);
          setEditSeq(1);
        } else {
          if (stash) {
            setRecoveredDraft(JSON.stringify(stash, null, 2));
            setDraftNotice(
              "The plan changed on the server. Your conflicting edits are preserved in the recovery copy below; the current server draft is shown for review.",
            );
          }
          if (sessionRes.draftTasks && sessionRes.draftTasks.length > 0) {
            setTasks(uiTasksFromDraft(sessionRes.draftTasks));
            setPrd(sessionRes.prd ?? null);
            setAgentsMd(sessionRes.agentsMd ?? null);
          } else {
            setTasks(null);
            setPrd(null);
            setAgentsMd(null);
          }
        }
        setAttachments(attachmentsRes.attachments);
      })
      .catch((e) => {
        if (loadGenerationRef.current !== loadGeneration || isAbortError(e)) {
          return;
        }
        setError(String(e));
      })
      .finally(() => {
        if (loadGenerationRef.current === loadGeneration) setLoading(false);
      });
    return () => {
      controller.abort();
      loadGenerationRef.current += 1;
      const chatDraft = chatDraftRef.current;
      if (chatDraft.projectId === projectId) chatDrafts.set(projectId, chatDraft);
      // VW02: leaving this project (switch, reload, unmount) must not lose
      // edits the server has not acknowledged. Invalidate in-flight results
      // for the UI, stash the draft for a return visit, and flush one final
      // save whose outcome only decides whether the stash is still needed.
      if (saveDraftTimer.current) {
        clearTimeout(saveDraftTimer.current);
        saveDraftTimer.current = null;
      }
      saveGenerationRef.current += 1;
      const draft = draftRef.current;
      if (
        draft.projectId === projectId &&
        draft.revisionId &&
        draft.tasks &&
        !draft.committed &&
        editSeqRef.current > savedSeqRef.current
      ) {
        const stash = {
          revisionId: draft.revisionId,
          sessionVersion: versions.get(draft.projectId),
          prd: draft.prd,
          agentsMd: draft.agentsMd,
          tasks: draft.tasks,
        };
        unsavedDrafts.set(projectId, stash);
        const replacement = replacementRef.current?.projectId === projectId ? replacementRef.current : null;
        queuePlanningWrite(projectId, async () => {
          if (replacement && await replacement.settled) return;
          const saved = await api<SaveDraftResponse>("planSaveDraft", {
            params: { id: projectId },
            body: {
              revisionId: stash.revisionId,
              sessionVersion: versions.get(projectId),
              prdMarkdown: stash.prd ?? "",
              tasks: draftTasksFromUi(stash.tasks),
              agentsMd: stash.agentsMd ?? "",
            },
          });
          if (saved.sessionVersion !== undefined) versions.set(projectId, saved.sessionVersion);
          return saved;
        })
          .then(() => {
            if (unsavedDrafts.get(projectId) === stash) {
              unsavedDrafts.delete(projectId);
            }
          })
          .catch(() => {
            // Kept in the stash: restored and retried when the project is
            // reopened, or reported there if the revision has moved on.
          });
      }
    };
  }, [projectId, reloadNonce, setObservedOperation]);

  // F27: upload from the hidden file input; errors surface as a toast
  // rather than the page-level error banner, since a failed attachment
  // shouldn't block the chat itself.
  async function handleAttachFiles(files: FileList | null) {
    if (!projectId || !files || files.length === 0) return;
    const generation = loadGenerationRef.current;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const res = await apiUpload<ListPlanAttachmentsResponse>(
          "uploadPlanAttachment",
          { params: { id: projectId }, file },
        );
        if (loadGenerationRef.current !== generation) return;
        setAttachments(res.attachments);
      }
    } catch (e) {
      if (loadGenerationRef.current === generation) toast(String(e), "error");
    } finally {
      if (loadGenerationRef.current === generation) {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    }
  }

  async function removeAttachment(name: string) {
    if (!projectId) return;
    const generation = loadGenerationRef.current;
    try {
      const res = await api<ListPlanAttachmentsResponse>("deletePlanAttachment", {
        params: { id: projectId, name },
      });
      if (loadGenerationRef.current === generation) setAttachments(res.attachments);
    } catch (e) {
      if (loadGenerationRef.current === generation) toast(String(e), "error");
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
  }, [messages, chatting, pendingTurn]);

  // VW02: one draft save for edit sequence `seq`, built from the latest
  // rendered draft. Completions are ignored once the generation moved on;
  // a failure for a draft older than an acknowledged one is moot.
  const performSave = useCallback((seq: number) => {
    const draft = draftRef.current;
    if (!draft.projectId || !draft.revisionId || !draft.tasks || draft.committed) {
      return;
    }
    const draftTasks = draftTasksFromUi(draft.tasks);
    const generation = saveGenerationRef.current;
    requestedSeqRef.current = Math.max(requestedSeqRef.current, seq);
    setSavesInFlight((count) => count + 1);
    setSaveError(null);
    queuePlanningWrite(draft.projectId, async () => {
      if (generation !== saveGenerationRef.current) return;
      const saved = await api<SaveDraftResponse>("planSaveDraft", {
        params: { id: draft.projectId },
        body: {
          revisionId: draft.revisionId,
          sessionVersion: versionsRef.current.get(draft.projectId),
          prdMarkdown: draft.prd ?? "",
          tasks: draftTasks,
          agentsMd: draft.agentsMd ?? "",
        },
      });
      if (saved.sessionVersion !== undefined) versionsRef.current.set(draft.projectId, saved.sessionVersion);
      return saved;
    })
      .then(() => {
        if (generation !== saveGenerationRef.current) return;
        setSavedSeq((prev) => Math.max(prev, seq));
        setSaveError(null);
      })
      .catch((e: unknown) => {
        if (generation !== saveGenerationRef.current) return;
        if (seq < savedSeqRef.current) return;
        setSaveError({
          message: e instanceof Error ? e.message : String(e),
          stale: e instanceof ApiRequestError && e.status === 409,
        });
      })
      .finally(() => {
        if (generation !== saveGenerationRef.current) return;
        setSavesInFlight((count) => Math.max(0, count - 1));
      });
  }, []);

  // Debounced auto-save of operator edits only (loads and deconstruction
  // results are already persisted server-side and never mark the draft dirty).
  useEffect(() => {
    if (loading || deconstructing || committing || committed || !tasks || !revisionId || editSeq <= savedSeq) return;
    if (editSeq <= requestedSeqRef.current) return;
    if (saveDraftTimer.current) clearTimeout(saveDraftTimer.current);
    saveDraftTimer.current = setTimeout(() => {
      saveDraftTimer.current = null;
      performSave(editSeq);
    }, saveDebounceMs);
    return () => {
      if (saveDraftTimer.current) {
        clearTimeout(saveDraftTimer.current);
        saveDraftTimer.current = null;
      }
    };
  }, [editSeq, savedSeq, committed, tasks, revisionId, saveDebounceMs, performSave, loading, deconstructing, committing]);

  const unsavedEdits = tasks !== null && !committed && editSeq > savedSeq;
  // A reload or tab close would discard an unsent turn or unsaved edits; the
  // browser's own prompt covers what in-app navigation (this view stays
  // mounted across tabs) does not.
  const unsavedWork = input.trim() !== "" || pendingTurn !== null || savesInFlight > 0 || unsavedEdits;
  useEffect(() => {
    if (!unsavedWork) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [unsavedWork]);

  const saveStatusLabel = saveError
    ? "Save failed"
    : savesInFlight > 0
      ? "Saving…"
      : unsavedEdits
        ? "Unsaved changes"
        : savedSeq > 0
          ? "Saved"
          : "Edits are saved automatically.";

  /** Send one user turn. The accepted transcript (`messages`) changes only
   *  when the planner replies; a failure keeps the turn visible with its
   *  error and leaves the composer untouched. */
  async function observeResult<T extends PlanChatResponse | PlanDeconstructResponse>(
    response: T | PlanOperationResponse, generation: number,
  ): Promise<T> {
    if (loadGenerationRef.current !== generation) throw new DOMException("View changed", "AbortError");
    if (!("operation" in response)) return response; // older synchronous server
    const terminal = await followPlanningOperation(response.operation,
      () => loadGenerationRef.current === generation, setObservedOperation, setOperationConnection);
    const result = planningResult(terminal) as T;
    if (result.sessionVersion !== undefined) versionsRef.current.set(terminal.projectId, result.sessionVersion);
    return result;
  }

  async function submitTurn(text: string, revision: string | null = revisionId) {
    if (!projectId || !revision) return;
    const generation = loadGenerationRef.current;
    const next: PlanChatMessage[] = [...messages, { role: "user", content: text }];
    setPendingTurn({ content: text, error: null });
    setChatting(true);
    setError(null);
    setPlannerReady(false); // reset until the planner confirms again
    try {
      pendingOperationId.current ??= crypto.randomUUID();
      const accepted = await queuePlanningWrite(projectId, () => api<PlanChatResponse | PlanOperationResponse>("planChat", {
        params: { id: projectId },
        body: { revisionId: revision, messages: next, sessionVersion: versionsRef.current.get(projectId), operationId: pendingOperationId.current, background: true, proposal: true },
      }));
      const res = await observeResult<PlanChatResponse>(accepted, generation);
      pendingOperationId.current = null;
      if (loadGenerationRef.current !== generation) return;
      const { content, ready } = extractPlanComplete(res.reply);
      if (ready) setPlannerReady(true);
      setMessages([...next, { role: "assistant", content }]);
      setPendingTurn(null);
      setPlanCost((c) => c + res.costUsd);
      if (res.repository && !draftRef.current.tasks) setRepository(res.repository);
    } catch (e) {
      if (loadGenerationRef.current !== generation) return;
      setPendingTurn({
        content: text,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (loadGenerationRef.current === generation) setChatting(false);
    }
  }

  function sendChat() {
    const text = input.trim();
    if (!projectId || !revisionId || !text || chatting || deconstructing || committing || pendingTurn) {
      return;
    }
    setInput("");
    void submitTurn(text);
  }

  /** Retry a failed turn. Reconcile with the server first: a lost response
   *  may mean the turn was already accepted, in which case the server's
   *  transcript is adopted instead of sending the same turn twice. */
  async function retrySend() {
    if (!pendingTurn || !projectId || chatting || deconstructing || committing) return;
    const turn = pendingTurn.content;
    const generation = loadGenerationRef.current;
    setPendingTurn({ content: turn, error: null });
    setChatting(true);
    try {
      const session = await api<PlanningSessionResponse>("planSession", {
        params: { id: projectId },
      });
      if (loadGenerationRef.current !== generation) return;
      if (session.revisionId !== revisionId) {
        throw new Error("The planning revision changed. Edit or copy this message, then reload the session before sending it.");
      }
      if (session.operation && session.operation.id === pendingOperationId.current) {
        const known = session.operation;
        const accepted = planningActive(known) || known.state === "succeeded"
          ? { operation: known }
          : await api<PlanOperationResponse>("planOperationRetry", { params: { id: projectId, operationId: known.id } });
        await observeResult<PlanChatResponse>(accepted, generation);
        setPendingTurn(null);
        pendingOperationId.current = null;
        setChatting(false);
        setReloadNonce((n) => n + 1);
        return;
      }
      if (session.sessionVersion !== undefined) versionsRef.current.set(projectId, session.sessionVersion);
      const server = session.messages;
      const sameHistory = messages.every((m, i) =>
        server[i]?.role === m.role &&
        (m.role === "assistant" ? extractPlanComplete(server[i]!.content).content : server[i]?.content) === m.content,
      );
      const acceptedOnServer =
        server.length === messages.length + 2 &&
        sameHistory &&
        server[messages.length]?.role === "user" &&
        server[messages.length]?.content === turn &&
        server[server.length - 1]?.role === "assistant";
      if (acceptedOnServer) {
        let ready = false;
        const cleaned = server.map((m) => {
          if (m.role !== "user") {
            const extracted = extractPlanComplete(m.content);
            ready = extracted.ready;
            return { ...m, content: extracted.content };
          }
          return m;
        });
        setMessages(cleaned);
        setPlannerReady(ready);
        setRevisionId(session.revisionId);
        setPlanCost(session.planCostUsd);
        if (session.repository) setRepository(session.repository);
        setPendingTurn(null);
        setChatting(false);
        return;
      }
      if (!sameHistory || server.length !== messages.length) {
        throw new Error("The conversation changed on the server. Edit or copy this message, then reload the session before sending it.");
      }
    } catch (e) {
      if (loadGenerationRef.current !== generation) return;
      setPendingTurn({ content: turn, error: e instanceof Error ? e.message : String(e) });
      setChatting(false);
      return;
    }
    if (loadGenerationRef.current !== generation) return;
    setChatting(false);
    await submitTurn(turn);
  }

  /** Move a failed turn back into the composer without clobbering anything
   *  typed since the send. */
  function editFailedTurn() {
    if (!pendingTurn) return;
    const failed = pendingTurn.content;
    setInput((current) => (current.trim() ? `${failed}\n\n${current}` : failed));
    setPendingTurn(null);
    pendingOperationId.current = null;
  }

  async function generateTable(
    figmaVerification: "live" | "attachments" = "live",
  ) {
    if (!projectId || !revisionId || deconstructing || committing || chatting) return;
    const generation = loadGenerationRef.current;
    const replacement = beginReplacement();
    let replaced = false;
    setDeconstructing(true);
    setError(null);
    // The server persists the new draft itself; an older pending save must
    // not land afterwards and overwrite it.
    invalidateSaves();
    try {
      const accepted = await queuePlanningWrite(projectId, async () => {
        if (loadGenerationRef.current !== generation) return;
        // Persist the current visible draft before replacing it, so cancellation
        // or restart recovers those edits rather than the older server copy.
        if (tasks && editSeqRef.current > savedSeqRef.current) {
          const saved = await api<SaveDraftResponse>("planSaveDraft", { params: { id: projectId }, body: {
            revisionId, sessionVersion: versionsRef.current.get(projectId), prdMarkdown: prd ?? "",
            tasks: draftTasksFromUi(tasks), agentsMd: agentsMd ?? "",
          } });
          if (saved.sessionVersion !== undefined) versionsRef.current.set(projectId, saved.sessionVersion);
          setSavedSeq(editSeqRef.current);
          savedSeqRef.current = editSeqRef.current;
        }
        return api<PlanDeconstructResponse | PlanOperationResponse>("planDeconstruct", {
          params: { id: projectId },
          body: {
            revisionId,
            messages,
            sessionVersion: versionsRef.current.get(projectId),
            operationId: crypto.randomUUID(),
            background: true, proposal: true,
            ...(figmaVerification === "attachments"
              ? { figmaVerification }
              : {}),
          },
        });
      });
      const res = accepted ? await observeResult<PlanDeconstructResponse>(accepted, generation) : undefined;
      replaced = res !== undefined;
      if (!res || loadGenerationRef.current !== generation) return;
      setPlanCost((c) => c + res.costUsd);
      setPrd(res.prdMarkdown);
      setAgentsMd(res.agentsMd ?? null);
      setTasks(uiTasksFromDraft(res.tasks));
      setSavedSeq((prev) => Math.max(prev, editSeqRef.current));
      setVerifiedFigmaReferences(res.verifiedFigmaReferences ?? []);
      setFigmaIssue(null);
      if (res.repository) setRepository(res.repository);
      setRepositoryDrift(null);
    } catch (e) {
      if (loadGenerationRef.current !== generation) return;
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
      replacement.finish(replaced);
      if (replacementRef.current === replacement) replacementRef.current = null;
      if (loadGenerationRef.current === generation) {
        setDeconstructing(false);
        if (!replaced && editSeqRef.current > savedSeqRef.current) performSave(editSeqRef.current);
      }
    }
  }

  async function operationActionRequest(action: "retry" | "cancel") {
    if (!operation || operationAction) return;
    const generation = loadGenerationRef.current;
    setOperationAction(true);
    setError(null);
    try {
      const response = await api<PlanOperationResponse>(action === "retry" ? "planOperationRetry" : "planOperationCancel", {
        params: { id: projectId, operationId: operation.id },
      });
      if (generation !== loadGenerationRef.current) return;
      setObservedOperation(response.operation);
      setPendingTurn(null);
      setReloadNonce((n) => n + 1);
    } catch (error) {
      if (generation === loadGenerationRef.current) setError(String(error));
    } finally {
      if (generation === loadGenerationRef.current) setOperationAction(false);
    }
  }

  function patchTask(key: string, patch: Partial<UiTask>) {
    markEdited();
    setTasks((ts) =>
      ts ? ts.map((t) => (t.key === key ? { ...t, ...patch } : t)) : ts,
    );
  }

  function removeTask(key: string) {
    markEdited();
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
    markEdited();
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
    markEdited();
    setTasks((ts) => {
      if (!ts) return ts;
      const j = idx + dir;
      if (j < 0 || j >= ts.length) return ts;
      const copy = [...ts];
      [copy[idx], copy[j]] = [copy[j]!, copy[idx]!];
      return copy;
    });
  }

  async function commit(acknowledgeRepositoryDrift = false) {
    if (!projectId || !revisionId || !tasks || tasks.length === 0 || committing || deconstructing || chatting || running) return;
    const generation = loadGenerationRef.current;
    const replacement = beginReplacement();
    let replaced = false;
    setCommitting(true);
    setError(null);
    setRepositoryDrift(null);
    // The commit body is the exact visible draft; a save still in flight
    // settles before approval and cannot repaint state afterwards.
    invalidateSaves();
    try {
      const res = await queuePlanningWrite(projectId, async () => {
        if (loadGenerationRef.current !== generation) return;
        return api<PlanCommitResponse>("planCommit", {
          params: { id: projectId },
          body: {
            revisionId,
            sessionVersion: versionsRef.current.get(projectId),
            prdMarkdown: prd ?? "",
            tasks: draftTasksFromUi(tasks),
            agentsMd: agentsMd ?? "",
            ...(acknowledgeRepositoryDrift ? { acknowledgeRepositoryDrift: true } : {}),
          },
        });
      });
      replaced = res !== undefined;
      if (!res || loadGenerationRef.current !== generation) return;
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
        .then((r) => {
          if (loadGenerationRef.current === generation) setArchives(r.sessions);
        })
        .catch(() => {});
    } catch (e) {
      if (loadGenerationRef.current !== generation) return;
      const drift =
        e instanceof ApiRequestError && e.code === "REPOSITORY_DRIFT"
          ? repositoryDriftDetails(e.details)
          : null;
      if (drift) {
        // Refused, not failed: the operator decides between re-planning
        // against the current code and applying the draft as written.
        setRepositoryDrift(drift);
      } else {
        setError(String(e));
      }
      // The draft is still on screen; resume saving it if edits were unsaved.
      if (editSeqRef.current > savedSeqRef.current) performSave(editSeqRef.current);
    } finally {
      replacement.finish(replaced);
      if (replacementRef.current === replacement) replacementRef.current = null;
      if (loadGenerationRef.current === generation) setCommitting(false);
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
        <a
          href="#/new-project"
          className="underline focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          New Project
        </a>
        .
      </div>
    );
  }

  return (
    <div className="max-w-[1440px] space-y-6">
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

      {repository && !committed && (
        <p
          data-testid="repository-inspection"
          className="text-[11px] text-neutral-400"
          title={`Inspected ${repository.inspectedAt}`}
        >
          {describeRepository(repository)}
        </p>
      )}

      {repositoryDrift && (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-amber-700/70 bg-amber-950/30 p-4 text-sm text-amber-100"
        >
          <div>
            <p className="font-medium">The repository changed since this plan was drafted</p>
            <p className="mt-1 text-xs text-amber-200">
              Planned against {repositoryDrift.plannedCommit.slice(0, 7)}; the clone is now at{" "}
              {repositoryDrift.currentCommit.slice(0, 7)}. Nothing was committed. Re-generate the
              task table against the current code, or approve anyway to apply the draft exactly as
              shown.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => generateTable()}
              disabled={deconstructing || committing || chatting || running}
              className="min-h-10 rounded bg-amber-600 px-4 py-2 text-xs font-medium text-neutral-950 hover:bg-amber-500 focus-visible:ring-2 focus-visible:ring-amber-300 disabled:opacity-50"
            >
              {deconstructing ? "Re-generating…" : "Re-generate task table"}
            </button>
            <button
              type="button"
              onClick={() => void commit(true)}
              disabled={deconstructing || committing || chatting || running}
              className="min-h-10 rounded border border-amber-700 px-4 py-2 text-xs hover:bg-amber-900/40 focus-visible:ring-2 focus-visible:ring-amber-300 disabled:opacity-50"
            >
              {committing ? "Creating tasks…" : "Approve anyway"}
            </button>
          </div>
        </div>
      )}

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
              disabled={deconstructing || committing}
              className="min-h-10 rounded bg-amber-600 px-4 py-2 text-xs font-medium text-neutral-950 hover:bg-amber-500 focus-visible:ring-2 focus-visible:ring-amber-300 disabled:opacity-50"
            >
              {deconstructing ? "Retrying…" : "Retry verification"}
            </button>
            <button
              type="button"
              onClick={() => generateTable("attachments")}
              disabled={
                deconstructing || committing || attachments.length === 0
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
              {committed.project.status === "paused" ? "Plan changes applied" : `${committed.tasks.length} tasks created`}
            </p>
            <p className="text-xs text-neutral-400">
              {committed.project.status === "paused" ? "Project remains paused. Resume on the Board when ready." : "Project is planned. Use Start on the Board to run."}
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

      {recoveredDraft && (
        <details className="rounded border border-amber-800 bg-amber-950/20 p-3 text-sm">
          <summary className="cursor-pointer py-2">Recovered conflicting edits — copy before continuing</summary>
          <textarea aria-label="Recovered planning edits" readOnly rows={8} value={recoveredDraft} className="mt-2 w-full rounded border border-neutral-700 bg-neutral-950 p-3 font-mono text-xs" />
        </details>
      )}
      {operation && !committed && (
        <section aria-label="Planning operation" className="space-y-2 rounded-lg border border-neutral-700 bg-neutral-900 p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="status" className="font-medium text-neutral-200">
              {operation.kind === "chat" ? "Planning reply" : "Task generation"}: {operation.state}
            </p>
            {planningActive(operation) ? (
              <button type="button" disabled={operationAction || operation.state === "cancelling"} onClick={() => setConfirmPlanningCancel(true)} className="min-h-10 rounded border border-neutral-600 px-3 py-2 disabled:opacity-50">
                {operationAction || operation.state === "cancelling" ? "Stopping planning…" : "Cancel planning"}
              </button>
            ) : operation.state !== "succeeded" && (
              <button type="button" disabled={operationAction || chatting || deconstructing} onClick={() => void operationActionRequest("retry")} className="min-h-10 rounded border border-neutral-600 px-3 py-2 disabled:opacity-50">
                {operationAction ? "Starting retry…" : "Retry planning"}
              </button>
            )}
          </div>
          {confirmPlanningCancel && planningActive(operation) && (
            <div className="space-y-2 rounded border border-amber-800 p-3">
              <p>Cancel this planning attempt? Your saved draft stays intact; any usage already incurred is retained.</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={operationAction || operation.state === "cancelling"} onClick={() => void operationActionRequest("cancel")} className="min-h-10 rounded bg-amber-900 px-3 py-2 disabled:opacity-50">Confirm cancellation</button>
                <button type="button" disabled={operationAction} onClick={() => setConfirmPlanningCancel(false)} className="min-h-10 rounded border border-neutral-600 px-3 py-2">Keep planning</button>
              </div>
            </div>
          )}
          {planningActive(operation) && <p className="text-xs text-neutral-400">Work continues on the server when you leave this page. Reopen Plan to follow its progress.</p>}
          {operationConnection && <p role="alert" className="text-amber-300">{operationConnection}</p>}
          {operation.error && <p className="break-words text-amber-300">{operation.error.message}</p>}
          {["failed", "interrupted", "cancelled"].includes(operation.state) && <p className="text-xs text-neutral-400">Retry starts a new model attempt and may use additional credits or subscription capacity. Your last saved draft is kept.</p>}
          <details className="text-xs text-neutral-400">
            <summary className="cursor-pointer py-2">Requested work · {operation.invocationIds.length} model calls</summary>
            <p className="mt-2 whitespace-pre-wrap break-words">{operation.input.messages.at(-1)?.content}</p>
          </details>
        </section>
      )}

      <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
      {/* ── Chat panel ── */}
      {!committed && (
        <section className="min-w-0 space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
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
                generate the task outline for review.
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
            {pendingTurn && (
              <div
                data-testid="pending-turn"
                className={
                  "rounded px-3 py-2 text-xs leading-relaxed " +
                  (pendingTurn.error
                    ? "border border-red-800 bg-red-950/40 text-red-100"
                    : "bg-blue-950/40 text-blue-100 opacity-80")
                }
              >
                <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-400">
                  You{pendingTurn.error ? " — not sent" : " — sending…"}
                </div>
                <div className="whitespace-pre-wrap">{pendingTurn.content}</div>
                {pendingTurn.error && (
                  <div role="alert" className="mt-2 space-y-2">
                    <p className="text-red-300">Send failed: {pendingTurn.error}</p>
                    <p className="text-red-200/80">
                      Your message and chat history are kept. Retry sends it
                      again, or edit it in the composer below.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void retrySend()}
                        disabled={chatting || deconstructing || committing}
                        className="min-h-10 rounded bg-red-700 px-3 py-2 text-xs font-medium text-white hover:bg-red-600 focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-50"
                      >
                        Retry send
                      </button>
                      <button
                        type="button"
                        onClick={editFailedTurn}
                        disabled={chatting}
                        className="min-h-10 rounded border border-neutral-600 px-3 py-2 text-xs text-neutral-200 hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
                      >
                        Edit message
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
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
                    disabled={chatting || deconstructing || committing}
                    title="Remove attachment"
                    className="min-h-10 min-w-10 rounded text-neutral-500 hover:text-red-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-300 disabled:opacity-50"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          {running && <p className="rounded border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
            Work is running. Draft a separate proposal here; review and apply it after active work settles. Accepted tasks stay unchanged.
          </p>}
          {(
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
                  disabled={uploading || chatting || deconstructing || committing}
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
                  disabled={!input.trim() || chatting || deconstructing || committing || pendingTurn !== null}
                  title={
                    pendingTurn?.error
                      ? "Retry or edit the failed message first"
                      : undefined
                  }
                  className="min-h-10 shrink-0 rounded bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"
                >
                  Send
                </button>
              </div>
              <p
                id="planning-message-help"
                className="text-xs text-neutral-400"
              >
                {pendingTurn?.error
                  ? "Retry or edit the failed message above before sending another. "
                  : ""}
                Drag the lower-right corner to resize. Ctrl/Cmd+Enter sends.
              </p>
            </div>
          )}

          {messages.some((m) => m.role === "assistant") && (
            <div className="space-y-2">
              {plannerReady && !deconstructing && (
                <div className="rounded border border-green-700/50 bg-green-900/20 px-3 py-2 text-xs text-green-300">
                  {plannerDisplayName} is done planning — click below to generate the task breakdown.
                </div>
              )}
              <button
                onClick={() => generateTable()}
                disabled={deconstructing || committing || chatting}
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
        <div className="min-w-0 space-y-4">
        <fieldset disabled={deconstructing || committing || chatting} className="min-w-0 space-y-4">
          <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <h3 className="mb-2 text-sm font-medium text-neutral-300">Brief</h3>
            <textarea aria-label="Planning brief" value={prd ?? ""} onChange={(event) => { markEdited(); setPrd(event.target.value); }} rows={8}
              className="w-full resize-y rounded border border-neutral-700 bg-neutral-950 p-3 text-sm leading-relaxed text-neutral-200" />
          </section>

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
                onChange={(e) => {
                  markEdited();
                  setAgentsMd(e.target.value);
                }}
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
                onClick={() => void commit()}
                disabled={committing || chatting || tasks.length === 0 || running}
                className="rounded bg-green-700 px-4 py-2 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-50"
              >
                {committing ? "Creating tasks…" : "Approve & Create Tasks"}
              </button>
              <span
                role="status"
                aria-live="polite"
                data-testid="draft-save-status"
                className={
                  "text-[11px] " +
                  (saveError
                    ? "text-red-300"
                    : unsavedEdits || savesInFlight > 0
                      ? "text-amber-300"
                      : "text-neutral-400")
                }
              >
                {saveStatusLabel}
              </span>
              <span className="text-[11px] text-neutral-400">
                Tasks appear on the Board after approval.
              </span>
            </div>
            {saveError && (
              <div
                role="alert"
                className="mt-3 flex flex-wrap items-center gap-2 rounded border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-200"
              >
                <span className="min-w-0 flex-1">
                  Draft save failed: {saveError.message}{" "}
                  {saveError.stale
                    ? "Reload the session to continue from the server's copy; your current edits stay on screen until you do."
                    : "Your edits are kept on screen; retry the save, or approve to create tasks from exactly what you see."}
                </span>
                <button
                  type="button"
                  onClick={() => performSave(editSeqRef.current)}
                  disabled={savesInFlight > 0}
                  className="min-h-10 rounded bg-red-700 px-3 py-2 text-xs font-medium text-white hover:bg-red-600 focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-50"
                >
                  Retry save
                </button>
                {saveError.stale && (
                  <button
                    type="button"
                    onClick={() => setReloadNonce((nonce) => nonce + 1)}
                    className="min-h-10 rounded border border-red-700 px-3 py-2 text-xs hover:bg-red-900/40 focus-visible:ring-2 focus-visible:ring-red-400"
                  >
                    Reload session
                  </button>
                )}
              </div>
            )}
            {draftNotice && (
              <p
                role="status"
                className="mt-3 rounded border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-200"
              >
                {draftNotice}
              </p>
            )}
          </div>
        </fieldset>
        <PlanChanges key={projectId} projectId={projectId} draftTitles={tasks.map((t) => t.title)}
          disabled={chatting || deconstructing} onApplying={setCommitting}
          prepareDraft={async () => {
            if (!revisionId) throw new Error("Reload the planning session first.");
            return queuePlanningWrite(projectId, async () => {
              const draft = { revisionId, prdMarkdown: prd ?? "", tasks: draftTasksFromUi(tasks), agentsMd: agentsMd ?? "" };
              const saved = await api<SaveDraftResponse>("planSaveDraft", { params: { id: projectId }, body: {
                ...draft, sessionVersion: versionsRef.current.get(projectId),
              } });
              if (saved.sessionVersion !== undefined) versionsRef.current.set(projectId, saved.sessionVersion);
              savedSeqRef.current = editSeqRef.current; setSavedSeq(editSeqRef.current);
              return { ...draft, sessionVersion: versionsRef.current.get(projectId) ?? 0,
                tasks: draft.tasks.map((t) => ({ ...t, existingDependsOn: [] })) };
            });
          }}
          onApplied={(result) => { setCommitted(result); setProject(result.project); setTasks(null); setAgentsMd(null); setVerifiedFigmaReferences([]); }} />
        </div>

      )}

      {!tasks && !committed && (
        <section className="min-w-0 rounded-lg border border-dashed border-neutral-700 p-5 text-sm text-neutral-400">
          <h3 className="font-medium text-neutral-200">Brief and task outline</h3>
          <p className="mt-2">Discuss the outcome and constraints, then generate a draft. The brief, instructions, and tasks appear here for review before approval.</p>
        </section>
      )}
      </div>

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
