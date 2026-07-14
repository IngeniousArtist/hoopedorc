import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { makeAdapter, sanitizedEnv } from "@orc/adapters";
import { DEFAULT_GATE_IMAGE, resolveSandboxMode } from "@orc/engine";
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
  env?: NodeJS.ProcessEnv,
): Promise<SetupCheck> {
  try {
    const { stdout, stderr } = await pexec(cmd, args, {
      timeout: 20_000,
      env,
    });
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
 *  - `claude auth status` → Claude Code auth through the filtered child env,
 *  - `opencode auth list` → OpenCode model credentials,
 *  - `codex login status` → Codex auth through the filtered child env, but only
 *    checked (and only able to fail `allOk`) when a model in the roster is
 *    configured to use it — a claude/opencode-only setup shouldn't show a red
 *    X for a CLI it never calls.
 */
export async function runSetupChecks(settings: Settings): Promise<SetupHealthResponse> {
  const codexConfigured = settings.models.some((m) => m.runner === "codex");
  const agentEnv = sanitizedEnv();
  const checks = await Promise.all([
    check("GitHub CLI (gh)", "gh", ["auth", "status"], (s) => {
      const acct = s.match(/Logged in to [^\s]+ account (\S+)/);
      return acct ? `logged in as ${acct[1]}` : firstLine(s);
    }),
    check(
      "Claude Code (claude)",
      "claude",
      ["auth", "status", "--text"],
      firstLine,
      agentEnv,
    ),
    check(
      "OpenCode (opencode)",
      "opencode",
      ["auth", "list"],
      (s) => {
        const creds = s
          .split("\n")
          .filter((l) => l.trim() && !/^opencode|credentials|^\s*$/i.test(l));
        return creds.length ? `${creds.length} credential(s)` : firstLine(s);
      },
      agentEnv,
    ),
    codexConfigured
      ? check(
          "Codex CLI (codex)",
          "codex",
          ["login", "status"],
          firstLine,
          agentEnv,
        )
      : Promise.resolve({ name: "Codex CLI (codex)", ok: true, detail: "not configured" }),
    gateSandboxCheck(settings),
  ]);
  return { checks, allOk: checks.every((c) => c.ok) };
}

/**
 * F13-P1: read-only status line, not a pass/fail gate on its own — "auto"
 * falling back to host is a normal, fully-functional mode (just less
 * isolated), so it never turns the overall banner red. Only "required" with
 * no daemon is a real misconfiguration: every gate run would fail loudly the
 * moment a task reaches review.
 */
async function gateSandboxCheck(settings: Settings): Promise<SetupCheck> {
  const name = "Gate sandbox";
  try {
    const resolved = await resolveSandboxMode(settings.sandboxGates);
    // Per-project `gateImage` overrides aren't visible here (this check has
    // no project context) — show the default every project falls back to.
    const detail = resolved.useSandbox
      ? `docker (${DEFAULT_GATE_IMAGE}) — ${resolved.detail}`
      : resolved.detail;
    return { name, ok: true, detail };
  } catch (err) {
    return { name, ok: false, detail: (err as Error).message.slice(0, 200) };
  }
}

/**
 * The full `provider/model` roster `opencode models` reports as installed —
 * every id the onboarding wizard's model-mapping step can offer instead of
 * having the user type an id blind. Empty on failure (e.g. opencode not
 * installed yet) rather than throwing, since this is advisory only.
 */
export async function getModelRoster(): Promise<ModelRosterResponse> {
  try {
    const { stdout } = await pexec("opencode", ["models"], {
      timeout: 20_000,
      env: sanitizedEnv(),
    });
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
          // F33: "OK" only proved liveness, not identity — the owner wants to
          // see the model actually say who it is, so a passing test reads
          // like a real handshake instead of a cryptic two-letter footnote.
          prompt:
            "Say hello and state which AI model you are (name and version), in one short line.",
          cwd: tmpdir(),
          onLog: () => {},
        });
        const reply = (res.summary ?? "").trim().slice(0, 200);
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
