import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SetupCheck, SetupHealthResponse } from "@orc/types";

const pexec = promisify(execFile);

const firstLine = (s: string) => s.trim().split("\n")[0]?.trim() ?? "ok";

async function check(
  name: string,
  cmd: string,
  args: string[],
  parse: (out: string) => string = firstLine,
): Promise<SetupCheck> {
  try {
    const { stdout, stderr } = await pexec(cmd, args, { timeout: 20_000 });
    return { name, ok: true, detail: parse(`${stdout}\n${stderr}`).slice(0, 200) };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return {
      name,
      ok: false,
      detail: (e.stderr || e.message || "not found / not authenticated")
        .toString()
        .trim()
        .slice(0, 200),
    };
  }
}

/**
 * Probe the external CLIs the orchestrator depends on, so the user can confirm
 * everything is green before spending money. Each must exit 0:
 *  - `gh auth status`  → GitHub auth (push/PR/merge),
 *  - `claude --version`→ Claude Code present (planner/validator),
 *  - `opencode auth list` → OpenCode model credentials.
 */
export async function runSetupChecks(): Promise<SetupHealthResponse> {
  const checks = await Promise.all([
    check("GitHub CLI (gh)", "gh", ["auth", "status"], (s) => {
      const acct = s.match(/Logged in to [^\s]+ account (\S+)/);
      return acct ? `logged in as ${acct[1]}` : firstLine(s);
    }),
    check("Claude Code (claude)", "claude", ["--version"]),
    check("OpenCode (opencode)", "opencode", ["auth", "list"], (s) => {
      const creds = s
        .split("\n")
        .filter((l) => l.trim() && !/^opencode|credentials|^\s*$/i.test(l));
      return creds.length ? `${creds.length} credential(s)` : firstLine(s);
    }),
  ]);
  return { checks, allOk: checks.every((c) => c.ok) };
}
