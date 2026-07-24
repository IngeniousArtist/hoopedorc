import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { makeAdapter, sanitizedEnv } from "@orc/adapters";
import { DEFAULT_GATE_IMAGE, resolveSandboxMode, WorktreeManagerImpl } from "@orc/engine";
import type {
  ModelCatalogEntry,
  ModelCatalogResponse,
  ModelRosterResponse,
  ModelInvocation,
  ModelTestResult,
  Project,
  RunnerModelCatalog,
  Settings,
  SetupCheck,
  SetupHealthResponse,
  TestModelsResponse,
} from "@orc/types";

const pexec = promisify(execFile);
const MODEL_CATALOG_MAX_BUFFER = 16 * 1024 * 1024;

const firstLine = (s: string) => s.trim().split("\n")[0]?.trim() ?? "ok";

function cliErrorMessage(err: unknown): string {
  const error = err as { stderr?: string; stdout?: string; message?: string };
  return (error.stderr || error.stdout || error.message || String(err))
    .toString()
    .trim()
    .slice(0, 300);
}

async function check(
  name: string,
  cmd: string,
  args: string[],
  parse: (out: string) => string = firstLine,
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<SetupCheck> {
  try {
    const { stdout, stderr } = await pexec(cmd, args, {
      timeout: 20_000,
      env,
      signal,
    });
    return { name, ok: true, detail: parse(`${stdout}\n${stderr}`).slice(0, 200) };
  } catch (err) {
    signal?.throwIfAborted();
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
export async function runSetupChecks(
  settings: Settings,
  projects: Project[] = [],
  signal?: AbortSignal,
): Promise<SetupHealthResponse> {
  const codexConfigured = settings.models.some((m) => m.runner === "codex");
  const agentEnv = sanitizedEnv();
  const projectChecks = await projectSetupChecks(settings, projects, signal);
  const checks = await Promise.all<SetupCheck>([
    check("GitHub CLI (gh)", "gh", ["auth", "status"], (s) => {
      const acct = s.match(/Logged in to [^\s]+ account (\S+)/);
      return acct ? `logged in as ${acct[1]}` : firstLine(s);
    }, undefined, signal),
    check(
      "Claude Code (claude)",
      "claude",
      ["auth", "status", "--text"],
      firstLine,
      agentEnv,
      signal,
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
      signal,
    ),
    codexConfigured
      ? check(
          "Codex CLI (codex)",
          "codex",
          ["login", "status"],
          firstLine,
          agentEnv,
          signal,
        )
      : Promise.resolve({ name: "Codex CLI (codex)", ok: true, detail: "not configured" }),
    gateSandboxCheck(settings, signal),
  ]);
  checks.push(...projectChecks);
  return { checks, allOk: checks.every((c) => c.ok) };
}

export async function projectSetupChecks(
  settings: Pick<Settings, "sandboxGates">,
  projects: Project[],
  signal?: AbortSignal,
): Promise<SetupCheck[]> {
  const projectSetup = new WorktreeManagerImpl(settings);
  return Promise.all(
    projects.map(async (project): Promise<SetupCheck> => {
      const result = await projectSetup.setupHealth(project, signal);
      return {
        name: `Project setup — ${project.name}`,
        ok: result.ok,
        detail: result.detail.slice(0, 500),
      };
    }),
  );
}

/**
 * F13-P1: read-only status line, not a pass/fail gate on its own — "auto"
 * falling back to host is a normal, fully-functional mode (just less
 * isolated), so it never turns the overall banner red. Only "required" with
 * no daemon is a real misconfiguration: every gate run would fail loudly the
 * moment a task reaches review.
 */
async function gateSandboxCheck(
  settings: Settings,
  signal?: AbortSignal,
): Promise<SetupCheck> {
  const name = "Gate sandbox";
  try {
    signal?.throwIfAborted();
    const resolved = await resolveSandboxMode(settings.sandboxGates);
    signal?.throwIfAborted();
    // Per-project `gateImage` overrides aren't visible here (this check has
    // no project context) — show the default every project falls back to.
    const detail = resolved.useSandbox
      ? `docker (${DEFAULT_GATE_IMAGE}) — ${resolved.detail}`
      : resolved.detail;
    return { name, ok: true, detail };
  } catch (err) {
    signal?.throwIfAborted();
    return { name, ok: false, detail: (err as Error).message.slice(0, 200) };
  }
}

/**
 * The full `provider/model` roster `opencode models` reports as installed —
 * every id the onboarding wizard's model-mapping step can offer instead of
 * having the user type an id blind. Empty on failure (e.g. opencode not
 * installed yet) rather than throwing, since this is advisory only.
 */
export async function getModelRoster(signal?: AbortSignal): Promise<ModelRosterResponse> {
  try {
    return { models: await readOpenCodeModels(signal) };
  } catch {
    signal?.throwIfAborted();
    return { models: [] };
  }
}

async function readOpenCodeModels(signal?: AbortSignal): Promise<string[]> {
  const { stdout } = await pexec("opencode", ["models"], {
    timeout: 20_000,
    maxBuffer: MODEL_CATALOG_MAX_BUFFER,
    env: sanitizedEnv(),
    signal,
  });
  return [...new Set(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  )];
}

const CLAUDE_CODE_MODELS: ModelCatalogEntry[] = [
  {
    slug: "fable",
    displayName: "Fable (latest alias)",
    description: "Short Claude Code alias for the current Fable model.",
    kind: "alias",
  },
  {
    slug: "opus",
    displayName: "Opus (latest alias)",
    description: "Short Claude Code alias for the current Opus model.",
    kind: "alias",
  },
  {
    slug: "sonnet",
    displayName: "Sonnet (latest alias)",
    description: "Short Claude Code alias for the current Sonnet model.",
    kind: "alias",
  },
  {
    slug: "claude-fable-5",
    displayName: "Claude Fable 5",
    description: "Next-generation model for the hardest coding and knowledge work.",
    kind: "model",
  },
  {
    slug: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    description: "Frontier model for long-running agents and complex coding.",
    kind: "model",
  },
  {
    slug: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    description: "Frontier model for long-running agents and coding.",
    kind: "model",
  },
  {
    slug: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    description: "High-capability model for agents and coding.",
    kind: "model",
  },
  {
    slug: "claude-opus-4-5",
    displayName: "Claude Opus 4.5 alias",
    description: "Convenience alias for the latest Claude Opus 4.5 snapshot.",
    kind: "alias",
  },
  {
    slug: "claude-opus-4-5-20251101",
    displayName: "Claude Opus 4.5 (2025-11-01)",
    description: "Pinned Claude Opus 4.5 snapshot.",
    kind: "model",
  },
  {
    slug: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    description: "Fast frontier model for coding, agents, and everyday work.",
    kind: "model",
  },
  {
    slug: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    description: "Balanced speed and intelligence for coding and agents.",
    kind: "model",
  },
  {
    slug: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5 alias",
    description: "Convenience alias for the latest Claude Sonnet 4.5 snapshot.",
    kind: "alias",
  },
  {
    slug: "claude-sonnet-4-5-20250929",
    displayName: "Claude Sonnet 4.5 (2025-09-29)",
    description: "Pinned Claude Sonnet 4.5 snapshot.",
    kind: "model",
  },
  {
    slug: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5 alias",
    description: "Convenience alias for the latest Claude Haiku 4.5 snapshot.",
    kind: "alias",
  },
  {
    slug: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5 (2025-10-01)",
    description: "Fastest current Claude model.",
    kind: "model",
  },
];

function claudeCodeCatalog(): RunnerModelCatalog {
  return {
    runner: "claude-code",
    label: "Claude Code",
    source: "Claude Code aliases and Anthropic's current documented model IDs",
    models: CLAUDE_CODE_MODELS,
  };
}

async function codexCatalog(signal?: AbortSignal): Promise<RunnerModelCatalog> {
  const base: Omit<RunnerModelCatalog, "models"> = {
    runner: "codex",
    label: "Codex",
    source: "codex debug models --bundled",
  };
  try {
    const { stdout } = await pexec("codex", ["debug", "models", "--bundled"], {
      timeout: 20_000,
      maxBuffer: MODEL_CATALOG_MAX_BUFFER,
      env: sanitizedEnv(),
      signal,
    });
    const parsed = JSON.parse(stdout) as {
      models?: Array<{
        slug?: unknown;
        display_name?: unknown;
        description?: unknown;
        visibility?: unknown;
        supported_reasoning_levels?: Array<{ effort?: unknown }>;
      }>;
    };
    if (!Array.isArray(parsed.models)) {
      throw new Error("Codex returned a catalog without a models array");
    }
    const models = parsed.models.flatMap((model): ModelCatalogEntry[] => {
      if (
        typeof model.slug !== "string" ||
        model.slug.length === 0 ||
        model.visibility === "hide"
      ) {
        return [];
      }
      const reasoningEfforts = model.supported_reasoning_levels
        ?.map((level) => level.effort)
        .filter((effort): effort is string => typeof effort === "string");
      return [{
        slug: model.slug,
        displayName:
          typeof model.display_name === "string" && model.display_name
            ? model.display_name
            : model.slug,
        description:
          typeof model.description === "string" ? model.description : undefined,
        kind: "model",
        reasoningEfforts:
          reasoningEfforts && reasoningEfforts.length > 0
            ? reasoningEfforts
            : undefined,
      }];
    });
    return { ...base, models };
  } catch (err) {
    signal?.throwIfAborted();
    return {
      ...base,
      models: [],
      error: cliErrorMessage(err) || "Codex model catalog is unavailable",
    };
  }
}

const OPENCODE_CATALOG_PROVIDERS = [
  "zai",
  "zai-coding-plan",
  "xai",
  "deepseek",
] as const;

async function openCodeCatalog(signal?: AbortSignal): Promise<RunnerModelCatalog> {
  const base: Omit<RunnerModelCatalog, "models"> = {
    runner: "opencode",
    label: "OpenCode",
    source:
      "opencode models (filtered to zai/, zai-coding-plan/, xai/, and deepseek/)",
  };
  try {
    const allowed = new Set<string>(OPENCODE_CATALOG_PROVIDERS);
    const models = (await readOpenCodeModels(signal))
      .flatMap((slug): ModelCatalogEntry[] => {
        const separator = slug.indexOf("/");
        if (separator <= 0) return [];
        const provider = slug.slice(0, separator);
        if (!allowed.has(provider)) return [];
        return [{
          slug,
          displayName: slug.slice(separator + 1),
          provider,
          kind: "model",
        }];
      })
      .sort((a, b) =>
        (a.provider ?? "").localeCompare(b.provider ?? "") ||
        a.slug.localeCompare(b.slug),
      );
    return { ...base, models };
  } catch (err) {
    signal?.throwIfAborted();
    return {
      ...base,
      models: [],
      error: cliErrorMessage(err) || "OpenCode model catalog is unavailable",
    };
  }
}

export async function getModelCatalog(
  signal?: AbortSignal,
): Promise<ModelCatalogResponse> {
  const [codex, opencode] = await Promise.all([
    codexCatalog(signal),
    openCodeCatalog(signal),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    catalogs: [codex, claudeCodeCatalog(), opencode],
  };
}

/**
 * Run a trivial prompt through every enabled model to confirm it actually
 * responds (not just that auth exists). Costs a little real money, so this is
 * only invoked behind an explicit button. Runs all models in parallel.
 */
export async function testModels(
  settings: Settings,
  opencodeBaseUrl: string,
  onInvocation?: (event: ModelInvocation) => void,
  signal?: AbortSignal,
): Promise<TestModelsResponse> {
  const enabled = settings.models.filter((m) => m.enabled);
  const results: ModelTestResult[] = await Promise.all(
    enabled.map(async (cfg): Promise<ModelTestResult> => {
      const start = Date.now();
      const baseInvocation = {
        id: `health-${crypto.randomUUID()}`,
        stage: "health" as const,
        model: cfg.id,
        runner: cfg.runner,
        effort: cfg.effort ?? "default",
        startedAt: new Date().toISOString(),
      };
      onInvocation?.({
        ...baseInvocation,
        outcome: "running",
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        tokensCached: 0,
      });
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
          signal,
        });
        onInvocation?.({
          ...baseInvocation,
          endedAt: new Date().toISOString(),
          outcome: res.ok
            ? "completed"
            : res.exitReason === "killed"
              ? "stopped"
              : "failed",
          exitReason: res.exitReason,
          costUsd: res.costUsd,
          tokensIn: res.tokensIn,
          tokensOut: res.tokensOut,
          tokensCached: res.tokensCached ?? 0,
        });
        const reply = (res.summary ?? "").trim().slice(0, 200);
        return {
          id: cfg.id,
          displayName: cfg.displayName,
          invocationId: baseInvocation.id,
          effort: cfg.effort ?? "default",
          ok: res.ok,
          costUsd: res.costUsd,
          ms: Date.now() - start,
          reply: reply || undefined,
          error: res.ok ? undefined : (res.summary || "no output").slice(0, 200),
        };
      } catch (err) {
        onInvocation?.({
          ...baseInvocation,
          endedAt: new Date().toISOString(),
          outcome: signal?.aborted ? "stopped" : "failed",
          exitReason: signal?.aborted ? "killed" : "error",
          costUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          tokensCached: 0,
        });
        return {
          id: cfg.id,
          displayName: cfg.displayName,
          invocationId: baseInvocation.id,
          effort: cfg.effort ?? "default",
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
