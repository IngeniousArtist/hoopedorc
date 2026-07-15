import type { Difficulty, ModelConfig, Role, RoutingPolicy } from "@orc/types";
import { ModelSelect } from "./ModelSelect";

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

const ROLE_LABELS: Record<Role, string> = {
  planner: "Planner",
  frontend: "Frontend",
  hard: "Hard tasks",
  medium: "Medium tasks",
  docs: "Documentation",
  validator: "Validator",
  updates: "Updates",
};

const BY_ROLE_KEYS: Role[] = ["frontend", "hard", "medium", "docs", "updates"];

/**
 * Planner / author-by-difficulty / role-override / validator-by-difficulty
 * selectors — extracted from Settings.tsx so the onboarding wizard (F1) and
 * the Settings page can share one implementation instead of drifting apart.
 */
export function RoutingEditor({
  routing,
  models,
  onChange,
}: {
  routing: RoutingPolicy;
  /** Enabled models only — these are the only sane choices to route to. */
  models: ModelConfig[];
  onChange: (fn: (r: RoutingPolicy) => RoutingPolicy) => void;
}) {
  return (
    <section className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <h3 className="text-sm font-medium text-neutral-300">Model Routing</h3>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-neutral-400">Planner</label>
          <ModelSelect
            ariaLabel="Planner model"
            value={routing.planner}
            models={models}
            onChange={(m) => {
              if (m) onChange((r) => ({ ...r, planner: m }));
            }}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-neutral-400">
            Deconstructor
            <span className="ml-1 text-neutral-500" title="Turns the agreed plan into the task table (the final planning call). Leave as '(same as planner)' unless you want a different model for it.">
              ⓘ
            </span>
          </label>
          <ModelSelect
            ariaLabel="Deconstructor model"
            value={routing.deconstructor}
            models={models}
            onChange={(m) => {
              onChange((r) => {
                const next = { ...r };
                if (m) {
                  next.deconstructor = m;
                } else {
                  delete next.deconstructor;
                }
                return next;
              });
            }}
            allowEmpty
            emptyLabel="(same as planner)"
          />
        </div>
      </div>

      <div>
        <label className="mb-2 block text-xs text-neutral-400">
          Author by difficulty
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {DIFFICULTIES.map((d) => (
            <div key={d}>
              <label className="mb-1 block text-[10px] text-neutral-400 capitalize">
                {d}
              </label>
              <ModelSelect
                ariaLabel={`Author model for ${d} tasks`}
                value={routing.byDifficulty[d]}
                models={models}
                onChange={(m) => {
                  if (m)
                    onChange((r) => ({
                      ...r,
                      byDifficulty: { ...r.byDifficulty, [d]: m },
                    }));
                }}
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <label className="mb-2 block text-xs text-neutral-400">
          Role overrides (optional)
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {BY_ROLE_KEYS.map((role) => (
            <div key={role}>
              <label className="mb-1 block text-[10px] text-neutral-400">
                {ROLE_LABELS[role]}
              </label>
              <ModelSelect
                ariaLabel={`${ROLE_LABELS[role]} role override model`}
                value={routing.byRole[role]}
                models={models}
                onChange={(m) => {
                  onChange((r) => {
                    const next = { ...r.byRole };
                    if (m) {
                      next[role] = m;
                    } else {
                      delete next[role];
                    }
                    return { ...r, byRole: next };
                  });
                }}
                allowEmpty
                emptyLabel="(use difficulty)"
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <label className="mb-2 block text-xs text-neutral-400">
          Fallback models
        </label>
        <p className="mb-2 text-[10px] text-neutral-600">
          Tried in order when a task's assigned model keeps failing (errors,
          failing gates, rate limits). Leave both empty to fall back through
          the difficulty tiers above instead.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[0, 1].map((slot) => (
            <div key={slot}>
              <label className="mb-1 block text-[10px] text-neutral-400">
                Fallback {slot + 1}
              </label>
              <ModelSelect
                ariaLabel={`Fallback model ${slot + 1}`}
                value={routing.fallbacks?.[slot]}
                models={models}
                onChange={(m) => {
                  onChange((r) => {
                    const next = [...(r.fallbacks ?? [])];
                    if (m) next[slot] = m;
                    else delete next[slot];
                    // delete leaves holes — compact so the engine sees a
                    // clean ordered list.
                    const compact = next.filter(Boolean);
                    if (compact.length > 0) return { ...r, fallbacks: compact };
                    const rest = { ...r };
                    delete rest.fallbacks;
                    return rest;
                  });
                }}
                allowEmpty
                emptyLabel="(none)"
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <label className="mb-2 block text-xs text-neutral-400">
          Validator by difficulty
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {DIFFICULTIES.map((d) => (
            <div key={d}>
              <label className="mb-1 block text-[10px] text-neutral-400 capitalize">
                {d}
              </label>
              <ModelSelect
                ariaLabel={`Validator model for ${d} tasks`}
                value={routing.validatorByDifficulty[d]}
                models={models}
                onChange={(m) => {
                  if (m)
                    onChange((r) => ({
                      ...r,
                      validatorByDifficulty: {
                        ...r.validatorByDifficulty,
                        [d]: m,
                      },
                    }));
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
