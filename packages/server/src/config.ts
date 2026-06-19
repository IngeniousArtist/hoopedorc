import type { ModelConfig, Settings } from "@orc/types";

/**
 * Default model roster. The `opencodeModel` strings are PLACEHOLDERS — replace
 * them with the exact provider/model ids from `opencode models` for your setup.
 */
export const DEFAULT_MODELS: ModelConfig[] = [
  {
    id: "claude",
    displayName: "Claude (planner / reviewer)",
    runner: "claude-code",
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
        hard: "deepseek-pro",
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
    telegram: { enabled: false },
  };
}

export const ENV = {
  port: Number(process.env.PORT ?? 4317),
  dbPath: process.env.DB_PATH ?? "hoopedorc.db",
  // Empty by default => `opencode run` runs standalone. Set OPENCODE_BASE_URL
  // (and run `opencode serve`) only to centralize sessions on one server.
  opencodeBaseUrl: process.env.OPENCODE_BASE_URL ?? "",
  mock: process.env.MOCK === "1",
};
