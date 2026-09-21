import { execManagedProcess, sanitizedEnv, GEMINI_VERSION, SELECTIVE_CLAUDE_VERSION } from "@orc/adapters";
import type { HarnessCompatibility, HarnessCompatibilityResponse, RunnerKind } from "@orc/types";

const definitions: { runner: RunnerKind; label: string; command: string; verifiedVersion: string }[] = [
  { runner: "claude-code", label: "Claude Code", command: "claude", verifiedVersion: SELECTIVE_CLAUDE_VERSION },
  { runner: "codex", label: "Codex", command: "codex", verifiedVersion: "0.154.0" },
  { runner: "opencode", label: "OpenCode", command: "opencode", verifiedVersion: "1.18.30" },
  { runner: "gemini", label: "Gemini CLI", command: "gemini", verifiedVersion: GEMINI_VERSION },
];
export type VersionProbe = (command: string, signal?: AbortSignal) => Promise<string>;
const probeVersion: VersionProbe = async (command, signal) => (await execManagedProcess(command, ["--version"], { signal, env: sanitizedEnv(), timeoutMs: 15_000, maxOutputBytes: 32_768 })).stdout;
/** No auth/model calls. Mock mode never invokes installed programs. */
export async function harnessCompatibility(mock: boolean, signal?: AbortSignal, probe: VersionProbe = probeVersion): Promise<HarnessCompatibilityResponse> {
  const harnesses = await Promise.all(definitions.map(async (entry): Promise<HarnessCompatibility> => {
    const base = { runner: entry.runner, label: entry.label, verifiedVersion: entry.verifiedVersion, native: false, selective: false, isolated: false, plugins: false as const, providerAcceptance: "operator-check-required" as const };
    if (mock) return { ...base, probe: "mock", detail: "Demo only. Installed tools and provider access have not been checked." };
    try {
      const output = await probe(entry.command, signal);
      const installedVersion = output.trim().match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/)?.[1];
      if (!installedVersion) throw new Error("Unrecognized version output.");
      const exact = installedVersion === entry.verifiedVersion;
      return { ...base, installedVersion, probe: "available", native: entry.runner !== "gemini" || exact,
        selective: entry.runner === "claude-code" && exact, isolated: entry.runner === "codex" && exact,
        detail: `${exact ? "Matches the inspected CLI version." : `Outside the inspected ${entry.verifiedVersion} version; verify before unattended use.`} ${entry.runner === "gemini" ? "Native only; configure a model ID and cached CLI login. " : ""}Selected activation is Claude-only. Isolation requires a separately verified Codex worker profile. Native CLI configuration remains inherited. Provider access requires an explicit model test.` };
    } catch {
      signal?.throwIfAborted();
      return { ...base, probe: "unavailable", detail: `Could not read ${entry.command} --version. Install the inspected version on the server PATH, then refresh. No provider call was made.` };
    }
  }));
  return { generatedAt: new Date().toISOString(), harnesses };
}
