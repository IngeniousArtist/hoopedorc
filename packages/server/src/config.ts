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
      byDifficulty: {
        easy: "deepseek-flash",
        medium: "deepseek-flash",
        hard: "deepseek-pro",
      },
      byRole: {
        frontend: "glm",
        docs: "nex",
        updates: "grok",
      },
      validatorByDifficulty: {
        easy: "deepseek-pro",
        medium: "deepseek-pro",
        // Hard tasks are authored by deepseek-pro (byDifficulty.hard below), so
        // the validator must be a different model — self-review is forbidden
        // (validator.ts throws if validatorModel === authorModel).
        hard: "glm",
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
