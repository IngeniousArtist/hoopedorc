import { realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { parseEnvironmentProfile, type Project } from "@orc/types";

export async function probeEnvironment(project: Project, sandboxed: boolean, execute: (command: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>, host = process.platform): Promise<string | undefined> {
  if (!project.config?.environment) return undefined;
  const parsed = parseEnvironmentProfile(project.config.environment);
  if ("error" in parsed) throw new Error(parsed.error);
  const profile = parsed.value; const platform = sandboxed ? "linux" : host;
  if (!["darwin", "linux"].includes(platform) || profile.platform !== "any" && profile.platform !== platform) throw new Error(`Environment requires ${profile.platform === "any" ? "macOS or Linux" : profile.platform}; selected ${sandboxed ? "Docker" : "host"} runtime is ${platform}. Choose a compatible host or gate environment.`);
  const result = await execute(profile.runtime, ["--version"]);
  const version = `${result.stdout}\n${result.stderr ?? ""}`.trim();
  const match = version.match(profile.runtime === "node" ? /^v(\d+)\.\d+\.\d+/ : /^Python (\d+)\.\d+\.\d+/);
  if (!match || version.length > 200) throw new Error(`Cannot verify ${profile.runtime} version in the selected environment.`);
  if (profile.majorVersion !== undefined && Number(match[1]) !== profile.majorVersion) throw new Error(`Environment requires ${profile.runtime} major ${profile.majorVersion}; observed ${version}. Install the required runtime or change the profile.`);
  return `${sandboxed ? `Docker ${project.config?.gateImage ?? "node:22"}` : `Host ${host}/${process.arch}`}; ${version}`;
}

/** Explicit inputs/outputs cannot reach outside the assigned repository. */
export function environmentFile(root: string, path: string): string {
  const base = realpathSync(root); const target = realpathSync(resolve(base, path));
  if (!target.startsWith(base + sep) || !statSync(target).isFile()) throw new Error(`Environment file must be a regular file inside this workspace: ${path}`);
  return target;
}
