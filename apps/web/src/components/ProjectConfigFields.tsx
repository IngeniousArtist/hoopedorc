import type { MergePolicy, ProjectConfig } from "@orc/types";
import { useState } from "react";

/** Form-friendly mirror of ProjectConfig (F9) — every field is a string/bool
 *  so it can sit in plain <input>s; converted to/from ProjectConfig at the
 *  edges (projectConfigFromForm / projectConfigToForm). */
export interface ProjectConfigForm {
  mergePolicy: MergePolicy | "";
  maxAttempts: string;
  typecheckScript: string;
  typecheckSkip: boolean;
  lintScript: string;
  lintSkip: boolean;
  buildScript: string;
  buildSkip: boolean;
  testScript: string;
  testSkip: boolean;
  testCommand: string;
  /** F13-P1: Docker image gate scripts run inside when Settings.sandboxGates
   *  isn't "off". Blank = DEFAULT_GATE_IMAGE ("node:22"). */
  gateImage: string;
  requireGithubChecks: boolean;
  githubChecksTimeoutMin: string;
  docsDisabled: boolean;
  scheduleEnabled: boolean;
  scheduleMode: "interval" | "daily";
  scheduleIntervalHours: string;
  scheduleHour: string;
  scheduleMinute: string;
  /** F34: one skill hint per line, e.g. "skill-name — when to use it". */
  skillHints: string;
}

export const EMPTY_PROJECT_CONFIG_FORM: ProjectConfigForm = {
  mergePolicy: "",
  maxAttempts: "",
  typecheckScript: "",
  typecheckSkip: false,
  lintScript: "",
  lintSkip: false,
  buildScript: "",
  buildSkip: false,
  testScript: "",
  testSkip: false,
  testCommand: "",
  gateImage: "",
  requireGithubChecks: false,
  githubChecksTimeoutMin: "",
  docsDisabled: false,
  scheduleEnabled: false,
  scheduleMode: "daily",
  scheduleIntervalHours: "",
  scheduleHour: "",
  scheduleMinute: "",
  skillHints: "",
};

export function projectConfigToForm(config: ProjectConfig | undefined): ProjectConfigForm {
  if (!config) return EMPTY_PROJECT_CONFIG_FORM;
  const g = config.gates ?? {};
  return {
    mergePolicy: config.mergePolicy ?? "",
    maxAttempts: config.maxAttempts != null ? String(config.maxAttempts) : "",
    typecheckScript: typeof g.typecheckScript === "string" ? g.typecheckScript : "",
    typecheckSkip: g.typecheckScript === false,
    lintScript: typeof g.lintScript === "string" ? g.lintScript : "",
    lintSkip: g.lintScript === false,
    buildScript: typeof g.buildScript === "string" ? g.buildScript : "",
    buildSkip: g.buildScript === false,
    testScript: typeof g.testScript === "string" ? g.testScript : "",
    testSkip: g.testScript === false,
    testCommand: g.testCommand ?? "",
    gateImage: config.gateImage ?? "",
    requireGithubChecks: config.requireGithubChecks ?? false,
    githubChecksTimeoutMin:
      config.githubChecksTimeoutMin != null ? String(config.githubChecksTimeoutMin) : "",
    docsDisabled: config.perTaskDocs === false,
    scheduleEnabled: config.schedule?.enabled ?? false,
    scheduleMode: config.schedule?.mode ?? "daily",
    scheduleIntervalHours:
      config.schedule?.intervalHours != null ? String(config.schedule.intervalHours) : "",
    scheduleHour: config.schedule?.hour != null ? String(config.schedule.hour) : "",
    scheduleMinute: config.schedule?.minute != null ? String(config.schedule.minute) : "",
    skillHints: config.skillHints?.join("\n") ?? "",
  };
}

export function projectConfigFromForm(form: ProjectConfigForm): ProjectConfig | undefined {
  const config: ProjectConfig = {};
  if (form.mergePolicy) config.mergePolicy = form.mergePolicy;
  if (form.maxAttempts.trim()) {
    const n = parseInt(form.maxAttempts, 10);
    if (Number.isFinite(n)) config.maxAttempts = n;
  }

  const gates: NonNullable<ProjectConfig["gates"]> = {};
  const addGate = (
    key: "typecheckScript" | "lintScript" | "buildScript" | "testScript",
    skip: boolean,
    value: string,
  ) => {
    if (skip) gates[key] = false;
    else if (value.trim()) gates[key] = value.trim();
  };
  addGate("typecheckScript", form.typecheckSkip, form.typecheckScript);
  addGate("lintScript", form.lintSkip, form.lintScript);
  addGate("buildScript", form.buildSkip, form.buildScript);
  addGate("testScript", form.testSkip, form.testScript);
  if (form.testCommand.trim()) gates.testCommand = form.testCommand.trim();
  if (Object.keys(gates).length > 0) config.gates = gates;

  if (form.gateImage.trim()) config.gateImage = form.gateImage.trim();

  if (form.requireGithubChecks) config.requireGithubChecks = true;
  if (form.githubChecksTimeoutMin.trim()) {
    const n = parseInt(form.githubChecksTimeoutMin, 10);
    if (Number.isFinite(n)) config.githubChecksTimeoutMin = n;
  }

  // perTaskDocs defaults to true engine-side — only ever set it explicitly
  // to false (the opt-out), never true, so an unset project keeps behaving
  // exactly as before F30.
  if (form.docsDisabled) config.perTaskDocs = false;

  // U7: emit the schedule fields even when the enable checkbox is off, as
  // long as they're filled in — otherwise unchecking + saving drops the
  // whole object, and re-enabling later starts from blank inputs. The
  // scheduler (isScheduleDue) already checks `enabled` first, so persisting
  // a disabled schedule is inert.
  if (form.scheduleMode === "interval") {
    if (form.scheduleIntervalHours.trim()) {
      const n = parseInt(form.scheduleIntervalHours, 10);
      if (Number.isFinite(n) && n > 0) {
        config.schedule = { enabled: form.scheduleEnabled, mode: "interval", intervalHours: n };
      }
    }
  } else if (form.scheduleHour.trim() && form.scheduleMinute.trim()) {
    const hour = parseInt(form.scheduleHour, 10);
    const minute = parseInt(form.scheduleMinute, 10);
    if (Number.isFinite(hour) && Number.isFinite(minute)) {
      config.schedule = { enabled: form.scheduleEnabled, mode: "daily", hour, minute };
    }
  }

  const hints = form.skillHints
    .split("\n")
    .map((h) => h.trim())
    .filter((h) => h.length > 0)
    .slice(0, 20);
  if (hints.length > 0) config.skillHints = hints;

  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * B22: `projectConfigFromForm` silently drops the whole schedule when the
 * fields for the *current* mode are incomplete — e.g. hour filled but
 * minute blank, or the mode switched to interval while only the (now
 * irrelevant) daily fields are filled — which deletes a previously saved
 * schedule with no warning. Returns a message when the form shows signs of
 * schedule intent (the enable checkbox, or any of the mode's own fields)
 * but doesn't have everything the current mode needs; null when the form is
 * either fully blank (no schedule intended — fine) or fully complete.
 */
export function projectConfigFormError(form: ProjectConfigForm): string | null {
  const hasIntent =
    form.scheduleEnabled ||
    form.scheduleHour.trim() !== "" ||
    form.scheduleMinute.trim() !== "" ||
    form.scheduleIntervalHours.trim() !== "";
  if (!hasIntent) return null;

  if (form.scheduleMode === "daily") {
    if (form.scheduleHour.trim() === "" || form.scheduleMinute.trim() === "") {
      return "Daily schedule needs both an hour and a minute.";
    }
  } else if (form.scheduleIntervalHours.trim() === "") {
    return "Interval schedule needs a number of hours.";
  }
  return null;
}

const MERGE_POLICIES: { value: MergePolicy; label: string }[] = [
  { value: "hard_gate_flag_risky", label: "Hard gate + flag risky" },
  { value: "fully_autonomous", label: "Fully autonomous" },
  { value: "always_ask", label: "Always ask" },
];

const inputCls =
  "w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200";

function GateRow({
  label,
  script,
  skip,
  onScript,
  onSkip,
}: {
  label: string;
  script: string;
  skip: boolean;
  onScript: (v: string) => void;
  onSkip: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-neutral-400">{label}</span>
      <input
        type="text"
        value={script}
        disabled={skip}
        onChange={(e) => onScript(e.target.value)}
        placeholder={`npm script (default: "${label}")`}
        className={`${inputCls} disabled:opacity-40`}
      />
      <label className="flex shrink-0 items-center gap-1 text-neutral-400">
        <input type="checkbox" checked={skip} onChange={(e) => onSkip(e.target.checked)} />
        skip
      </label>
    </div>
  );
}

/**
 * Shared "Advanced" project-config editor (F9) — used by both NewProject (on
 * create) and ProjectHeader (post-creation edits). All fields optional;
 * leaving everything blank keeps the global/default behavior.
 */
export function ProjectConfigFields({
  form,
  onChange,
}: {
  form: ProjectConfigForm;
  onChange: (form: ProjectConfigForm) => void;
}) {
  const [open, setOpen] = useState(false);
  const set = <K extends keyof ProjectConfigForm>(key: K, value: ProjectConfigForm[K]) =>
    onChange({ ...form, [key]: value });
  const scheduleError = projectConfigFormError(form);

  return (
    <div className="rounded border border-neutral-800">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800/50"
      >
        <span>Advanced (gates, retries, merge policy)</span>
        <span>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-neutral-800 px-3 py-3 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-neutral-400">Merge policy override</label>
              <select
                value={form.mergePolicy}
                onChange={(e) => set("mergePolicy", e.target.value as MergePolicy | "")}
                className={inputCls}
              >
                <option value="">Use global setting</option>
                {MERGE_POLICIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-neutral-400">Max attempts override</label>
              <input
                type="number"
                min={1}
                max={20}
                value={form.maxAttempts}
                onChange={(e) => set("maxAttempts", e.target.value)}
                placeholder="default: 3"
                className={inputCls}
              />
            </div>
          </div>

          <div>
            <div className="mb-1 text-neutral-400">
              Gate scripts — npm scripts that must pass before auto-merge (blank = default name)
            </div>
            <div className="space-y-1">
              <GateRow
                label="typecheck"
                script={form.typecheckScript}
                skip={form.typecheckSkip}
                onScript={(v) => set("typecheckScript", v)}
                onSkip={(v) => set("typecheckSkip", v)}
              />
              <GateRow
                label="lint"
                script={form.lintScript}
                skip={form.lintSkip}
                onScript={(v) => set("lintScript", v)}
                onSkip={(v) => set("lintSkip", v)}
              />
              <GateRow
                label="build"
                script={form.buildScript}
                skip={form.buildSkip}
                onScript={(v) => set("buildScript", v)}
                onSkip={(v) => set("buildSkip", v)}
              />
              <GateRow
                label="test"
                script={form.testScript}
                skip={form.testSkip}
                onScript={(v) => set("testScript", v)}
                onSkip={(v) => set("testSkip", v)}
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-neutral-400">
              Test command override (non-npm stacks, e.g. "pytest -q" or "cargo test")
            </label>
            <input
              type="text"
              value={form.testCommand}
              onChange={(e) => set("testCommand", e.target.value)}
              placeholder="runs via execFile — no shell, split on spaces"
              className={inputCls}
            />
          </div>

          <div>
            <label className="mb-1 block text-neutral-400">
              Gate sandbox image (Docker, only used when sandboxing is on)
            </label>
            <input
              type="text"
              value={form.gateImage}
              onChange={(e) => set("gateImage", e.target.value)}
              placeholder='default: "node:22"'
              className={inputCls}
            />
            <p className="mt-1 text-[10px] text-neutral-600">
              Only matters for a non-Node test command (e.g. "pytest -q")
              when Setup &amp; Health shows the gate sandbox as active — the
              image needs that stack installed.
            </p>
          </div>

          <div>
            <label className="mb-1 flex items-center gap-2 text-neutral-400">
              <input
                type="checkbox"
                checked={form.requireGithubChecks}
                onChange={(e) => set("requireGithubChecks", e.target.checked)}
              />
              Wait for the PR's own GitHub checks before auto-merging
            </label>
            {form.requireGithubChecks && (
              <input
                type="number"
                min={1}
                max={120}
                value={form.githubChecksTimeoutMin}
                onChange={(e) => set("githubChecksTimeoutMin", e.target.value)}
                placeholder="timeout minutes (default: 15)"
                className={`${inputCls} mt-1`}
              />
            )}
          </div>

          <div>
            <label className="mb-1 flex items-center gap-2 text-neutral-400">
              <input
                type="checkbox"
                checked={form.docsDisabled}
                onChange={(e) => set("docsDisabled", e.target.checked)}
              />
              Skip the automatic docs commit (CHANGELOG/README) after each
              task merges
            </label>
          </div>

          <div>
            <label className="mb-1 block text-neutral-400">
              Skill hints for the author model — one per line, "skill name — when to use it"
            </label>
            <textarea
              value={form.skillHints}
              onChange={(e) => set("skillHints", e.target.value)}
              placeholder={
                "frontend-design-guidelines — read before building any UI component"
              }
              rows={3}
              className={`${inputCls} resize-y font-mono`}
            />
            <p className="mt-1 text-[10px] text-neutral-600">
              Nudges the author toward skills it should use in this repo.
              Only Claude Code has a real skills mechanism (
              <code>~/.claude/skills/</code> or the repo's own{" "}
              <code>.claude/skills/</code>); other runners just see this as
              extra instructions.
            </p>
          </div>

          <div>
            <label className="mb-1 flex items-center gap-2 text-neutral-400">
              <input
                type="checkbox"
                checked={form.scheduleEnabled}
                onChange={(e) => set("scheduleEnabled", e.target.checked)}
              />
              Auto-start this project on a schedule (cron-style, for
              maintenance tasks)
            </label>
            {form.scheduleEnabled && (
              <div className="mt-1 flex items-center gap-2">
                <select
                  value={form.scheduleMode}
                  onChange={(e) =>
                    set("scheduleMode", e.target.value as "interval" | "daily")
                  }
                  className={inputCls}
                >
                  <option value="daily">Daily at</option>
                  <option value="interval">Every N hours</option>
                </select>
                {form.scheduleMode === "daily" ? (
                  <>
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={form.scheduleHour}
                      onChange={(e) => set("scheduleHour", e.target.value)}
                      placeholder="HH (0-23)"
                      className={inputCls}
                    />
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={form.scheduleMinute}
                      onChange={(e) => set("scheduleMinute", e.target.value)}
                      placeholder="MM (0-59)"
                      className={inputCls}
                    />
                  </>
                ) : (
                  <input
                    type="number"
                    min={1}
                    max={720}
                    value={form.scheduleIntervalHours}
                    onChange={(e) => set("scheduleIntervalHours", e.target.value)}
                    placeholder="hours"
                    className={inputCls}
                  />
                )}
              </div>
            )}
            <p className="mt-1 text-[10px] text-neutral-600">
              Times are the server's local clock. Calls the same Start the
              button above does — it won't pile up on top of an active run.
            </p>
            {/* B22: surfaced here (in addition to the save-site message) so
                it's visible right next to the fields that need fixing. */}
            {scheduleError && (
              <p className="mt-1 text-[10px] text-amber-400">{scheduleError}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
