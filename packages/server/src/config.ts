import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelConfig, Settings } from "@orc/types";

/**
 * Default model roster. The `opencodeModel` strings are verified against
 * `opencode models` output for this setup.
 */
export const DEFAULT_MODELS: ModelConfig[] = [
  {
    id: "claude",
    displayName: "Claude (planner / reviewer)",
    runner: "claude-code",
    // Default the Claude runner to Sonnet; the one-shot plan deconstruction
    // upgrades to Opus separately (ENV.plannerDeconstructModel).
    claudeModel: "sonnet",
    roles: ["planner", "validator"],
    enabled: true,
    maxConcurrent: 1,
  },
  {
    id: "glm",
    displayName: "GLM 5.1",
    runner: "opencode",
    opencodeModel: "zai/glm-5.1",
    roles: ["frontend", "validator"],
    enabled: true,
    maxConcurrent: 1,
  },
  {
    id: "deepseek-pro",
    displayName: "Deepseek v4 Pro",
    runner: "opencode",
    opencodeModel: "deepseek/deepseek-v4-pro",
    roles: ["hard", "validator"],
    enabled: true,
    maxConcurrent: 1,
  },
  {
    id: "deepseek-flash",
    displayName: "Deepseek v4 Flash",
    runner: "opencode",
    opencodeModel: "deepseek/deepseek-v4-flash",
    roles: ["medium"],
    enabled: true,
    maxConcurrent: 2,
  },
  {
    id: "grok",
    displayName: "Grok 4.3",
    runner: "opencode",
    opencodeModel: "xai/grok-4.3",
    roles: ["updates"],
    enabled: true,
    maxConcurrent: 1,
  },
  {
    id: "nex",
    displayName: "Nex N2 Pro (Qwen 3.5 ft.)",
    runner: "opencode",
    opencodeModel: "openrouter/nex-agi/nex-n2-pro:free",
    roles: ["docs"],
    enabled: true,
    maxConcurrent: 1,
  },
];

export function defaultSettings(): Settings {
  return {
    models: DEFAULT_MODELS,
    routing: {
      planner: "claude",
      // Quality-tiered by difficulty, per the webdev coding leaderboard
      // (lmarena): GLM 5.2 ranks #2 (1595) — clearly the strongest coder of
      // the three, but ~3x deepseek-pro's price ($1.40/$4.40 vs $0.43/$0.87
      // per M tokens). deepseek-pro ranks #23 (1459) — solid mid-tier,
      // affordable. deepseek-flash is unranked (too cheap/fast a tier to
      // benchmark) — reserved for genuinely easy work where speed/cost beats
      // raw capability. Each tier gets a distinct model so the expensive one
      // (glm) is spent only where it earns its cost, not on routine work.
      byDifficulty: {
        easy: "deepseek-flash",
        medium: "deepseek-pro",
        hard: "glm",
      },
      byRole: {
        frontend: "glm",
        docs: "grok",
        updates: "grok",
      },
      // Claude reviews everything: it's never an author model in this
      // routing (so it never collides with self-review), and it's covered
      // by the existing Claude subscription rather than metered per-token —
      // free validation, leaving the full per-token budget for authoring.
      validatorByDifficulty: {
        easy: "claude",
        medium: "claude",
        hard: "claude",
      },
    },
    mergePolicy: "hard_gate_flag_risky",
    riskyChangeRules: {
      dbSchema: true,
      newDependencies: true,
      authOrSecrets: true,
      outOfScopeEdits: true,
    },
    confidenceThreshold: 0.7,
    // Unset by default => falls back to ENV.reposDir at request time. Set from
    // the Settings UI to point new project clones somewhere readable, e.g.
    // ~/projects, instead of the opaque ~/.hoopedorc/repos default.
    defaultProjectsDir: undefined,
    // Token is read from the env var named here, never stored raw. Set the var
    // + chatId and flip enabled to turn the bot on.
    telegram: { enabled: false, botTokenRef: "TELEGRAM_BOT_TOKEN" },
  };
}

export const ENV = {
  port: Number(process.env.PORT ?? 4317),
  dbPath: process.env.DB_PATH ?? "hoopedorc.db",
  // Loopback by default — the API is unauthenticated unless apiToken/API_TOKEN
  // is set (see below), so binding wide open by default would let anything on
  // the LAN (or any website open in the operator's browser, via CORS) drive
  // it. Set HOST=0.0.0.0 deliberately for Tailscale/EC2 use.
  host: process.env.HOST ?? "127.0.0.1",
  // Extra allowed CORS origins beyond the dev web app's own
  // (http://localhost:5173, http://127.0.0.1:5173) — comma-separated. Never
  // reflect-any-origin: that would let any open browser tab call the API.
  corsOrigins: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  // Off by default (frictionless solo localhost use). When set, every
  // /api/* request (and the /ws upgrade) must present it as
  // `Authorization: Bearer <token>` (or `?token=` for the WS upgrade, since
  // browsers can't set headers on the upgrade request). settings.apiToken is
  // an alternate source (set via the UI once authenticated); this env var
  // wins if both are present.
  apiToken: process.env.API_TOKEN || undefined,
  // Escape hatch to bind non-loopback without a token (e.g. a throwaway
  // sandbox). Off by default — see the startup guard in index.ts.
  allowUnauthenticated: process.env.ALLOW_UNAUTHENTICATED === "1",
  // Empty by default => `opencode run` runs standalone. Set OPENCODE_BASE_URL
  // (and run `opencode serve`) only to centralize sessions on one server.
  opencodeBaseUrl: process.env.OPENCODE_BASE_URL ?? "",
  mock: process.env.MOCK === "1",
  // Two-tier planning models (claude --model aliases). Sonnet drives the cheap
  // conversational turns; Opus does the single high-leverage deconstruction of
  // the agreed plan into the task DAG. Override if Opus is ever throttled.
  plannerChatModel: process.env.PLANNER_CHAT_MODEL ?? "sonnet",
  plannerDeconstructModel: process.env.PLANNER_DECONSTRUCT_MODEL ?? "opus",
  // Where per-project repo clones + their task worktrees live. MUST be outside
  // the orchestrator's own working tree: each worktree is `${localPath}-wt-<id>`,
  // and coding agents (opencode/claude) resolve their project root by walking up
  // to the nearest `.git`. If a worktree is nested inside this repo, the agent
  // resolves to THIS repo and writes files here instead of the worktree.
  reposDir: process.env.REPOS_DIR ?? join(homedir(), ".hoopedorc", "repos"),
};
