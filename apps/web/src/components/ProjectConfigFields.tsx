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

  return Object.keys(config).length > 0 ? config : undefined;
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
        </div>
      )}
    </div>
  );
}
