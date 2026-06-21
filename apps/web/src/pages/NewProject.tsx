import type {
  CreateProjectResponse,
  Difficulty,
  DraftTask,
  GetSettingsResponse,
  ModelConfig,
  ModelId,
  PlanChatMessage,
  PlanChatResponse,
  PlanCommitResponse,
  PlanDeconstructResponse,
} from "@orc/types";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { ModelSelect } from "../components/ModelSelect";

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

/** UI-side draft task: deps are stored by stable key so reorder stays correct. */
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

const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

export function NewProject({
  onProjectCreated,
}: {
  onProjectCreated?: (p: CreateProjectResponse["project"]) => void;
}) {
  // Create form
  const [name, setName] = useState("");
  const [createRepo, setCreateRepo] = useState(true);
  const [repoUrl, setRepoUrl] = useState("");
  const [repoName, setRepoName] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [budgetUsd, setBudgetUsd] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<
    CreateProjectResponse["project"] | null
  >(null);

  // Models (for the assigned-model dropdowns in the table)
  const [models, setModels] = useState<ModelConfig[]>([]);

  // Chat
  const [messages, setMessages] = useState<PlanChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [chatting, setChatting] = useState(false);
  const [planCost, setPlanCost] = useState(0);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Draft plan
  const [deconstructing, setDeconstructing] = useState(false);
  const [prd, setPrd] = useState<string | null>(null);
  const [tasks, setTasks] = useState<UiTask[] | null>(null);
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState<PlanCommitResponse | null>(null);

  useEffect(() => {
    api<GetSettingsResponse>("getSettings")
      .then((r) => setModels(r.settings.models))
      .catch(() => {});
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, chatting]);

  async function createProject() {
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const res = await api<CreateProjectResponse>("createProject", {
        body: {
          name,
          createRepo,
          repoName: createRepo ? repoName || undefined : undefined,
          repoUrl: createRepo ? undefined : repoUrl || undefined,
          defaultBranch,
          budgetUsd: budgetUsd ? parseFloat(budgetUsd) : undefined,
        },
      });
      setProject(res.project);
      onProjectCreated?.(res.project);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  async function sendChat() {
    if (!project || !input.trim() || chatting) return;
    const next: PlanChatMessage[] = [
      ...messages,
      { role: "user", content: input.trim() },
    ];
    setMessages(next);
    setInput("");
    setChatting(true);
    setError(null);
    try {
      const res = await api<PlanChatResponse>("planChat", {
        params: { id: project.id },
        body: { messages: next },
      });
      setMessages([...next, { role: "assistant", content: res.reply }]);
      setPlanCost((c) => c + res.costUsd);
    } catch (e) {
      setError(String(e));
      setMessages(messages); // roll back the optimistic user turn
    } finally {
      setChatting(false);
    }
  }

  async function generateTable() {
    if (!project || deconstructing) return;
    setDeconstructing(true);
    setError(null);
    try {
      const res = await api<PlanDeconstructResponse>("planDeconstruct", {
        params: { id: project.id },
        body: { messages },
      });
      setPlanCost((c) => c + res.costUsd);
      setPrd(res.prdMarkdown);
      // Map index-based deps to stable keys.
      const keys = res.tasks.map(() => newKey());
      setTasks(
        res.tasks.map((t, i) => ({
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
        })),
      );
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
    const fallback = models.find((m) => m.enabled)?.id ?? ("deepseek-flash" as ModelId);
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
    if (!project || !tasks || tasks.length === 0) return;
    setCommitting(true);
    setError(null);
    try {
      const keyIndex = new Map(tasks.map((t, i) => [t.key, i]));
      const draftTasks: DraftTask[] = tasks.map((t) => ({
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
      const res = await api<PlanCommitResponse>("planCommit", {
        params: { id: project.id },
        body: { prdMarkdown: prd ?? "", tasks: draftTasks },
      });
      setCommitted(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setCommitting(false);
    }
  }

  const inputCls =
    "w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200";

  return (
    <div className="max-w-4xl space-y-8">
      <h2 className="text-lg font-semibold">New Project</h2>

      {error && (
        <div className="rounded border border-red-800 bg-red-950/50 px-4 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* ── 1. Create ── */}
      <section className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h3 className="text-sm font-medium text-neutral-300">Create Project</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="mb-1 block text-xs text-neutral-400">Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My project"
              disabled={!!project}
              className={inputCls}
            />
          </div>

          <div className="col-span-2 flex gap-4 text-xs">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={createRepo}
                onChange={() => setCreateRepo(true)}
                disabled={!!project}
              />
              <span className="text-neutral-300">Create a new private repo</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={!createRepo}
                onChange={() => setCreateRepo(false)}
                disabled={!!project}
              />
              <span className="text-neutral-300">Use an existing repo</span>
            </label>
          </div>

          {createRepo ? (
            <div className="col-span-2">
              <label className="mb-1 block text-xs text-neutral-400">
                Repo name (optional — defaults to a slug of the project name)
              </label>
              <input
                type="text"
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
                placeholder="my-project"
                disabled={!!project}
                className={inputCls}
              />
            </div>
          ) : (
            <div className="col-span-2">
              <label className="mb-1 block text-xs text-neutral-400">
                Repo URL *
              </label>
              <input
                type="text"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/user/repo"
                disabled={!!project}
                className={inputCls}
              />
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs text-neutral-400">
              Default branch
            </label>
            <input
              type="text"
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              disabled={!!project}
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-neutral-400">
              Budget (USD)
            </label>
            <input
              type="number"
              value={budgetUsd}
              onChange={(e) => setBudgetUsd(e.target.value)}
              placeholder="Optional"
              disabled={!!project}
              className={inputCls}
            />
          </div>
        </div>
        {!project && (
          <button
            onClick={createProject}
            disabled={!name || creating || (!createRepo && !repoUrl)}
            className="rounded bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create Project"}
          </button>
        )}
      </section>

      {/* ── 2. Plan chat ── */}
      {project && (
        <section className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-neutral-300">
              Plan with Claude
            </h3>
            <span className="text-[11px] text-neutral-500">
              repo: {project.repoUrl} · planning cost ${planCost.toFixed(4)}
            </span>
          </div>

          <div className="max-h-80 space-y-2 overflow-y-auto rounded border border-neutral-800 bg-neutral-950 p-3">
            {messages.length === 0 && (
              <p className="text-xs text-neutral-500">
                Describe what you want to build. Refine it conversationally
                (“split that task”, “add tests”, “don’t touch the DB”), then
                generate the task table.
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
                <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                  {m.role === "user" ? "You" : "Claude"}
                </div>
                <div className="whitespace-pre-wrap">{m.content}</div>
              </div>
            ))}
            {chatting && (
              <div className="px-3 py-2 text-xs text-neutral-500">Claude is thinking…</div>
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
              placeholder="e.g. Build a REST API for user management with JWT auth"
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
            <button
              onClick={generateTable}
              disabled={deconstructing}
              className="rounded bg-green-700 px-4 py-2 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-50"
            >
              {deconstructing
                ? "Deconstructing plan (Opus)…"
                : tasks
                  ? "Re-generate task table"
                  : "Generate task table →"}
            </button>
          )}
        </section>
      )}

      {/* ── 3. Editable task table ── */}
      {tasks && !committed && (
        <section className="space-y-4">
          {prd && (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
              <h3 className="mb-2 text-sm font-medium text-neutral-300">PRD</h3>
              <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-neutral-300">
                {prd}
              </pre>
            </div>
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
                      onChange={(e) => patchTask(t.key, { title: e.target.value })}
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

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-[10px] uppercase text-neutral-500">
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
                      <label className="mb-1 block text-[10px] uppercase text-neutral-500">
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
                      <label className="mb-1 block text-[10px] uppercase text-neutral-500">
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
                        className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="mb-1 block text-[10px] uppercase text-neutral-500">
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
                      <label className="mb-1 block text-[10px] uppercase text-neutral-500">
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
                            const oIdx = tasks.findIndex((x) => x.key === o.key);
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
                                #{oIdx + 1}
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
              <span className="text-[11px] text-neutral-500">
                Materializes these as Task rows; then Start from the Board.
              </span>
            </div>
          </div>
        </section>
      )}

      {/* ── 4. Done ── */}
      {committed && (
        <section className="space-y-2 rounded-lg border border-green-800 bg-green-950/20 p-4">
          <h3 className="text-sm font-medium text-green-300">
            {committed.tasks.length} tasks created
          </h3>
          <p className="text-xs text-neutral-300">
            Project “{committed.project.name}” is planned. Open the Board to
            review and Start the run.
          </p>
        </section>
      )}
    </div>
  );
}
