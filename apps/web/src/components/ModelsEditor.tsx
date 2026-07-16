import {
  CLAUDE_EFFORTS,
  CODEX_EFFORTS,
  OPENCODE_EFFORT_SUGGESTIONS,
  type ModelCatalogResponse,
  type ModelConfig,
  type Role,
  type RoutingPolicy,
  type RunnerKind,
} from "@orc/types";

const ALL_ROLES: Role[] = [
  "planner",
  "frontend",
  "hard",
  "medium",
  "docs",
  "validator",
  "updates",
];

const RUNNERS: RunnerKind[] = ["opencode", "claude-code", "codex"];

export type ModelSlugSuggestions = Partial<Record<RunnerKind, string[]>>;

export function modelSlugSuggestions(
  catalog: ModelCatalogResponse,
): ModelSlugSuggestions {
  return Object.fromEntries(
    catalog.catalogs.map((entry) => [
      entry.runner,
      entry.models.map((model) => model.slug),
    ]),
  ) as ModelSlugSuggestions;
}

const MODEL_LIST_IDS: Record<RunnerKind, string> = {
  "claude-code": "claude-code-model-catalog",
  codex: "codex-model-catalog",
  opencode: "opencode-model-catalog",
};

const inputCls =
  "w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200";

/**
 * B28: everywhere `routing` can name a model id — used before removing one,
 * so the confirmation names exactly what would go dangling instead of a
 * generic "are you sure?". Kept in sync with the server's own reference
 * check in `PUT /api/settings` by construction: both walk the same four
 * `RoutingPolicy` fields.
 */
function routingReferences(routing: RoutingPolicy | undefined, modelId: string): string[] {
  if (!routing) return [];
  const refs: string[] = [];
  if (routing.planner === modelId) refs.push("Planner");
  for (const d of ["easy", "medium", "hard"] as const) {
    if (routing.byDifficulty[d] === modelId) refs.push(`Author by difficulty → ${d}`);
    if (routing.validatorByDifficulty[d] === modelId) {
      refs.push(`Validator by difficulty → ${d}`);
    }
  }
  for (const [role, id] of Object.entries(routing.byRole)) {
    if (id === modelId) refs.push(`Role override → ${role}`);
  }
  return refs;
}

/**
 * Add / remove / edit the model roster (settings.models). Edits bubble up to the
 * parent Settings page and persist via the shared Save button (PUT /api/settings).
 */
export function ModelsEditor({
  models,
  onChange,
  modelSlugs,
  routing,
}: {
  models: ModelConfig[];
  onChange: (models: ModelConfig[]) => void;
  /** Runner-specific model slugs from the shared Model Slugs catalog. */
  modelSlugs?: ModelSlugSuggestions;
  /** B28: current routing, so removing a model can warn before leaving a
   *  dangling reference behind (the server rejects the save either way —
   *  this just tells the user why up front, naming what references it). */
  routing?: RoutingPolicy;
}) {
  function patch(idx: number, partial: Partial<ModelConfig>) {
    onChange(models.map((m, i) => (i === idx ? { ...m, ...partial } : m)));
  }
  function remove(idx: number) {
    const model = models[idx];
    const refs = model ? routingReferences(routing, model.id) : [];
    if (
      refs.length > 0 &&
      !window.confirm(
        `"${model!.displayName}" is still assigned in Settings → Routing:\n\n` +
          refs.map((r) => `- ${r}`).join("\n") +
          `\n\nRemoving it will fail to save until you reassign those. Remove anyway?`,
      )
    ) {
      return;
    }
    onChange(models.filter((_, i) => i !== idx));
  }
  function add() {
    onChange([
      ...models,
      {
        id: `model-${Date.now().toString(36)}`,
        displayName: "New model",
        runner: "opencode",
        opencodeModel: "",
        roles: [],
        enabled: true,
        maxConcurrent: 1,
      },
    ]);
  }

  return (
    <section className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-neutral-300">Models</h3>
        <button
          onClick={add}
          className="rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
        >
          + Add model
        </button>
      </div>

      <div className="space-y-3">
        {models.map((m, idx) => (
          <div
            key={idx}
            className="space-y-3 rounded border border-neutral-800 bg-neutral-950 p-3"
          >
            <div className="flex items-center gap-2">
              <input
                aria-label={`Model ${idx + 1} display name`}
                value={m.displayName}
                onChange={(e) => patch(idx, { displayName: e.target.value })}
                className={inputCls + " flex-1 font-medium"}
              />
              <label className="flex items-center gap-1 text-[11px] text-neutral-400">
                <input
                  type="checkbox"
                  checked={m.enabled}
                  onChange={(e) => patch(idx, { enabled: e.target.checked })}
                />
                enabled
              </label>
              <button
                aria-label={`Remove ${m.displayName}`}
                onClick={() => remove(idx)}
                className="rounded border border-red-900 px-2 py-1 text-[11px] text-red-400 hover:bg-red-950/50"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                  ID
                </label>
                <input
                  aria-label={`${m.displayName} ID`}
                  value={m.id}
                  onChange={(e) => patch(idx, { id: e.target.value })}
                  className={inputCls + " font-mono"}
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                  Runner
                </label>
                <select
                  aria-label={`${m.displayName} runner`}
                  value={m.runner}
                  onChange={(e) =>
                    patch(idx, {
                      runner: e.target.value as RunnerKind,
                      // Effort values are runner-specific. Make the user
                      // choose again instead of carrying an incompatible
                      // Claude/Codex value into OpenCode (or vice versa).
                      effort: undefined,
                    })
                  }
                  className={inputCls}
                >
                  {RUNNERS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-2">
                <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                  Reasoning effort
                </label>
                {m.runner === "opencode" ? (
                  <input
                    aria-label={`${m.displayName} reasoning effort`}
                    value={m.effort ?? ""}
                    onChange={(e) => patch(idx, { effort: e.target.value || undefined })}
                    placeholder="CLI default (or provider variant)"
                    list="opencode-effort-variants"
                    className={inputCls + " font-mono"}
                  />
                ) : (
                  <select
                    aria-label={`${m.displayName} reasoning effort`}
                    value={m.effort ?? ""}
                    onChange={(e) => patch(idx, { effort: e.target.value || undefined })}
                    className={inputCls}
                  >
                    <option value="">CLI default</option>
                    {(m.runner === "claude-code" ? CLAUDE_EFFORTS : CODEX_EFFORTS).map(
                      (effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ),
                    )}
                  </select>
                )}
                <p className="mt-1 text-[10px] text-neutral-600">
                  Applies to planning, authoring, validation, documentation,
                  and model health calls for this model.
                </p>
              </div>

              <div className="sm:col-span-2">
                <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                  {m.runner === "claude-code"
                    ? "claude --model (e.g. sonnet / opus)"
                    : m.runner === "codex"
                      ? "codex exec -m (optional — omit for the CLI default)"
                      : "opencode model (provider/model from `opencode models`)"}
                </label>
                {m.runner === "claude-code" ? (
                  <input
                    aria-label={`${m.displayName} Claude model`}
                    value={m.claudeModel ?? ""}
                    onChange={(e) =>
                      patch(idx, { claudeModel: e.target.value || undefined })
                    }
                    placeholder="sonnet"
                    list={
                      modelSlugs?.["claude-code"]?.length
                        ? MODEL_LIST_IDS["claude-code"]
                        : undefined
                    }
                    className={inputCls + " font-mono"}
                  />
                ) : m.runner === "codex" ? (
                  <input
                    aria-label={`${m.displayName} Codex model`}
                    value={m.codexModel ?? ""}
                    onChange={(e) =>
                      patch(idx, { codexModel: e.target.value || undefined })
                    }
                    placeholder="gpt-5.6-sol"
                    list={
                      modelSlugs?.codex?.length
                        ? MODEL_LIST_IDS.codex
                        : undefined
                    }
                    className={inputCls + " font-mono"}
                  />
                ) : (
                  <input
                    aria-label={`${m.displayName} OpenCode model`}
                    value={m.opencodeModel ?? ""}
                    onChange={(e) =>
                      patch(idx, { opencodeModel: e.target.value || undefined })
                    }
                    placeholder="deepseek/deepseek-v4-flash"
                    list={
                      modelSlugs?.opencode?.length
                        ? MODEL_LIST_IDS.opencode
                        : undefined
                    }
                    className={inputCls + " font-mono"}
                  />
                )}
              </div>

              <div>
                <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                  Max concurrent
                </label>
                <input
                  aria-label={`${m.displayName} maximum concurrent calls`}
                  type="number"
                  min={1}
                  value={m.maxConcurrent}
                  onChange={(e) =>
                    patch(idx, {
                      maxConcurrent: Math.max(1, parseInt(e.target.value) || 1),
                    })
                  }
                  className={inputCls}
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                  Monthly budget $ (optional)
                </label>
                <input
                  aria-label={`${m.displayName} monthly budget in USD`}
                  type="number"
                  min={0}
                  step={0.5}
                  value={m.monthlyBudgetUsd ?? ""}
                  onChange={(e) =>
                    patch(idx, {
                      monthlyBudgetUsd: e.target.value
                        ? parseFloat(e.target.value)
                        : undefined,
                    })
                  }
                  placeholder="none"
                  className={inputCls}
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                Pricing (optional, USD per 1M tokens) — when any is set,
                recorded costs are recomputed from real token counts using
                these prices instead of trusting the CLI's own (possibly
                stale) pricing table
              </label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {(
                  [
                    ["costPerMInputUsd", "input $/1M"],
                    ["costPerMCachedInputUsd", "cached input $/1M"],
                    ["costPerMOutputUsd", "output $/1M"],
                  ] as const
                ).map(([field, placeholder]) => (
                  <input
                    key={field}
                    aria-label={`${m.displayName} ${placeholder}`}
                    type="number"
                    min={0}
                    step={0.01}
                    value={m[field] ?? ""}
                    onChange={(e) =>
                      patch(idx, {
                        [field]: e.target.value
                          ? parseFloat(e.target.value)
                          : undefined,
                      })
                    }
                    placeholder={placeholder}
                    className={inputCls}
                  />
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                Subscription quota (optional) — route around a subscription's
                usage window before burning attempts, instead of reacting
                after a rate-limit failure
              </label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <input
                  aria-label={`${m.displayName} quota window in hours`}
                  type="number"
                  min={1}
                  value={m.quota?.windowHours ?? ""}
                  onChange={(e) => {
                    const windowHours = e.target.value ? parseFloat(e.target.value) : undefined;
                    patch(idx, {
                      quota: windowHours ? { ...m.quota, windowHours } : undefined,
                    });
                  }}
                  placeholder="window (hours)"
                  className={inputCls}
                />
                <input
                  aria-label={`${m.displayName} quota maximum calls`}
                  type="number"
                  min={0}
                  disabled={!m.quota?.windowHours}
                  value={m.quota?.maxRuns ?? ""}
                  onChange={(e) =>
                    m.quota?.windowHours &&
                    patch(idx, {
                      quota: {
                        ...m.quota,
                        maxRuns: e.target.value ? parseInt(e.target.value, 10) : undefined,
                      },
                    })
                  }
                  placeholder="max calls"
                  className={`${inputCls} disabled:opacity-40`}
                />
                <input
                  aria-label={`${m.displayName} quota maximum cost in USD`}
                  type="number"
                  min={0}
                  step={0.5}
                  disabled={!m.quota?.windowHours}
                  value={m.quota?.maxCostUsd ?? ""}
                  onChange={(e) =>
                    m.quota?.windowHours &&
                    patch(idx, {
                      quota: {
                        ...m.quota,
                        maxCostUsd: e.target.value ? parseFloat(e.target.value) : undefined,
                      },
                    })
                  }
                  placeholder="max cost $"
                  className={`${inputCls} disabled:opacity-40`}
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                Roles
              </label>
              <p className="mb-1 text-[10px] text-neutral-600">
                "hard"/"medium" mark this model eligible for Routing's
                "Author by difficulty" tiers; the rest ("frontend", "docs",
                "validator", "updates"…) are true task roles.
              </p>
              <div className="flex flex-wrap gap-2">
                {ALL_ROLES.map((role) => {
                  const on = m.roles.includes(role);
                  return (
                    <label
                      key={role}
                      className="flex items-center gap-1 text-[11px] text-neutral-400"
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) =>
                          patch(idx, {
                            roles: e.target.checked
                              ? [...m.roles, role]
                              : m.roles.filter((r) => r !== role),
                          })
                        }
                      />
                      {role}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-neutral-600">
        Changing an ID that's referenced in Routing above will require
        re-selecting the model there. Save applies all changes.
      </p>
      {RUNNERS.map((runner) =>
        modelSlugs?.[runner]?.length ? (
          <datalist key={runner} id={MODEL_LIST_IDS[runner]}>
            {modelSlugs[runner]!.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        ) : null,
      )}
      <datalist id="opencode-effort-variants">
        {OPENCODE_EFFORT_SUGGESTIONS.map((effort) => (
          <option key={effort} value={effort} />
        ))}
      </datalist>
    </section>
  );
}
