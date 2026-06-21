import type {
  Difficulty,
  MergePolicy,
  ModelId,
  Role,
  RoutingPolicy,
  Settings as SettingsType,
  TelegramTestResponse,
} from "@orc/types";
import type { ModelConfig } from "@orc/types";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { ModelSelect } from "../components/ModelSelect";
import { ModelsEditor } from "../components/ModelsEditor";

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

const BY_ROLE_KEYS: Role[] = [
  "frontend",
  "hard",
  "medium",
  "docs",
  "updates",
];

const MERGE_POLICY_LABELS: Record<MergePolicy, string> = {
  hard_gate_flag_risky: "Hard gates, flag risky",
  fully_autonomous: "Fully autonomous",
  always_ask: "Always ask for approval",
};

const RISKY_RULES: {
  key: keyof SettingsType["riskyChangeRules"];
  label: string;
}[] = [
  { key: "dbSchema", label: "Database schema changes" },
  { key: "newDependencies", label: "New dependencies" },
  { key: "authOrSecrets", label: "Auth / secrets changes" },
  { key: "outOfScopeEdits", label: "Out-of-scope edits" },
];

export function Settings() {
  const [settings, setSettings] = useState<SettingsType | null>(
    null,
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [telegramTestMsg, setTelegramTestMsg] = useState<string | null>(null);

  useEffect(() => {
    api<{ settings: SettingsType }>("getSettings")
      .then((r) => setSettings(r.settings))
      .catch((e) => setError(String(e)));
  }, []);

  if (!settings) {
    return (
      <div className="text-sm text-neutral-400">
        {error ? `Error: ${error}` : "Loading settings…"}
      </div>
    );
  }

  const enabledModels = settings.models.filter((m) => m.enabled);

  function updateRouting(fn: (r: RoutingPolicy) => RoutingPolicy) {
    setSettings((prev) =>
      prev ? { ...prev, routing: fn(prev.routing) } : prev,
    );
    setDirty(true);
    setSaved(false);
  }

  function updateModels(models: ModelConfig[]) {
    setSettings((prev) => (prev ? { ...prev, models } : prev));
    setDirty(true);
    setSaved(false);
  }

  function updateMergePolicy(mp: MergePolicy) {
    setSettings((prev) =>
      prev ? { ...prev, mergePolicy: mp } : prev,
    );
    setDirty(true);
    setSaved(false);
  }

  function updateRiskyRule(
    key: keyof SettingsType["riskyChangeRules"],
    value: boolean,
  ) {
    setSettings((prev) =>
      prev
        ? {
            ...prev,
            riskyChangeRules: {
              ...prev.riskyChangeRules,
              [key]: value,
            },
          }
        : prev,
    );
    setDirty(true);
    setSaved(false);
  }

  function updateDefaultProjectsDir(value: string) {
    setSettings((prev) =>
      prev ? { ...prev, defaultProjectsDir: value || undefined } : prev,
    );
    setDirty(true);
    setSaved(false);
  }

  function updateBudget(value: string) {
    const num = value === "" ? undefined : parseFloat(value);
    setSettings((prev) =>
      prev
        ? { ...prev, globalMonthlyBudgetUsd: isNaN(num!) ? undefined : num }
        : prev,
    );
    setDirty(true);
    setSaved(false);
  }

  function updateConfidence(value: string) {
    const num = parseFloat(value);
    if (isNaN(num)) return;
    setSettings((prev) =>
      prev ? { ...prev, confidenceThreshold: num } : prev,
    );
    setDirty(true);
    setSaved(false);
  }

  function updateTelegramEnabled(enabled: boolean) {
    setSettings((prev) =>
      prev
        ? { ...prev, telegram: { ...(prev.telegram ?? { enabled: false }), enabled } }
        : prev,
    );
    setDirty(true);
    setSaved(false);
  }

  function updateTelegramField(
    field: "botTokenRef" | "botToken" | "chatId",
    value: string,
  ) {
    setSettings((prev) =>
      prev
        ? {
            ...prev,
            telegram: {
              ...(prev.telegram ?? { enabled: false }),
              [field]: value || undefined,
            },
          }
        : prev,
    );
    setDirty(true);
    setSaved(false);
  }

  async function sendTelegramTest() {
    setTelegramTesting(true);
    setTelegramTestMsg(null);
    try {
      const res = await api<TelegramTestResponse>("telegramTest", {
        body: {
          token: settings?.telegram?.botToken,
          chatId: settings?.telegram?.chatId,
        },
      });
      setTelegramTestMsg(
        res.ok ? "Sent — check your Telegram." : `Failed: ${res.error}`,
      );
    } catch (e) {
      setTelegramTestMsg(String(e));
    } finally {
      setTelegramTesting(false);
    }
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api<{ settings: SettingsType }>(
        "updateSettings",
        { body: { settings } },
      );
      setSettings(res.settings);
      setDirty(false);
      setSaved(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-8">
      <h2 className="text-lg font-semibold">Settings</h2>

      {error && (
        <div className="rounded border border-red-800 bg-red-950/50 px-4 py-2 text-sm text-red-400">
          {error}
        </div>
      )}
      {saved && (
        <div className="rounded border border-green-800 bg-green-950/50 px-4 py-2 text-sm text-green-400">
          Settings saved.
        </div>
      )}

      <ModelsEditor models={settings.models} onChange={updateModels} />

      <section className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h3 className="text-sm font-medium text-neutral-300">
          Model Routing
        </h3>

        <div>
          <label className="mb-1 block text-xs text-neutral-400">
            Planner
          </label>
          <ModelSelect
            value={settings.routing.planner}
            models={enabledModels}
            onChange={(m) => {
              if (m)
                updateRouting((r) => ({ ...r, planner: m }));
            }}
          />
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
                  value={settings.routing.byDifficulty[d]}
                  models={enabledModels}
                  onChange={(m) => {
                    if (m)
                      updateRouting((r) => ({
                        ...r,
                        byDifficulty: {
                          ...r.byDifficulty,
                          [d]: m,
                        },
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
                  value={settings.routing.byRole[role]}
                  models={enabledModels}
                  onChange={(m) => {
                    updateRouting((r) => {
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
            Validator by difficulty
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {DIFFICULTIES.map((d) => (
              <div key={d}>
                <label className="mb-1 block text-[10px] text-neutral-400 capitalize">
                  {d}
                </label>
                <ModelSelect
                  value={
                    settings.routing.validatorByDifficulty[d]
                  }
                  models={enabledModels}
                  onChange={(m) => {
                    if (m)
                      updateRouting((r) => ({
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

      <section className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h3 className="text-sm font-medium text-neutral-300">
          Merge Policy
        </h3>
        <select
          value={settings.mergePolicy}
          onChange={(e) =>
            updateMergePolicy(e.target.value as MergePolicy)
          }
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
        >
          {(
            Object.entries(MERGE_POLICY_LABELS) as [
              MergePolicy,
              string,
            ][]
          ).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </section>

      <section className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h3 className="text-sm font-medium text-neutral-300">
          Risky Change Rules
        </h3>
        <div className="space-y-2">
          {RISKY_RULES.map(({ key, label }) => (
            <label
              key={key}
              className="flex items-center gap-2 text-xs text-neutral-300 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={settings.riskyChangeRules[key]}
                onChange={(e) =>
                  updateRiskyRule(key, e.target.checked)
                }
                className="rounded border-neutral-700 bg-neutral-800"
              />
              {label}
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h3 className="text-sm font-medium text-neutral-300">Projects</h3>
        <div>
          <label className="mb-1 block text-xs text-neutral-400">
            Default projects directory
          </label>
          <input
            type="text"
            value={settings.defaultProjectsDir ?? ""}
            onChange={(e) => updateDefaultProjectsDir(e.target.value)}
            placeholder="~/.hoopedorc/repos (default)"
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
          />
          <p className="mt-1 text-[10px] text-neutral-600">
            New projects clone here by default (a slug of the project name, e.g.
            ~/projects/my-app), unless you set a local directory explicitly on
            New Project.
          </p>
        </div>
      </section>

      <section className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h3 className="text-sm font-medium text-neutral-300">
          Budget & Thresholds
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-neutral-400">
              Monthly budget (USD)
            </label>
            <input
              type="number"
              value={
                settings.globalMonthlyBudgetUsd ?? ""
              }
              onChange={(e) => updateBudget(e.target.value)}
              placeholder="Unlimited"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-neutral-400">
              Confidence threshold
            </label>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={settings.confidenceThreshold}
              onChange={(e) =>
                updateConfidence(e.target.value)
              }
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
            />
          </div>
        </div>
      </section>

      <section className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h3 className="text-sm font-medium text-neutral-300">Telegram</h3>
        <p className="text-[11px] text-neutral-400">
          Create a bot with @BotFather, paste its token + your chat ID below,
          send a test, then enable. Tip: message the bot once with no chat ID
          set and it replies with yours. Approvals + commands are restricted to
          that chat ID.
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="col-span-2">
            <label className="mb-1 block text-xs text-neutral-400">
              Bot token (from @BotFather)
            </label>
            <input
              type="password"
              autoComplete="off"
              value={settings.telegram?.botToken ?? ""}
              onChange={(e) => updateTelegramField("botToken", e.target.value)}
              placeholder="123456789:ABCdef…"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
            />
            <p className="mt-1 text-[10px] text-neutral-600">
              Stored locally in the app DB. Leave blank to use the env var under
              Advanced instead.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-xs text-neutral-400">Chat ID</label>
            <input
              type="text"
              value={settings.telegram?.chatId ?? ""}
              onChange={(e) => updateTelegramField("chatId", e.target.value)}
              placeholder="e.g. 123456789"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={sendTelegramTest}
              disabled={telegramTesting || !settings.telegram?.chatId}
              className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
            >
              {telegramTesting ? "Sending…" : "Send test message"}
            </button>
          </div>
        </div>
        {telegramTestMsg && (
          <div className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-[11px] text-neutral-300">
            {telegramTestMsg}
          </div>
        )}

        <label className="flex items-center gap-2 text-xs text-neutral-300 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.telegram?.enabled ?? false}
            onChange={(e) => updateTelegramEnabled(e.target.checked)}
            className="rounded border-neutral-700 bg-neutral-800"
          />
          Enable Telegram notifications
        </label>

        <details>
          <summary className="cursor-pointer text-[11px] text-neutral-400">
            Advanced: read the token from an env var instead of storing it
          </summary>
          <div className="mt-2">
            <label className="mb-1 block text-xs text-neutral-400">
              Bot token env var
            </label>
            <input
              type="text"
              value={settings.telegram?.botTokenRef ?? ""}
              onChange={(e) => updateTelegramField("botTokenRef", e.target.value)}
              placeholder="TELEGRAM_BOT_TOKEN"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
            />
            <p className="mt-1 text-[10px] text-neutral-600">
              Used only when the token field above is empty.
            </p>
          </div>
        </details>
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="rounded bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save Settings"}
        </button>
        {dirty && (
          <span className="text-xs text-amber-400">
            Unsaved changes
          </span>
        )}
      </div>
    </div>
  );
}
