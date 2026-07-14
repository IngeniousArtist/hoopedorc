import type { ProjectConfig } from "@orc/types";

type SetupCommand = NonNullable<ProjectConfig["setupCommand"]>;

/** B38's API boundary for direct, non-shell project setup commands. */
export function parseSetupCommand(
  input: unknown,
): { error: string } | { value: SetupCommand } {
  if (typeof input !== "object" || input === null) {
    return { error: "config.setupCommand must be an object" };
  }
  const setup = input as Record<string, unknown>;
  if (
    typeof setup.command !== "string" ||
    setup.command.trim().length === 0 ||
    setup.command.length > 200 ||
    setup.command.includes("\0")
  ) {
    return { error: "config.setupCommand.command must be a non-empty string (<=200 chars)" };
  }
  if (!Array.isArray(setup.args) || setup.args.length > 100) {
    return { error: "config.setupCommand.args must be an array with at most 100 entries" };
  }
  const args: string[] = [];
  for (const arg of setup.args) {
    if (typeof arg !== "string" || arg.length > 1_000 || arg.includes("\0")) {
      return { error: "config.setupCommand.args entries must be strings of at most 1000 chars" };
    }
    args.push(arg);
  }
  return { value: { command: setup.command.trim(), args } };
}
