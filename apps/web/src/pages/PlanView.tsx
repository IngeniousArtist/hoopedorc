import type {
  Difficulty,
  DraftTask,
  GetProjectResponse,
  GetSettingsResponse,
  ModelConfig,
  ModelId,
  PlanChatMessage,
  PlanChatResponse,
  PlanCommitResponse,
  PlanDeconstructResponse,
  PlanningSessionResponse,
  Project,
} from "@orc/types";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { ModelSelect } from "../components/ModelSelect";

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

/** UI-side draft task: deps tracked by stable UUID key, not array index. */
interface UiTask {
  key: string;
  title: string;
  description: string;
  difficulty: Difficulty;
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

function uiTasksFromDraft(drafts: DraftTask[]): UiTask[] {
  const keys: string[] = drafts.map(() => newKey());
  return drafts.map((t, i) => ({
    key: keys[i]!,
    title: t.title,
    description: t.description,
    difficulty: t.difficulty,
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Chat
  const [messages, setMessages] = useState<PlanChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [chatting, setChatting] = useState(false);
  const [planCost, setPlanCost] = useState(0);
  const [plannerReady, setPlannerReady] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Draft plan
  const [prd, setPrd] = useState<string | null>(null);
  const [tasks, setTasks] = useState<UiTask[] | null>(null);
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
    setPlannerReady(false);
    Promise.all([
      api<GetProjectResponse>("getProject", { params: { id: projectId } }),
      api<PlanningSessionResponse>("planSession", { params: { id: projectId } }),
      api<GetSettingsResponse>("getSettings"),
    ])
      .then(([projRes, sessionRes, settingsRes]) => {
        setProject(projRes.project ?? null);
        setModels(settingsRes.settings.models);
        // Strip [PLAN_COMPLETE] tokens from restored messages and detect readiness.
        const cleaned = sessionRes.messages.map((m) => {
          if (m.role !== "assistant") return m;
          const { content, ready } = extractPlanComplete(m.content);
          if (ready) setPlannerReady(true);
          return { ...m, content };
        });
        setMessages(cleaned);
        setPlanCost(sessionRes.planCostUsd);
        if (sessionRes.draftTasks && sessionRes.draftTasks.length > 0) {
          setTasks(uiTasksFromDraft(sessionRes.draftTasks));
          setPrd(sessionRes.prd ?? null);
        } else {
          setTasks(null);
          setPrd(null);
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [projectId]);

  // Scroll chat to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, chatting]);

  // Auto-save draft tasks whenever they change (debounced)
  useEffect(() => {
    if (!tasks || committed || !projectId) return;
    if (saveDraftTimer.current) clearTimeout(saveDraftTimer.current);
    saveDraftTimer.current = setTimeout(() => {
      api("planSaveDraft", {
        params: { id: projectId },
        body: { prdMarkdown: prd ?? "", tasks: draftTasksFromUi(tasks) },
      }).catch(() => {});
    }, 1000);
    return () => {
      if (saveDraftTimer.current) clearTimeout(saveDraftTimer.current);
    };
  }, [tasks, prd, committed, projectId]);

  async function sendChat() {
    if (!projectId || !input.trim() || chatting) return;
    const next: PlanChatMessage[] = [
      ...messages,
      { role: "user", content: input.trim() },
    ];
    setMessages(next);
    setInput("");
    setChatting(true);
    setError(null);
    setPlannerReady(false); // reset until Claude confirms again
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

  async function generateTable() {
    if (!projectId || deconstructing) return;
    setDeconstructing(true);
    setError(null);
    try {
      const res = await api<PlanDeconstructResponse>("planDeconstruct", {
        params: { id: projectId },
        body: { messages },
      });
      setPlanCost((c) => c + res.costUsd);
      setPrd(res.prdMarkdown);
      setTasks(uiTasksFromDraft(res.tasks));
    } catch (e) {
      setError(String(e));
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
        body: { prdMarkdown: prd ?? "", tasks: draftTasksFromUi(tasks) },
      });
      setCommitted(res);
      setTasks(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setCommitting(false);
    }
  }

  const inputCls =
    "w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200";

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
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          Plan — {project.name}
          <span
            className={
              "ml-3 rounded px-2 py-0.5 text-[11px] " +
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
          planning cost ${planCost.toFixed(4)}
        </span>
      </div>

      {error && (
        <div className="rounded border border-red-800 bg-red-950/50 px-4 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* ── Committed banner ── */}
      {committed && (
        <div className="flex items-center justify-between rounded-lg border border-green-800 bg-green-950/20 p-4">
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
            Chat with Claude
          </h3>

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
                  {m.role === "user" ? "You" : "Claude"}
                </div>
                <div className="whitespace-pre-wrap">{m.content}</div>
              </div>
            ))}
            {chatting && (
              <div className="px-3 py-2 text-xs text-neutral-400">
                Claude is thinking…
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  sendChat();
                }
              }}
              placeholder="Describe what to build… (Cmd+Enter to send)"
              rows={2}
              className={inputCls + " resize-none"}
            />
            <button
              onClick={sendChat}
              disabled={!input.trim() || chatting}
              className="shrink-0 rounded bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              Send
            </button>
          </div>

          {messages.some((m) => m.role === "assistant") && (
            <div className="space-y-2">
              {plannerReady && !deconstructing && (
                <div className="rounded border border-green-700/50 bg-green-900/20 px-3 py-2 text-xs text-green-300">
                  Claude is done planning — click below to generate the task breakdown.
                </div>
              )}
              <button
                onClick={generateTable}
                disabled={deconstructing}
                className={
                  "rounded px-4 py-2 text-xs font-medium text-white disabled:opacity-50 " +
                  (plannerReady && !deconstructing
                    ? "animate-pulse bg-green-600 hover:bg-green-500"
                    : "bg-green-700 hover:bg-green-600")
                }
              >
                {deconstructing
                  ? "Deconstructing with Opus…"
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

          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="mb-3 flex items-center justify-between">
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
                      value={t.title}
                      onChange={(e) =>
                        patchTask(t.key, { title: e.target.value })
                      }
                      className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-200"
                    />
                    <button
                      onClick={() => moveTask(idx, -1)}
                      disabled={idx === 0}
                      className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => moveTask(idx, 1)}
                      disabled={idx === tasks.length - 1}
                      className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-400 hover:bg-neutral-800 disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => removeTask(t.key)}
                      className="rounded border border-red-900 px-2 py-1 text-[11px] text-red-400 hover:bg-red-950/50"
                    >
                      ✕
                    </button>
                  </div>

                  <textarea
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
                        value={t.assignedModel}
                        models={models}
                        onChange={(m) =>
                          m && patchTask(t.key, { assignedModel: m })
                        }
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                        Scope paths (comma-separated globs)
                      </label>
                      <input
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
                    <div className="col-span-2">
                      <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                        Acceptance criteria (one per line)
                      </label>
                      <textarea
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
                    <div className="col-span-2">
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
                disabled={committing || tasks.length === 0}
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
    </div>
  );
}
