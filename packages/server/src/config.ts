import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  modelEffortError,
  type MergePolicy,
  type ModelConfig,
  type ModelId,
  type Role,
  type RunnerKind,
  type Settings,
} from "@orc/types";

/**
 * Default model roster. The `opencodeModel` strings are verified against
 * `opencode models` output for this setup.
 */
export const DEFAULT_MODELS: ModelConfig[] = [
  {
    id: "claude",
    displayName: "Claude (planner / reviewer)",
    runner: "claude-code",
    // The planner's model: when this config is routed as planner, this alias
    // drives BOTH planning chat and deconstruction. Edit it (or the Planner
    // routing) in the dashboard to switch planning to a different model.
    claudeModel: "sonnet",
    roles: ["planner", "validator"],
    enabled: true,
    maxConcurrent: 1,
  },
  {
    id: "glm",
    displayName: "GLM 5.2",
    runner: "opencode",
    opencodeModel: "zai-coding-plan/glm-5.2",
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

/**
 * F31: shipped defaults for Settings.guidelines — operator-editable, but a
 * fresh install shouldn't start from a blank textarea. Concise and
 * imperative on purpose (these get injected into every author/validator
 * prompt, so bulk here is bulk on every single run).
 */
export const DEFAULT_GUIDELINES = {
  coding: `- Follow this repo's existing conventions before inventing new ones — check how similar code already does it.
- Keep modules small and focused; one clear responsibility per file/function.
- Never leave dead or commented-out code; delete what isn't used.
- Handle errors at the boundary that can actually act on them — don't catch-and-ignore.
- Avoid \`any\`-typed escape hatches in TypeScript; narrow real types instead of bypassing them.
- Separate pure logic from I/O so it stays testable without a live server/DB/network.
- Write or update tests for any new behavior you add; don't ship untested logic.
- Don't add a new dependency for something the standard library or an existing one already does.
- Match the surrounding file's existing formatting and style.`,
  ux: `- Every async action shows a loading state while it's in flight.
- Every action that can fail surfaces its error to the user — no silent failures.
- Empty states explain what to do next, not just "no data."
- Interactive elements are reachable and operable via keyboard, not just mouse/touch.
- Layouts hold up at phone width (~375px) — no horizontal scroll, no clipped content.
- Text has readable contrast against its background.
- Destructive actions (delete, stop, discard) require confirmation before executing.
- Loading, empty, and error states are visually distinct from each other.`,
  security: `- Never hardcode secrets, tokens, or credentials in source — read them from environment/config.
- Validate and bound all external input (request bodies, query params, uploaded files, path segments) before using it.
- Use parameterized queries for anything touching a database; never build SQL by string concatenation.
- Never use \`eval\`, dynamic \`require\`/\`import\` of untrusted input, or shell string interpolation of external input.
- Don't add a dependency for something achievable with the standard library — every dependency is attack surface.
- Never log credentials, tokens, or full request bodies that might contain secrets.
- Sanitize and contain any filesystem path built from user input — never trust a client-supplied path as-is.`,
};

function rawDefaultSettings(): Settings {
  return {
    models: DEFAULT_MODELS.map((model) => ({ ...model, roles: [...model.roles] })),
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
      // Explicit fallback escalation (Settings → Routing → Fallback 1/2);
      // matches what the old implicit tier-escalation produced for a
      // medium-difficulty task, so upgrading changes nothing by default.
      fallbacks: ["deepseek-pro", "glm"],
    },
    mergePolicy: "hard_gate_flag_risky",
    riskyChangeRules: {
      dbSchema: true,
      newDependencies: true,
      authOrSecrets: true,
      outOfScopeEdits: true,
      destructiveChanges: true,
    },
    allowVacuousGates: false,
    // F13-P1: sandbox gate scripts + dep installs in Docker when a daemon is
    // available, host otherwise — see Settings.sandboxGates's own doc for
    // the full off/auto/required contract.
    sandboxGates: "auto",
    confidenceThreshold: 0.7,
    // Unset by default => falls back to ENV.reposDir at request time. Set from
    // the Settings UI to point new project clones somewhere readable, e.g.
    // ~/projects, instead of the opaque ~/.hoopedorc/repos default.
    defaultProjectsDir: undefined,
    // Token is read from the env var named here, never stored raw. Set the var
    // + chatId and flip enabled to turn the bot on.
    telegram: { enabled: false, botTokenRef: "TELEGRAM_BOT_TOKEN" },
    guidelines: { ...DEFAULT_GUIDELINES },
  };
}

export class SettingsValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(`${field} ${message}`);
    this.name = "SettingsValidationError";
  }
}

const RUNNERS: RunnerKind[] = ["claude-code", "opencode", "codex"];
const ROLES: Role[] = [
  "planner",
  "frontend",
  "hard",
  "medium",
  "docs",
  "validator",
  "updates",
];
const MERGE_POLICIES: MergePolicy[] = [
  "hard_gate_flag_risky",
  "fully_autonomous",
  "always_ask",
];
const DIFFICULTIES = ["easy", "medium", "hard"] as const;
const GUIDELINES_MAX_CHARS = 4000;

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SettingsValidationError(field, "must be an object");
  }
  return value as Record<string, unknown>;
}

function boolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new SettingsValidationError(field, "must be a boolean");
  }
  return value;
}

function string(
  value: unknown,
  field: string,
  options: { optional?: boolean; nonEmpty?: boolean; max?: number } = {},
): string | undefined {
  if (value === undefined || value === null) {
    if (options.optional) return undefined;
    throw new SettingsValidationError(field, "must be a string");
  }
  if (typeof value !== "string") {
    throw new SettingsValidationError(field, "must be a string");
  }
  if (options.nonEmpty && value.trim().length === 0) {
    throw new SettingsValidationError(field, "must not be empty");
  }
  if (options.max !== undefined && value.length > options.max) {
    throw new SettingsValidationError(field, `must be at most ${options.max} characters`);
  }
  return value;
}

function finiteNumber(
  value: unknown,
  field: string,
  options: { optional?: boolean; min?: number; max?: number; integer?: boolean; exclusiveMin?: boolean } = {},
): number | undefined {
  if (value === undefined || value === null) {
    if (options.optional) return undefined;
    throw new SettingsValidationError(field, "must be a number");
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SettingsValidationError(field, "must be a finite number");
  }
  if (options.integer && !Number.isInteger(value)) {
    throw new SettingsValidationError(field, "must be an integer");
  }
  if (
    options.min !== undefined &&
    (options.exclusiveMin ? value <= options.min : value < options.min)
  ) {
    throw new SettingsValidationError(
      field,
      `must be ${options.exclusiveMin ? "greater than" : "at least"} ${options.min}`,
    );
  }
  if (options.max !== undefined && value > options.max) {
    throw new SettingsValidationError(field, `must be at most ${options.max}`);
  }
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new SettingsValidationError(field, `must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function optionalString(value: unknown, field: string, max = 512): string | undefined {
  const result = string(value, field, { optional: true, max });
  return result === "" ? undefined : result;
}

function normalizeModel(value: unknown, index: number): ModelConfig {
  const raw = record(value, `models[${index}]`);
  const field = (name: string) => `models[${index}].${name}`;
  const runner = enumValue(raw.runner, RUNNERS, field("runner"));
  const id = string(raw.id, field("id"), { nonEmpty: true, max: 128 })!.trim() as ModelId;
  const displayName = string(raw.displayName, field("displayName"), {
    nonEmpty: true,
    max: 200,
  })!.trim();
  const rolesRaw = raw.roles ?? [];
  if (!Array.isArray(rolesRaw)) {
    throw new SettingsValidationError(field("roles"), "must be an array");
  }
  const roles = rolesRaw.map((role, roleIndex) =>
    enumValue(role, ROLES, `${field("roles")}[${roleIndex}]`),
  );
  if (new Set(roles).size !== roles.length) {
    throw new SettingsValidationError(field("roles"), "must not contain duplicates");
  }

  const effort = optionalString(raw.effort, field("effort"), 64);
  const effortError = modelEffortError(runner, effort);
  if (effortError) throw new SettingsValidationError(field("effort"), effortError);

  const model: ModelConfig = {
    id,
    displayName,
    runner,
    opencodeModel: optionalString(raw.opencodeModel, field("opencodeModel")),
    claudeModel: optionalString(raw.claudeModel, field("claudeModel")),
    codexModel: optionalString(raw.codexModel, field("codexModel")),
    effort,
    roles,
    enabled: boolean(raw.enabled, field("enabled"), true),
    maxConcurrent: finiteNumber(raw.maxConcurrent ?? 1, field("maxConcurrent"), {
      min: 1,
      max: 100,
      integer: true,
    })!,
    costPerMInputUsd: finiteNumber(raw.costPerMInputUsd, field("costPerMInputUsd"), {
      optional: true,
      min: 0,
    }),
    costPerMCachedInputUsd: finiteNumber(
      raw.costPerMCachedInputUsd,
      field("costPerMCachedInputUsd"),
      { optional: true, min: 0 },
    ),
    costPerMOutputUsd: finiteNumber(raw.costPerMOutputUsd, field("costPerMOutputUsd"), {
      optional: true,
      min: 0,
    }),
    monthlyBudgetUsd: finiteNumber(raw.monthlyBudgetUsd, field("monthlyBudgetUsd"), {
      optional: true,
      min: 0,
      exclusiveMin: true,
    }),
  };

  if (runner === "opencode" && !model.opencodeModel) {
    throw new SettingsValidationError(
      field("opencodeModel"),
      "is required when runner is opencode",
    );
  }

  if (raw.quota !== undefined && raw.quota !== null) {
    const quota = record(raw.quota, field("quota"));
    const maxRuns = finiteNumber(quota.maxRuns, `${field("quota")}.maxRuns`, {
      optional: true,
      min: 0,
      exclusiveMin: true,
      integer: true,
    });
    const maxCostUsd = finiteNumber(quota.maxCostUsd, `${field("quota")}.maxCostUsd`, {
      optional: true,
      min: 0,
      exclusiveMin: true,
    });
    if (maxRuns === undefined && maxCostUsd === undefined) {
      throw new SettingsValidationError(
        field("quota"),
        "must set at least one of maxRuns or maxCostUsd",
      );
    }
    model.quota = {
      windowHours: finiteNumber(quota.windowHours, `${field("quota")}.windowHours`, {
        min: 0,
        exclusiveMin: true,
        max: 8760,
      })!,
      maxRuns,
      maxCostUsd,
    };
  }

  return model;
}

/**
 * B37's single settings contract. Missing fields are migrated from the current
 * defaults; present invalid fields fail with a precise path. Every settings
 * read/write path calls this function, so HTTP, Telegram, boot migration and
 * active runtimes cannot disagree about what a valid policy means.
 */
export function normalizeSettings(value: unknown): Settings {
  const defaults = rawDefaultSettings();
  const raw = record(value, "settings");
  const modelsRaw = raw.models ?? defaults.models;
  if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
    throw new SettingsValidationError("models", "must be a non-empty array");
  }
  const models = modelsRaw.map(normalizeModel);
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) {
      throw new SettingsValidationError("models", `contains duplicate id "${model.id}"`);
    }
    ids.add(model.id);
  }

  const defaultRouting = defaults.routing;
  const routingRaw = record(raw.routing ?? defaultRouting, "routing");
  const byDifficultyRaw = record(
    routingRaw.byDifficulty ?? defaultRouting.byDifficulty,
    "routing.byDifficulty",
  );
  const validatorsRaw = record(
    routingRaw.validatorByDifficulty ?? defaultRouting.validatorByDifficulty,
    "routing.validatorByDifficulty",
  );
  const byRoleRaw = record(routingRaw.byRole ?? defaultRouting.byRole, "routing.byRole");
  const routing: Settings["routing"] = {
    planner: string(routingRaw.planner ?? defaultRouting.planner, "routing.planner", {
      nonEmpty: true,
    }) as ModelId,
    deconstructor: optionalString(routingRaw.deconstructor, "routing.deconstructor", 128) as
      | ModelId
      | undefined,
    byDifficulty: {
      easy: string(byDifficultyRaw.easy, "routing.byDifficulty.easy", { nonEmpty: true }) as ModelId,
      medium: string(byDifficultyRaw.medium, "routing.byDifficulty.medium", { nonEmpty: true }) as ModelId,
      hard: string(byDifficultyRaw.hard, "routing.byDifficulty.hard", { nonEmpty: true }) as ModelId,
    },
    byRole: {},
    validatorByDifficulty: {
      easy: string(validatorsRaw.easy, "routing.validatorByDifficulty.easy", { nonEmpty: true }) as ModelId,
      medium: string(validatorsRaw.medium, "routing.validatorByDifficulty.medium", { nonEmpty: true }) as ModelId,
      hard: string(validatorsRaw.hard, "routing.validatorByDifficulty.hard", { nonEmpty: true }) as ModelId,
    },
  };
  for (const [role, modelId] of Object.entries(byRoleRaw)) {
    if (!ROLES.includes(role as Role)) {
      throw new SettingsValidationError(`routing.byRole.${role}`, "is not a recognized role");
    }
    routing.byRole[role as Role] = string(modelId, `routing.byRole.${role}`, {
      nonEmpty: true,
    }) as ModelId;
  }
  if (routingRaw.fallbacks !== undefined) {
    if (!Array.isArray(routingRaw.fallbacks)) {
      throw new SettingsValidationError("routing.fallbacks", "must be an array");
    }
    routing.fallbacks = routingRaw.fallbacks.map(
      (modelId, index) =>
        string(modelId, `routing.fallbacks[${index}]`, { nonEmpty: true }) as ModelId,
    );
    if (new Set(routing.fallbacks).size !== routing.fallbacks.length) {
      throw new SettingsValidationError("routing.fallbacks", "must not contain duplicates");
    }
  }

  const enabledIds = new Set(models.filter((model) => model.enabled).map((model) => model.id));
  const routingRefs: Array<[string, ModelId | undefined]> = [
    ["routing.planner", routing.planner],
    ["routing.deconstructor", routing.deconstructor],
    ...DIFFICULTIES.flatMap((difficulty) => [
      [`routing.byDifficulty.${difficulty}`, routing.byDifficulty[difficulty]],
      [
        `routing.validatorByDifficulty.${difficulty}`,
        routing.validatorByDifficulty[difficulty],
      ],
    ] as Array<[string, ModelId]>),
    ...Object.entries(routing.byRole).map(
      ([role, modelId]) => [`routing.byRole.${role}`, modelId] as [string, ModelId],
    ),
    ...(routing.fallbacks ?? []).map(
      (modelId, index) => [`routing.fallbacks[${index}]`, modelId] as [string, ModelId],
    ),
  ];
  for (const [field, modelId] of routingRefs) {
    if (!modelId) continue;
    if (!ids.has(modelId)) {
      throw new SettingsValidationError(field, `references missing model "${modelId}"`);
    }
    if (!enabledIds.has(modelId)) {
      throw new SettingsValidationError(field, `references disabled model "${modelId}"`);
    }
  }
  for (const difficulty of DIFFICULTIES) {
    if (routing.byDifficulty[difficulty] === routing.validatorByDifficulty[difficulty]) {
      throw new SettingsValidationError(
        `routing.validatorByDifficulty.${difficulty}`,
        "must differ from the author model for the same difficulty",
      );
    }
  }

  const defaultRisky = defaults.riskyChangeRules;
  const riskyRaw = record(raw.riskyChangeRules ?? defaultRisky, "riskyChangeRules");
  const riskyChangeRules: Settings["riskyChangeRules"] = {
    dbSchema: boolean(riskyRaw.dbSchema, "riskyChangeRules.dbSchema", defaultRisky.dbSchema),
    newDependencies: boolean(
      riskyRaw.newDependencies,
      "riskyChangeRules.newDependencies",
      defaultRisky.newDependencies,
    ),
    authOrSecrets: boolean(
      riskyRaw.authOrSecrets,
      "riskyChangeRules.authOrSecrets",
      defaultRisky.authOrSecrets,
    ),
    outOfScopeEdits: boolean(
      riskyRaw.outOfScopeEdits,
      "riskyChangeRules.outOfScopeEdits",
      defaultRisky.outOfScopeEdits,
    ),
    destructiveChanges: boolean(
      riskyRaw.destructiveChanges,
      "riskyChangeRules.destructiveChanges",
      true,
    ),
  };

  let telegram: Settings["telegram"];
  if (raw.telegram === undefined || raw.telegram === null) {
    telegram = defaults.telegram ? { ...defaults.telegram } : undefined;
  } else {
    const source = record(raw.telegram, "telegram");
    const digest = source.digest === undefined
      ? defaults.telegram?.digest
      : enumValue(source.digest, ["off", "terminal", "all"] as const, "telegram.digest");
    telegram = {
      enabled: boolean(source.enabled, "telegram.enabled", false),
      botTokenRef: optionalString(source.botTokenRef, "telegram.botTokenRef", 200),
      botToken: optionalString(source.botToken, "telegram.botToken", 1000),
      chatId: optionalString(source.chatId, "telegram.chatId", 100),
      digest,
      modelAlerts: boolean(source.modelAlerts, "telegram.modelAlerts", true),
    };
  }

  let guidelines: Settings["guidelines"];
  if (raw.guidelines === undefined || raw.guidelines === null) {
    guidelines = defaults.guidelines ? { ...defaults.guidelines } : undefined;
  } else {
    const source = record(raw.guidelines, "guidelines");
    guidelines = {
      coding: string(source.coding ?? defaults.guidelines?.coding ?? "", "guidelines.coding", {
        max: GUIDELINES_MAX_CHARS,
      }),
      ux: string(source.ux ?? defaults.guidelines?.ux ?? "", "guidelines.ux", {
        max: GUIDELINES_MAX_CHARS,
      }),
      security: string(
        source.security ?? defaults.guidelines?.security ?? "",
        "guidelines.security",
        { max: GUIDELINES_MAX_CHARS },
      ),
    };
  }

  return {
    models,
    routing,
    mergePolicy: enumValue(
      raw.mergePolicy ?? defaults.mergePolicy,
      MERGE_POLICIES,
      "mergePolicy",
    ),
    riskyChangeRules,
    allowVacuousGates: boolean(
      raw.allowVacuousGates,
      "allowVacuousGates",
      defaults.allowVacuousGates ?? false,
    ),
    onboardedAt: optionalString(raw.onboardedAt, "onboardedAt", 100),
    globalMonthlyBudgetUsd: finiteNumber(raw.globalMonthlyBudgetUsd, "globalMonthlyBudgetUsd", {
      optional: true,
      min: 0,
      exclusiveMin: true,
    }),
    confidenceThreshold: finiteNumber(
      raw.confidenceThreshold ?? defaults.confidenceThreshold,
      "confidenceThreshold",
      { min: 0, max: 1 },
    )!,
    defaultProjectsDir: optionalString(raw.defaultProjectsDir, "defaultProjectsDir", 4096),
    telegram,
    apiToken: optionalString(raw.apiToken, "apiToken", 4096),
    guidelines,
    sandboxGates: enumValue(
      raw.sandboxGates ?? defaults.sandboxGates ?? "auto",
      ["off", "auto", "required"] as const,
      "sandboxGates",
    ),
    holdWhileAwaitingApproval: boolean(
      raw.holdWhileAwaitingApproval,
      "holdWhileAwaitingApproval",
      false,
    ),
  };
}

/** Deep-merge a partial API/Telegram update into the saved shape, then run it
 * through the exact same contract used for persisted settings and defaults. */
export function mergeSettingsUpdate(current: Settings, patch: unknown): Settings {
  const raw = record(patch, "settings");
  const routingPatch = raw.routing === undefined ? undefined : record(raw.routing, "routing");
  const riskyPatch = raw.riskyChangeRules === undefined
    ? undefined
    : record(raw.riskyChangeRules, "riskyChangeRules");
  const telegramPatch = raw.telegram === undefined ? undefined : record(raw.telegram, "telegram");
  const guidelinesPatch = raw.guidelines === undefined
    ? undefined
    : record(raw.guidelines, "guidelines");
  return normalizeSettings({
    ...current,
    ...raw,
    routing: routingPatch
      ? {
          ...current.routing,
          ...routingPatch,
          byDifficulty: routingPatch.byDifficulty === undefined
            ? current.routing.byDifficulty
            : { ...current.routing.byDifficulty, ...record(routingPatch.byDifficulty, "routing.byDifficulty") },
          byRole: routingPatch.byRole === undefined
            ? current.routing.byRole
            : { ...current.routing.byRole, ...record(routingPatch.byRole, "routing.byRole") },
          validatorByDifficulty: routingPatch.validatorByDifficulty === undefined
            ? current.routing.validatorByDifficulty
            : {
                ...current.routing.validatorByDifficulty,
                ...record(routingPatch.validatorByDifficulty, "routing.validatorByDifficulty"),
              },
        }
      : current.routing,
    riskyChangeRules: riskyPatch
      ? { ...current.riskyChangeRules, ...riskyPatch }
      : current.riskyChangeRules,
    telegram: telegramPatch
      ? { ...(current.telegram ?? { enabled: false }), ...telegramPatch }
      : current.telegram,
    guidelines: guidelinesPatch
      ? { ...(current.guidelines ?? {}), ...guidelinesPatch }
      : current.guidelines,
  });
}

/** Defaults pass through the same normalizer as every persisted/API value. */
export function defaultSettings(): Settings {
  return normalizeSettings(rawDefaultSettings());
}

const dbPath = process.env.DB_PATH ?? "hoopedorc.db";

export const ENV = {
  port: Number(process.env.PORT ?? 4317),
  dbPath,
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
  // Fallback planner model (claude --model alias). The planner — both the
  // conversational chat turns AND the one-shot deconstruction of the agreed
  // plan into the task DAG — runs on whatever model Settings → Routing →
  // Planner points at (that ModelConfig's claudeModel field, editable in the
  // dashboard). This env fallback only applies when that field is unset.
  plannerModel: process.env.PLANNER_MODEL ?? "sonnet",
  // Where per-project repo clones + their task worktrees live. MUST be outside
  // the orchestrator's own working tree: each worktree is `${localPath}-wt-<id>`,
  // and coding agents (opencode/claude) resolve their project root by walking up
  // to the nearest `.git`. If a worktree is nested inside this repo, the agent
  // resolves to THIS repo and writes files here instead of the worktree.
  reposDir: process.env.REPOS_DIR ?? join(homedir(), ".hoopedorc", "repos"),
  // Every agent output line is persisted forever by default, which grows the
  // logs table unbounded (a few long runs -> hundreds of MB, slowing the WAL
  // and snapshot queries). Pruned on boot and daily — see pruneLogs() in
  // db/repo.ts and its callers in index.ts.
  logRetentionDays: Number(process.env.LOG_RETENTION_DAYS ?? 14),
  // B23: mirrors logRetentionDays — pending approvals are exempt regardless
  // of age (see pruneNotifications() in db/repo.ts).
  notificationRetentionDays: Number(process.env.NOTIFICATION_RETENTION_DAYS ?? 30),
  // F17: where periodic DB backups (better-sqlite3's online backup API) are
  // written — default sits next to the DB file itself. No-op for an
  // in-memory/mock DB, so this only ever matters for a real deployment.
  dbBackupDir: process.env.DB_BACKUP_DIR ?? join(dirname(dbPath), "backups"),
  dbBackupKeep: Number(process.env.DB_BACKUP_KEEP ?? 7),
};
