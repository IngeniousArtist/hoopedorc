import type {
  CreateProjectResponse,
  ModelConfig,
  ModelRosterResponse,
  Settings as SettingsType,
  SetupHealthResponse,
} from "@orc/types";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { ModelsEditor } from "../components/ModelsEditor";
import { RoutingEditor } from "../components/RoutingEditor";
import { NewProject } from "./NewProject";

/** Per-check install/login hints, keyed by the `SetupCheck.name` runSetupChecks
 *  reports — copy-paste-ready so a failure isn't a dead end. */
const CHECK_HINTS: Record<string, { install: string; login: string }> = {
  "GitHub CLI (gh)": {
    install: "brew install gh   (or see cli.github.com)",
    login: "gh auth login",
  },
  "Claude Code (claude)": {
    install: "npm install -g @anthropic-ai/claude-code",
    login: "claude   (follow the one-time login prompt)",
  },
  "OpenCode (opencode)": {
    install: "curl -fsSL https://opencode.ai/install | bash",
    login: "opencode auth login",
  },
  "Codex CLI (codex)": {
    install: "npm install -g @openai/codex",
    login: "codex login   (or set CODEX_API_KEY in .env)",
  },
};

const inputCls =
  "w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200";

const STEPS = ["Check tools", "Models", "Routing", "Budget & Telegram", "First project"];

/**
 * First-run guided flow (F1). App.tsx routes here instead of the Board when
 * there are no projects yet and settings.onboardedAt has never been set.
 * Persists settings.onboardedAt once the first project is created; also
 * reachable any time afterward via SetupView's "Re-run setup" link.
 */
export function Welcome({
  onDone,
}: {
  onDone: (p: CreateProjectResponse["project"]) => void;
}) {
  const [step, setStep] = useState(0);
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [health, setHealth] = useState<SetupHealthResponse | null>(null);
  const [roster, setRoster] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ settings: SettingsType }>("getSettings")
      .then((r) => setSettings(r.settings))
      .catch((e) => setError(String(e)));
    api<SetupHealthResponse>("setupHealth")
      .then(setHealth)
      .catch(() => {});
    api<ModelRosterResponse>("setupModels")
      .then((r) => setRoster(r.models))
      .catch(() => {});
  }, []);

  const saveSettings = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api<{ settings: SettingsType }>("updateSettings", {
        body: { settings },
      });
      setSettings(res.settings);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [settings]);

  async function next() {
    await saveSettings();
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }
  function back() {
    setStep((s) => Math.max(s - 1, 0));
  }

  function updateModels(models: ModelConfig[]) {
    setSettings((prev) => (prev ? { ...prev, models } : prev));
  }

  async function handleProjectCreated(p: CreateProjectResponse["project"]) {
    try {
      await api<{ settings: SettingsType }>("updateSettings", {
        body: { settings: { onboardedAt: new Date().toISOString() } },
      });
    } catch {
      /* non-fatal — worst case the wizard offers itself again next time */
    }
    onDone(p);
  }

  if (!settings) {
    return (
      <div className="text-sm text-neutral-400">
        {error ? `Error: ${error}` : "Loading…"}
      </div>
    );
  }

  const enabledModels = settings.models.filter((m) => m.enabled);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Welcome to Hoopedorc</h2>
        <p className="mt-1 text-xs text-neutral-400">
          A few quick steps before your first project runs autonomously.
        </p>
      </div>

      <div className="flex items-center gap-2">
        {STEPS.map((label, i) => (
          <div key={label} className="flex flex-1 items-center gap-2">
            <div
              className={
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-medium " +
                (i < step
                  ? "bg-green-700 text-green-100"
                  : i === step
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-800 text-neutral-500")
              }
            >
              {i + 1}
            </div>
            <span
              className={
                "hidden text-[11px] sm:inline " +
                (i === step ? "text-neutral-200" : "text-neutral-500")
              }
            >
              {label}
            </span>
            {i < STEPS.length - 1 && (
              <div className="h-px flex-1 bg-neutral-800" />
            )}
          </div>
        ))}
      </div>

      {error && (
        <div className="rounded border border-red-800 bg-red-950/50 px-4 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {step === 0 && (
        <section className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <h3 className="text-sm font-medium text-neutral-300">
            Step 1 — Check your tools
          </h3>
          <p className="text-xs text-neutral-400">
            These CLIs must be installed and authenticated before the
            orchestrator can spend money or touch GitHub.
          </p>
          {!health && (
            <div className="text-xs text-neutral-500">Checking…</div>
          )}
          {health && (
            <div className="divide-y divide-neutral-800 rounded border border-neutral-800">
              {health.checks.map((c) => {
                const hint = CHECK_HINTS[c.name];
                return (
                  <div key={c.name} className="space-y-1.5 px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <span
                        className={
                          "mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full " +
                          (c.ok ? "bg-green-500" : "bg-red-500")
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-neutral-200">
                          {c.name}
                        </div>
                        <div className="mt-0.5 break-words font-mono text-[11px] text-neutral-400">
                          {c.detail}
                        </div>
                      </div>
                    </div>
                    {!c.ok && hint && (
                      <div className="ml-[18px] space-y-0.5 rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-[11px] text-neutral-400">
                        <div>Install: {hint.install}</div>
                        <div>Login: {hint.login}</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {health && !health.allOk && (
            <p className="text-[11px] text-amber-400">
              You can continue, but any red check above will block that
              provider until fixed.
            </p>
          )}
        </section>
      )}

      {step === 1 && (
        <section className="space-y-3">
          <p className="text-xs text-neutral-400">
            Enable the models you have credentials for, and map each to a
            real id from your installed roster (pick from the dropdown list
            instead of typing one blind).
          </p>
          <ModelsEditor
            models={settings.models}
            onChange={updateModels}
            roster={roster}
          />
        </section>
      )}

      {step === 2 && (
        <section className="space-y-3">
          <p className="text-xs text-neutral-400">
            Tasks are routed by difficulty: <b>easy</b> work goes to a
            fast/cheap model, <b>hard</b> work goes to your strongest model.
            The <b>validator</b> reviews every attempt and must never be the
            same model that authored it — the model picker below only offers
            enabled models, but double-check none coincide per difficulty
            tier before saving.
          </p>
          <RoutingEditor
            routing={settings.routing}
            models={enabledModels}
            onChange={(fn) =>
              setSettings((prev) =>
                prev ? { ...prev, routing: fn(prev.routing) } : prev,
              )
            }
          />
        </section>
      )}

      {step === 3 && (
        <section className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <h3 className="text-sm font-medium text-neutral-300">
            Step 4 — Budget &amp; Telegram (optional)
          </h3>
          <div>
            <label className="mb-1 block text-xs text-neutral-400">
              Monthly budget (USD)
            </label>
            <input
              type="number"
              value={settings.globalMonthlyBudgetUsd ?? ""}
              onChange={(e) =>
                setSettings((prev) =>
                  prev
                    ? {
                        ...prev,
                        globalMonthlyBudgetUsd: e.target.value
                          ? parseFloat(e.target.value)
                          : undefined,
                      }
                    : prev,
                )
              }
              placeholder="Unlimited"
              className={inputCls}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-neutral-400">
                Telegram bot token (optional — from @BotFather)
              </label>
              <input
                type="password"
                autoComplete="off"
                value={settings.telegram?.botToken ?? ""}
                onChange={(e) =>
                  setSettings((prev) =>
                    prev
                      ? {
                          ...prev,
                          telegram: {
                            ...(prev.telegram ?? { enabled: false }),
                            botToken: e.target.value,
                            enabled: Boolean(e.target.value),
                          },
                        }
                      : prev,
                  )
                }
                placeholder="123456789:ABCdef…"
                className={inputCls}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-neutral-400">
                Chat ID
              </label>
              <input
                type="text"
                value={settings.telegram?.chatId ?? ""}
                onChange={(e) =>
                  setSettings((prev) =>
                    prev
                      ? {
                          ...prev,
                          telegram: {
                            ...(prev.telegram ?? { enabled: false }),
                            chatId: e.target.value,
                          },
                        }
                      : prev,
                  )
                }
                placeholder="e.g. 123456789"
                className={inputCls}
              />
            </div>
          </div>
          <p className="text-[10px] text-neutral-600">
            Fine-tune or send a test message any time later from Settings →
            Telegram. Both fields are optional — skip if you don't want
            remote pings yet.
          </p>
        </section>
      )}

      {step === 4 && (
        <section>
          <p className="mb-3 text-xs text-neutral-400">
            Step 5 — create your first project. Once it's created you'll land
            on the Board.
          </p>
          <NewProject onProjectCreated={handleProjectCreated} />
        </section>
      )}

      {step < 4 && (
        <div className="flex items-center justify-between">
          <button
            onClick={back}
            disabled={step === 0}
            className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
          >
            ← Back
          </button>
          <button
            onClick={next}
            disabled={saving}
            className="rounded bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Next →"}
          </button>
        </div>
      )}
    </div>
  );
}
