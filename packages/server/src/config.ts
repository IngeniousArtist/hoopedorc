import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
