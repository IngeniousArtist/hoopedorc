/** Commands are argv, never shell expressions. */
export interface ProjectCommand { command: string; args: string[] }
export type ValidationSlot = "typecheck" | "lint" | "build" | "tests";
export interface EnvironmentProfile {
  runtime: "node" | "python3";
  platform: "any" | "darwin" | "linux";
  majorVersion?: number;
  output: "web" | "artifacts";
  /** Additional repository files that invalidate custom setup reuse. */
  setupInputs: string[];
  /** Required outputs; missing files force setup to run again. */
  setupOutputs: string[];
}
export function parseProjectCommand(input: unknown): { value: ProjectCommand } | { error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "command must be an object" };
  const p = input as ProjectCommand;
  if (typeof p.command !== "string" || !p.command.trim() || p.command.length > 200 || /[\0\r\n]/.test(p.command)) return { error: "command must be a non-empty executable name (<=200 chars)" };
  if (!Array.isArray(p.args) || p.args.length > 100 || p.args.some((arg) => typeof arg !== "string" || arg.length > 1000 || arg.includes("\0"))) return { error: "args must contain at most 100 literal strings, each <=1000 chars" };
  return { value: { command: p.command.trim(), args: [...p.args] } };
}
export function parseEnvironmentProfile(input: unknown): { value: EnvironmentProfile } | { error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "environment must be an object" };
  const p = input as EnvironmentProfile;
  if (!["node", "python3"].includes(p.runtime) || !["any", "darwin", "linux"].includes(p.platform) || !["web", "artifacts"].includes(p.output)) return { error: "environment needs a supported runtime, platform and output type" };
  if (p.majorVersion !== undefined && (!Number.isInteger(p.majorVersion) || p.majorVersion < 1 || p.majorVersion > 100)) return { error: "environment.majorVersion must be an integer from 1 to 100" };
  for (const key of ["setupInputs", "setupOutputs"] as const) {
    if (!Array.isArray(p[key]) || p[key].length > 20 || p[key].some((path) => typeof path !== "string" || !path || path.length > 300 || path.startsWith("/") || /[\\\0\r\n:]/.test(path) || path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git"))) return { error: `environment.${key} must contain at most 20 safe repository-relative paths` };
  }
  return { value: { runtime: p.runtime, platform: p.platform, output: p.output, ...(p.majorVersion !== undefined ? { majorVersion: p.majorVersion } : {}), setupInputs: [...p.setupInputs], setupOutputs: [...p.setupOutputs] } };
}
