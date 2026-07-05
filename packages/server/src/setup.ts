import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { makeAdapter } from "@orc/adapters";
import type {
  ModelRosterResponse,
  ModelTestResult,
  Settings,
  SetupCheck,
  SetupHealthResponse,
  TestModelsResponse,
} from "@orc/types";

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

/**
 * The full `provider/model` roster `opencode models` reports as installed —
 * every id the onboarding wizard's model-mapping step can offer instead of
 * having the user type an id blind. Empty on failure (e.g. opencode not
 * installed yet) rather than throwing, since this is advisory only.
 */
export async function getModelRoster(): Promise<ModelRosterResponse> {
  try {
    const { stdout } = await pexec("opencode", ["models"], { timeout: 20_000 });
    const models = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return { models };
  } catch {
    return { models: [] };
  }
}

/**
 * Run a trivial prompt through every enabled model to confirm it actually
 * responds (not just that auth exists). Costs a little real money, so this is
 * only invoked behind an explicit button. Runs all models in parallel.
 */
export async function testModels(
  settings: Settings,
  opencodeBaseUrl: string,
): Promise<TestModelsResponse> {
  const enabled = settings.models.filter((m) => m.enabled);
  const results: ModelTestResult[] = await Promise.all(
    enabled.map(async (cfg): Promise<ModelTestResult> => {
      const start = Date.now();
      try {
        const adapter = makeAdapter(cfg, opencodeBaseUrl);
        const res = await adapter.run({
          model: cfg.id,
          prompt: "Reply with exactly the two characters: OK",
          cwd: tmpdir(),
          onLog: () => {},
        });
        const reply = (res.summary ?? "").trim().slice(0, 80);
        return {
          id: cfg.id,
          displayName: cfg.displayName,
          ok: res.ok,
          costUsd: res.costUsd,
          ms: Date.now() - start,
          reply: reply || undefined,
          error: res.ok ? undefined : (res.summary || "no output").slice(0, 200),
        };
      } catch (err) {
        return {
          id: cfg.id,
          displayName: cfg.displayName,
          ok: false,
          costUsd: 0,
          ms: Date.now() - start,
          error: (err as Error).message.slice(0, 200),
        };
      }
    }),
  );
  const totalCostUsd = results.reduce((s, r) => s + r.costUsd, 0);
  return { results, totalCostUsd };
}
