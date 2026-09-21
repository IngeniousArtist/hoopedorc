import { useId, useState } from "react";
import { parseEnvironmentProfile, parseProjectCommand, type EnvironmentProfile, type ProjectConfig, type ValidationSlot } from "@orc/types";

export type CommandFields = Partial<Record<ValidationSlot, { command: string; args: string } | false>>;
const slots: ValidationSlot[] = ["typecheck", "lint", "build", "tests"];
const control = "min-h-10 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";
export function commandFields(commands: NonNullable<ProjectConfig["gates"]>["commands"]): CommandFields {
  return Object.fromEntries(Object.entries(commands ?? {}).map(([key, value]) => [key, value === false ? false : { command: value.command, args: JSON.stringify(value.args) }]));
}
export function parseCommandFields(fields: CommandFields): NonNullable<ProjectConfig["gates"]>["commands"] {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value === false ? false : { command: value.command.trim(), args: JSON.parse(value.args) as string[] }]));
}
export function environmentFormError(profile: EnvironmentProfile | undefined, fields: CommandFields): string | null {
  if (profile) { const parsed = parseEnvironmentProfile(profile); if ("error" in parsed) return parsed.error; }
  for (const [slot, value] of Object.entries(fields)) {
    if (value === false) continue;
    try { const parsed = parseProjectCommand({ command: value.command, args: JSON.parse(value.args) }); if ("error" in parsed) return `${slot}: ${parsed.error}`; }
    catch { return `${slot}: arguments must be a JSON array of literal strings, such as ["-m", "unittest"].`; }
  }
  return null;
}
export function environmentPreset(runtime: "node" | "python3"): Pick<ProjectConfig, "environment" | "setupCommand" | "gateImage" | "gates"> {
  const python = runtime === "python3";
  return { environment: { runtime, platform: "any", majorVersion: python ? 3 : 22, output: python ? "artifacts" : "web", setupInputs: [], setupOutputs: python ? [".hoopedorc-venv/pyvenv.cfg"] : [] },
    setupCommand: python ? { command: "python3", args: ["-m", "venv", ".hoopedorc-venv"] } : undefined,
    gateImage: python ? "python:3.12-slim" : "node:22",
    gates: { commands: python ? { typecheck: false, lint: false, build: false, tests: { command: ".hoopedorc-venv/bin/python", args: ["-B", "-m", "unittest", "discover", "-s", "tests", "-v"] } } : undefined } };
}
export function EnvironmentFields({ profile, commands, onChange, onPreset }: { profile?: EnvironmentProfile; commands: CommandFields; onChange: (profile: EnvironmentProfile | undefined, commands: CommandFields) => void; onPreset: (runtime: "node" | "python3") => void }) {
  const id = useId(); const [pending, setPending] = useState<"node" | "python3">();
  const error = environmentFormError(profile, commands);
  return <section aria-label="Project environment" className="space-y-3 rounded border border-neutral-700 p-3">
    <h3 className="text-sm font-medium">Environment and validation</h3>
    <p className="text-neutral-400">Start with your repository’s tools. Presets are editable commands, not a claim that every framework is installed.</p>
    <div className="flex flex-wrap gap-2">{(["node", "python3"] as const).map((runtime) => <button type="button" key={runtime} className="min-h-10 rounded border border-neutral-600 px-3 focus-visible:ring-2 focus-visible:ring-blue-500" onClick={() => setPending(runtime)}>{runtime === "node" ? "Node web preset" : "Python backend preset"}</button>)}</div>
    {pending && <div className="space-y-2 rounded border border-amber-700 p-3"><p>Replace runtime, setup, gate commands and gate image with the {pending === "node" ? "Node 22 web" : "Python 3 standard-library backend"} preset? Other project settings and preview commands stay as they are.</p><button type="button" className="min-h-10 rounded border px-3 focus-visible:ring-2 focus-visible:ring-blue-500" onClick={() => { onPreset(pending); setPending(undefined); }}>Apply preset</button> <button type="button" className="min-h-10 px-3 focus-visible:ring-2 focus-visible:ring-blue-500" onClick={() => setPending(undefined)}>Cancel preset</button></div>}
    <label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={!!profile} onChange={(event) => onChange(event.target.checked ? environmentPreset("node").environment : undefined, commands)} />Require a verified project runtime</label>
    {profile && <>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>Runtime<select className={control} value={profile.runtime} onChange={(e) => onChange({ ...profile, runtime: e.target.value as EnvironmentProfile["runtime"] }, commands)}><option value="node">Node.js</option><option value="python3">Python 3</option></select></label>
        <label>Required major version<input className={control} inputMode="numeric" value={profile.majorVersion ?? ""} onChange={(e) => onChange({ ...profile, majorVersion: e.target.value ? Number(e.target.value) : undefined }, commands)} placeholder="Any installed version" /></label>
        <label>Compatible platform<select className={control} value={profile.platform} onChange={(e) => onChange({ ...profile, platform: e.target.value as EnvironmentProfile["platform"] }, commands)}><option value="any">macOS or Linux</option><option value="darwin">macOS only</option><option value="linux">Linux only</option></select></label>
        <label>Review output<select className={control} value={profile.output} onChange={(e) => onChange({ ...profile, output: e.target.value as EnvironmentProfile["output"] }, commands)}><option value="web">Web preview and browser evidence</option><option value="artifacts">Checks and supplied artifacts</option></select></label>
      </div>
      {(["setupInputs", "setupOutputs"] as const).map((key) => <label className="block" key={key}>{key === "setupInputs" ? "Additional setup inputs" : "Required setup output files"}<textarea className={control} value={profile[key].join("\n")} onChange={(e) => onChange({ ...profile, [key]: e.target.value.split("\n").filter(Boolean) }, commands)} placeholder="One repository-relative file per line" /></label>)}
      <p className="text-neutral-400">Setup &amp; Health probes the actual host or gate container. Docker is Linux; native Apple tools need a Mac. External databases/services must be provisioned separately. Configure web start/readiness in Workspaces; use Review for artifacts.</p>
    </>}
    <p className="text-neutral-400">Explicit commands below override the legacy gate fields. Arguments are JSON arrays; no shell splitting.</p>
    {slots.map((slot) => { const value = commands[slot]; return <div className="space-y-2" key={slot}>
      <label htmlFor={`${id}-${slot}`}>{slot} execution</label><select id={`${id}-${slot}`} className={control} value={value === undefined ? "legacy" : value === false ? "skip" : "command"} onChange={(e) => { const next = { ...commands }; if (e.target.value === "legacy") delete next[slot]; else next[slot] = e.target.value === "skip" ? false : { command: "", args: "[]" }; onChange(profile, next); }}><option value="legacy">Use existing script/default</option><option value="command">Explicit command</option><option value="skip">Deliberately skip</option></select>
      {value && <div className="grid gap-2 sm:grid-cols-2"><label>{slot} executable<input className={control} value={value.command} onChange={(e) => onChange(profile, { ...commands, [slot]: { ...value, command: e.target.value } })} /></label><label>{slot} arguments<textarea className={control} value={value.args} onChange={(e) => onChange(profile, { ...commands, [slot]: { ...value, args: e.target.value } })} /></label></div>}
    </div>; })}
    {error && <p role="alert" className="text-red-300">{error}</p>}
  </section>;
}
