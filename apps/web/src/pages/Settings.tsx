import {
  SECRET_SENTINEL,
  type MergePolicy,
  type ModelId,
  type RoutingPolicy,
  type Settings as SettingsType,
  type TelegramTestResponse,
} from "@orc/types";
import type { ModelConfig } from "@orc/types";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useBrowserNotify } from "../hooks/useBrowserNotify";
import { ModelsEditor } from "../components/ModelsEditor";
import { RoutingEditor } from "../components/RoutingEditor";

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

/** F31: injected into every author prompt (always) and validator review
 *  prompt (always) — ux is author-side-only-when-frontend, but still
 *  editable here regardless of role since it's a global setting. */
const GUIDELINE_FIELDS: {
  key: keyof NonNullable<SettingsType["guidelines"]>;
  label: string;
  hint: string;
}[] = [
  {
    key: "coding",
    label: "Coding",
    hint: "Always included in the author prompt and the validator's review prompt.",
  },
  {
    key: "ux",
    label: "UX",
    hint: 'Included only for frontend-role tasks (author + validator).',
  },
  {
    key: "security",
    label: "Security",
    hint: "Always included in the author prompt and the validator's review prompt.",
  },
];

export function Settings({
  onDirtyChange,
}: {
  /** U4: reports live dirty state upward so App.tsx can guard nav-away
   *  while there are unsaved edits — Settings unmounts on tab switch
   *  (`{page === "settings" && <Settings />}`), so App has to know
   *  *before* that happens, not read it after the fact. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const browserNotify = useBrowserNotify();
  const [settings, setSettings] = useState<SettingsType | null>(
    null,
  );
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // U11: U4's confirm only guards in-app tab switches — a reload or tab
  // close (an easy reflex on a phone) bypassed it entirely and discarded
  // edits silently. The browser's own "leave site?" prompt covers those;
  // its text is controlled by the browser, not this preventDefault() call.
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
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

  function updateGuidelines(
    key: keyof NonNullable<SettingsType["guidelines"]>,
    value: string,
  ) {
    setSettings((prev) =>
      prev
        ? {
            ...prev,
            guidelines: { ...(prev.guidelines ?? {}), [key]: value },
          }
        : prev,
    );
    setDirty(true);
    setSaved(false);
  }

  function updateApiToken(value: string) {
    setSettings((prev) =>
      prev ? { ...prev, apiToken: value || undefined } : prev,
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

  function updateTelegramDigest(digest: NonNullable<SettingsType["telegram"]>["digest"]) {
    setSettings((prev) =>
      prev
        ? {
            ...prev,
            telegram: { ...(prev.telegram ?? { enabled: false }), digest },
          }
        : prev,
    );
    setDirty(true);
    setSaved(false);
  }

  function updateTelegramModelAlerts(modelAlerts: boolean) {
    setSettings((prev) =>
      prev
        ? {
            ...prev,
            telegram: { ...(prev.telegram ?? { enabled: false }), modelAlerts },
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
      const botToken = settings?.telegram?.botToken;
      const res = await api<TelegramTestResponse>("telegramTest", {
        body: {
          // A redacted sentinel isn't a real token — omit it so the server
          // falls back to its own stored token instead of trying to auth
          // with the literal string "__SET__".
          token: botToken === SECRET_SENTINEL ? undefined : botToken,
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

      <RoutingEditor
        routing={settings.routing}
        models={enabledModels}
        onChange={updateRouting}
      />

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
        <h3 className="text-sm font-medium text-neutral-300">Guidelines</h3>
        <p className="text-[10px] text-neutral-600">
          Engineering standards injected into every author and validator
          prompt — the validator grades against the exact same text the
          author was given, so "meets the standards" is checkable rather
          than vibes. Blank a field to stop including that section.
        </p>
        {GUIDELINE_FIELDS.map(({ key, label, hint }) => (
          <div key={key}>
            <label className="mb-1 block text-xs text-neutral-400">
              {label}
            </label>
            <textarea
              value={settings.guidelines?.[key] ?? ""}
              onChange={(e) => updateGuidelines(key, e.target.value)}
              rows={5}
              maxLength={4000}
              className="w-full resize-y rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-200"
            />
            <p className="mt-1 text-[10px] text-neutral-600">{hint}</p>
          </div>
        ))}
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
        <h3 className="text-sm font-medium text-neutral-300">Security</h3>
        <div>
          <label className="mb-1 block text-xs text-neutral-400">
            API token
          </label>
          <input
            type="password"
            autoComplete="off"
            value={
              settings.apiToken === SECRET_SENTINEL
                ? ""
                : (settings.apiToken ?? "")
            }
            onChange={(e) => updateApiToken(e.target.value)}
            placeholder={
              settings.apiToken === SECRET_SENTINEL
                ? "token saved — enter to replace"
                : "unset — API is open to anything reaching this host"
            }
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
          />
          <p className="mt-1 text-[10px] text-neutral-600">
            When set, every request (HTTP and the WebSocket connection) must
            present this token. Frictionless on localhost by default; required
            if the server binds beyond localhost (the HOST env var) unless
            ALLOW_UNAUTHENTICATED=1 is set. The API_TOKEN env var, if present,
            overrides this.
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

      <section className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h3 className="text-sm font-medium text-neutral-300">
          Browser Notifications
        </h3>
        <p className="text-[11px] text-neutral-400">
          Fires a native browser notification for approvals and task failures
          while this tab is hidden — no need to keep it in the foreground.
          On phones, Telegram (below) is the more reliable channel.
        </p>
        {/* B24: order matters — a real support/context gap takes priority
            over the permission-state messaging below it. */}
        {!browserNotify.supported ? (
          <p className="text-[11px] text-amber-400">
            Not supported in this browser.
          </p>
        ) : !browserNotify.secureContext ? (
          <p className="text-[11px] text-amber-400">
            Needs HTTPS — this page isn't in a secure context (plain HTTP to
            another machine, e.g. over Tailscale, doesn't count). See{" "}
            <a
              href="https://github.com/IngeniousArtist/hoopedorc/blob/main/docs/USER_GUIDE.md"
              target="_blank"
              rel="noreferrer"
              className="text-blue-400 hover:underline"
            >
              the User Guide ↗
            </a>{" "}
            for the recommended <code>tailscale serve</code> remote setup.
          </p>
        ) : browserNotify.permission === "granted" && browserNotify.constructionFailed ? (
          <p className="text-[11px] text-amber-400">
            Permission granted, but this browser can't actually show page
            notifications (common on Android Chrome). Rely on Telegram for
            pings on this device.
          </p>
        ) : browserNotify.permission === "granted" ? (
          <p className="text-[11px] text-green-400">Enabled.</p>
        ) : browserNotify.permission === "denied" ? (
          <p className="text-[11px] text-red-400">
            Blocked — re-enable it from your browser's site settings.
          </p>
        ) : (
          <button
            onClick={() => browserNotify.requestPermission()}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
          >
            Enable browser notifications
          </button>
        )}
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
              value={
                settings.telegram?.botToken === SECRET_SENTINEL
                  ? ""
                  : (settings.telegram?.botToken ?? "")
              }
              onChange={(e) => updateTelegramField("botToken", e.target.value)}
              placeholder={
                settings.telegram?.botToken === SECRET_SENTINEL
                  ? "token saved — enter to replace"
                  : "123456789:ABCdef…"
              }
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

        <div>
          <label className="mb-1 block text-xs text-neutral-400">
            Task-status digest
          </label>
          <select
            value={settings.telegram?.digest ?? "terminal"}
            onChange={(e) =>
              updateTelegramDigest(
                e.target.value as NonNullable<SettingsType["telegram"]>["digest"],
              )
            }
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 sm:w-auto"
          >
            <option value="terminal">Terminal only — done/failed (default)</option>
            <option value="all">All — every status change, incl. in-progress</option>
            <option value="off">Off — approvals only, no status chatter</option>
          </select>
        </div>

        <label className="flex items-center gap-2 text-xs text-neutral-300 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.telegram?.modelAlerts ?? true}
            onChange={(e) => updateTelegramModelAlerts(e.target.checked)}
            className="rounded border-neutral-700 bg-neutral-800"
          />
          Alert me when a model hits trouble (rate limit, fallback switch, or
          exhausted with no fallback left)
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

      {/* U4: sticky so the save control (and the dirty hint) stay visible
          while scrolling this long form, instead of only being reachable
          at the very bottom. */}
      <div className="sticky bottom-0 z-10 flex items-center gap-3 border-t border-neutral-800 bg-neutral-950 py-3">
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
