import type { ModelConfig, Role, RunnerKind } from "@orc/types";

const ALL_ROLES: Role[] = [
  "planner",
  "frontend",
  "hard",
  "medium",
  "docs",
  "validator",
  "updates",
];

const RUNNERS: RunnerKind[] = ["opencode", "claude-code"];

const inputCls =
  "w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200";

/**
 * Add / remove / edit the model roster (settings.models). Edits bubble up to the
 * parent Settings page and persist via the shared Save button (PUT /api/settings).
 */
export function ModelsEditor({
  models,
  onChange,
  roster,
}: {
  models: ModelConfig[];
  onChange: (models: ModelConfig[]) => void;
  /** Real `opencode models` output, offered as a datalist on the opencode
   *  model field so mapping a model is picking from a real id instead of
   *  typing one blind (F1's onboarding wizard passes this; Settings doesn't
   *  need to). */
  roster?: string[];
}) {
  function patch(idx: number, partial: Partial<ModelConfig>) {
    onChange(models.map((m, i) => (i === idx ? { ...m, ...partial } : m)));
  }
  function remove(idx: number) {
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
      <div className="flex items-center justify-between">
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
                onClick={() => remove(idx)}
                className="rounded border border-red-900 px-2 py-1 text-[11px] text-red-400 hover:bg-red-950/50"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                  ID
                </label>
                <input
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
                  value={m.runner}
                  onChange={(e) =>
                    patch(idx, { runner: e.target.value as RunnerKind })
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

              <div className="col-span-2">
                <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                  {m.runner === "claude-code"
                    ? "claude --model (e.g. sonnet / opus)"
                    : "opencode model (provider/model from `opencode models`)"}
                </label>
                {m.runner === "claude-code" ? (
                  <input
                    value={m.claudeModel ?? ""}
                    onChange={(e) =>
                      patch(idx, { claudeModel: e.target.value || undefined })
                    }
                    placeholder="sonnet"
                    className={inputCls + " font-mono"}
                  />
                ) : (
                  <input
                    value={m.opencodeModel ?? ""}
                    onChange={(e) =>
                      patch(idx, { opencodeModel: e.target.value || undefined })
                    }
                    placeholder="deepseek/deepseek-v4-flash"
                    list={roster?.length ? "opencode-model-roster" : undefined}
                    className={inputCls + " font-mono"}
                  />
                )}
              </div>

              <div>
                <label className="mb-1 block text-[10px] uppercase text-neutral-400">
                  Max concurrent
                </label>
                <input
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
                Subscription quota (optional) — route around a subscription's
                usage window before burning attempts, instead of reacting
                after a rate-limit failure
              </label>
              <div className="grid grid-cols-3 gap-3">
                <input
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
                  placeholder="max runs"
                  className={`${inputCls} disabled:opacity-40`}
                />
                <input
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
      {roster?.length ? (
        <datalist id="opencode-model-roster">
          {roster.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
      ) : null}
    </section>
  );
}
