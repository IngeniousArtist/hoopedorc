import "dotenv/config";
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type {
  Difficulty,
  MergePolicy,
  ModelId,
  ModelInvocation,
  Project,
  ProjectConfig,
  Role,
  ServerEvent,
  Task,
} from "@orc/types";
import { SECRET_SENTINEL, TASK_STATUSES, WS_PATH, pickAssignedModel } from "@orc/types";
import type { TaskStatus } from "@orc/types";
import { GitServiceImpl, detectDocker, isPlausibleImageRef } from "@orc/engine";
import {
  ENV,
  SettingsValidationError,
  defaultSettings,
  mergeSettingsUpdate,
} from "./config";
import { ensureDocsTask } from "./docs-task";
import { ensureVisualQaTask } from "./visual-qa-task";
import { seed } from "./mock";
import type { Db } from "./db/index";
import { initDb } from "./db/index";
import { runBackup } from "./db/backup";
import { isScheduleDue } from "./scheduler";
import * as repo from "./db/repo";
import { WsHub } from "./ws-hub";
import { EngineRunner } from "./engine-runner";
import {
  FigmaVerificationError,
  plannerModelLabel,
  resolvePlannerModel,
  runPlanner,
  runPlannerChat,
  runPlannerDeconstruct,
  type PlanOutput,
  type PlannerModel,
} from "./planner";
import { createGithubRepo, getPrDiff, slugifyRepoName } from "./github";
import { checkBudget } from "./budget";
import {
  computeModelHealth,
  findProjectByPrefix,
  findTaskByIdPrefix,
  notifyTelegramApprovalFailure,
  pauseProject,
  resendPendingApprovals,
  retryTask,
  setMergePolicy,
  startProject,
  stopAllProjects,
} from "./commands";
import { estimatePlan } from "./estimate";
import { redactTokenFromUrl } from "./log-redact";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentsDir,
  listAttachments,
  removeAttachment,
  sanitizeAttachmentName,
  saveAttachment,
} from "./attachments";
import {
  listArchivedSessions,
  recordPlanChatTurn,
  recordPlanDeconstruct,
} from "./plan-sessions";
import {
  commitPlanningDraft,
  materializeTasks,
  planningCommitInProgress,
  PlanningCommitError,
  planningPersistenceError,
} from "./planning-commit";
import {
  TelegramBot,
  sendTelegramMessage,
  type TelegramCommandReply,
  type TelegramDeliveryHealth,
} from "./telegram";
import {
  getModelCatalog,
  getModelRoster,
  runSetupChecks,
  testModels,
} from "./setup";
import { parseSetupCommand } from "./project-config";
import { persistInvocationEvent } from "./invocation-ledger";
import { ShutdownCoordinator, installShutdownHandlers } from "./shutdown";
import { buildRuntimeHealth } from "./runtime-health";
import { SelfUpdater, SelfUpdateRefusedError } from "./self-update";
import type {
  DraftTask,
  Notification,
  PlanChatMessage,
  PlanDeconstructRequest,
  Settings as SettingsType,
  VerifiedFigmaReference,
} from "@orc/types";

type RouteParams = { id: string };

function plannerRequestCancellation(
  request: IncomingMessage,
  response: ServerResponse,
  activeControllers?: Set<AbortController>,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  activeControllers?.add(controller);
  const abort = () => controller.abort();
  const abortIfDisconnected = () => {
    if (!response.writableEnded) abort();
  };
  request.once("aborted", abort);
  response.once("close", abortIfDisconnected);
  return {
    signal: controller.signal,
    cleanup: () => {
      request.removeListener("aborted", abort);
      response.removeListener("close", abortIfDisconnected);
      activeControllers?.delete(controller);
    },
  };
}

function setupDb(): Db {
  if (ENV.mock) {
    // In-memory DB needs the schema applied before seeding.
    const db = initDb(":memory:");
    const { projects, tasks, settings } = seed();
    const p = projects[0]!;
    repo.createProject(db, {
      id: p.id,
      name: p.name,
      repoUrl: p.repoUrl,
      defaultBranch: p.defaultBranch,
      localPath: p.localPath,
      status: p.status,
      prdPath: p.prdPath,
      budgetUsd: p.budgetUsd,
    });
    for (const t of tasks) {
      repo.createTask(db, {
        id: t.id,
        projectId: t.projectId,
        title: t.title,
        description: t.description,
        difficulty: t.difficulty,
        status: t.status,
        dependsOn: t.dependsOn,
        acceptanceCriteria: t.acceptanceCriteria,
        assignedModel: t.assignedModel,
        scopePaths: t.scopePaths,
        branch: t.branch,
        worktreePath: t.worktreePath,
        prNumber: t.prNumber,
        attempts: t.attempts,
        maxAttempts: t.maxAttempts,
      });
    }
    repo.upsertSettings(db, settings);
    return db;
  }
  return initDb();
}

/**
 * A standing documentation task. It runs LAST — `ensureDocsTask` makes it
 * depend on every other task in the batch — so it documents the finished
 * project rather than a work in progress. (It originally had no dependencies
 * — "docs while others code" — but in practice that meant it ran against a
 * half-built repo, failed its own acceptance criteria, and burned its
 * fallback attempts on the same wall.) Scoped to README.md/CHANGELOG.md/
 * docs/** so it can never collide with any coding task's scope.
 *
 * F29: description + acceptance criteria also demand a CHANGELOG.md and
 * spell out the "verify quickstart commands against package.json, never
 * invent them" rule — the same standard `DOCS_GUIDELINES` (packages/engine/
 * src/guidelines.ts) holds the docs-role author to on every task, restated
 * here since this task's own acceptance criteria are what the validator
 * actually grades against.
 */
function buildDocsTaskDraft(settings: SettingsType): DraftTask {
  return {
    title: "Project documentation",
    description:
      "Write thorough project documentation: README.md (what the project does, how to " +
      "install dependencies, how to run it locally (dev server, build, start/production), " +
      "and the key dependencies and why they're used) and CHANGELOG.md (Keep a Changelog " +
      "shape, one entry for this initial version). Verify every command you document " +
      "against the repo's actual package.json scripts — never invent a script name. " +
      "This task runs after every other task has finished, so the repo you see is the " +
      "completed project — document what is actually there, based on the PRD and the " +
      "real code. Prefer accuracy over completeness.",
    difficulty: "easy",
    role: "docs",
    acceptanceCriteria: [
      "README.md exists at the repo root",
      "README explains what the project does in plain language",
      "README lists exact install commands",
      "README lists exact commands to run it locally and to build/start for production, verified against package.json's real scripts",
      "README lists key dependencies and what each is for",
      "CHANGELOG.md exists with an entry for the initial version",
    ],
    dependsOn: [],
    scopePaths: ["README.md", "CHANGELOG.md", "docs/**"],
    assignedModel: pickAssignedModel(settings.routing, "easy", "docs"),
  };
}

// ensureDocsTask lives in docs-task.ts so its runs-last guarantee is unit-
// testable without booting this server module.

/** Resolve each draft task's suggested author model for display before commit. */
function withAssignedModels(
  output: PlanOutput,
  settings: SettingsType,
  verifiedFigmaReferences: VerifiedFigmaReference[] = [],
): DraftTask[] {
  const tasks = output.tasks.map((t) => ({
    title: t.title,
    description: t.description,
    difficulty: t.difficulty,
    role: t.role,
    acceptanceCriteria: t.acceptanceCriteria,
    dependsOn: t.dependsOn,
    scopePaths: t.scopePaths,
    assignedModel: pickAssignedModel(settings.routing, t.difficulty, t.role),
  }));
  // Injected here (deconstruct response), not inside materializeTasks/commit —
  // this way it shows up in the Plan tab's editable review table, where the
  // user can remove it if they don't want it for a given project. Re-adding
  // it at commit time would silently override that choice.
  const tasksWithVisualQa = ensureVisualQaTask(
    tasks,
    verifiedFigmaReferences,
    settings,
  );
  return ensureDocsTask(tasksWithVisualQa, buildDocsTaskDraft(settings));
}

const gitForPlanning = new GitServiceImpl();
// The mock server has no backing GitHub repository by design; keep its Plan UI
// usable while production always crosses the real B39 durability boundary.
const planningGitPersistence = ENV.mock
  ? { async commitFiles() {} }
  : gitForPlanning;

/**
 * Resolve the working directory for a planning call. Clones the project's
 * repo on first use (it already exists on GitHub by the time planning runs —
 * see createGithubRepo at project creation) so `claude -p` runs inside the
 * real codebase and can read existing files with its built-in tools instead
 * of planning blind in an empty tmp dir. Falls back to tmpdir() so planning
 * never hard-fails if the clone can't be reached (e.g. offline).
 */
async function resolvePlannerCwd(project: Project): Promise<string> {
  try {
    await gitForPlanning.ensureClone(project);
    return project.localPath;
  } catch {
    return tmpdir();
  }
}

/**
 * For a follow-up planning iteration: summarize what the project already
 * shipped — prior PRD, completed/failed tasks, and recent audit activity — so
 * the planner builds on it instead of re-planning from scratch. Returns
 * undefined for a first-time plan (no committed tasks yet), which leaves the
 * planning prompts unchanged.
 */
function buildPriorContext(db: Db, project: Project): string | undefined {
  const tasks = repo.getTasks(db, project.id);
  if (tasks.length === 0) return undefined; // first plan — nothing prior

  const fmtTask = (t: Task) =>
    `- [${t.status}] ${t.title}${t.role ? ` (${t.role})` : ""} — ${t.description.split("\n")[0]}`;
  // Cap the inlined task list on long-running projects — like the audit slice
  // below, an extra bound against a huge planning prompt (see B7: the whole
  // prompt goes over argv/stdin to `claude -p`, which has its own size limits
  // worth staying well clear of). `tasks` is oldest-first, so the tail is the
  // most recent.
  const MAX_PRIOR_TASKS = 50;
  const recentTasks = tasks.slice(-MAX_PRIOR_TASKS);
  const taskList = recentTasks.map(fmtTask).join("\n");
  const taskListHeader =
    tasks.length > MAX_PRIOR_TASKS
      ? `### Tasks already on the board (${tasks.length}, showing most recent ${MAX_PRIOR_TASKS})`
      : `### Tasks already on the board (${tasks.length})`;

  // Recent terminal/notable audit entries, newest first, capped so the prompt
  // stays bounded on long-running projects.
  const audit = repo
    .getAuditLog(db, project.id)
    .filter((e) =>
      ["task_done", "task_failed", "merge_decision", "rollback"].includes(e.kind),
    )
    .slice(0, 25)
    .map((e) => `- ${e.ts.slice(0, 10)} ${e.kind}: ${e.summary}`)
    .join("\n");

  const prd = project.prd?.trim()
    ? `### Prior PRD\n${project.prd.trim()}`
    : "### Prior PRD\n(none recorded)";

  return [
    prd,
    `${taskListHeader}\n${taskList}`,
    audit ? `### Recent activity\n${audit}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Branch names flow unsanitized into `git` argv (worktree-manager.ts,
// validator.ts) — arg arrays there mean no shell metacharacters can execute,
// but a leading `-` could still be parsed as a git flag rather than a
// refname. Keep the charset tight to plausible ref names.
const VALID_BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;
function isValidBranchName(branch: string): boolean {
  return VALID_BRANCH_NAME.test(branch) && !branch.startsWith("-");
}

// repoUrl is passed to `git clone` and `gh --repo` (git-service.ts,
// github.ts) — restrict to the two shapes those CLIs expect so a value like
// `--upload-pack=...` can't be smuggled in as a flag.
const VALID_REPO_URL =
  /^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+|git@github\.com:[\w.-]+\/[\w.-]+)(\.git)?\/?$/;
function isValidRepoUrl(url: string): boolean {
  return VALID_REPO_URL.test(url);
}

const pexecFile = promisify(execFile);

const VALID_MERGE_POLICIES: MergePolicy[] = [
  "hard_gate_flag_risky",
  "fully_autonomous",
  "always_ask",
];

/**
 * Validate + normalize a project's config override (F9). Gate script names
 * and testCommand ride into `execFile` arg arrays downstream (gate-runner.ts)
 * — no shell involved — so validation here is about sane values, not
 * injection. Returns `{ error }` on the first bad field, or `{ value }`
 * (possibly `undefined`, meaning "no config") otherwise.
 */
function parseProjectConfig(
  input: unknown,
): { error: string } | { value: ProjectConfig | undefined } {
  if (input == null) return { value: undefined };
  if (typeof input !== "object") return { error: "config must be an object" };
  const raw = input as Record<string, unknown>;
  const value: ProjectConfig = {};

  if (raw.setupCommand !== undefined) {
    const parsed = parseSetupCommand(raw.setupCommand);
    if ("error" in parsed) return parsed;
    value.setupCommand = parsed.value;
  }

  if (raw.maxAttempts !== undefined) {
    const n = raw.maxAttempts;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 20) {
      return { error: "config.maxAttempts must be an integer between 1 and 20" };
    }
    value.maxAttempts = n;
  }

  if (raw.mergePolicy !== undefined) {
    if (!VALID_MERGE_POLICIES.includes(raw.mergePolicy as MergePolicy)) {
      return { error: `config.mergePolicy must be one of: ${VALID_MERGE_POLICIES.join(", ")}` };
    }
    value.mergePolicy = raw.mergePolicy as MergePolicy;
  }

  if (raw.gates !== undefined) {
    if (typeof raw.gates !== "object" || raw.gates === null) {
      return { error: "config.gates must be an object" };
    }
    const g = raw.gates as Record<string, unknown>;
    const gates: NonNullable<ProjectConfig["gates"]> = {};
    for (const key of ["typecheckScript", "lintScript", "buildScript", "testScript"] as const) {
      const v = g[key];
      if (v === undefined) continue;
      if (v === false) {
        gates[key] = false;
        continue;
      }
      if (typeof v === "string" && v.trim().length > 0 && v.length <= 100) {
        gates[key] = v.trim();
        continue;
      }
      return { error: `config.gates.${key} must be a non-empty script name (<=100 chars) or false` };
    }
    if (g.testCommand !== undefined) {
      if (typeof g.testCommand !== "string" || g.testCommand.length > 500) {
        return { error: "config.gates.testCommand must be a string (<=500 chars)" };
      }
      const trimmed = g.testCommand.trim();
      if (trimmed) gates.testCommand = trimmed;
    }
    if (Object.keys(gates).length > 0) value.gates = gates;
  }

  if (raw.requireGithubChecks !== undefined) {
    if (typeof raw.requireGithubChecks !== "boolean") {
      return { error: "config.requireGithubChecks must be a boolean" };
    }
    value.requireGithubChecks = raw.requireGithubChecks;
  }

  if (raw.githubChecksTimeoutMin !== undefined) {
    const n = raw.githubChecksTimeoutMin;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 120) {
      return { error: "config.githubChecksTimeoutMin must be an integer between 1 and 120" };
    }
    value.githubChecksTimeoutMin = n;
  }

  if (raw.perTaskDocs !== undefined) {
    if (typeof raw.perTaskDocs !== "boolean") {
      return { error: "config.perTaskDocs must be a boolean" };
    }
    value.perTaskDocs = raw.perTaskDocs;
  }

  if (raw.skillHints !== undefined) {
    if (!Array.isArray(raw.skillHints)) {
      return { error: "config.skillHints must be an array of strings" };
    }
    if (raw.skillHints.length > 20) {
      return { error: "config.skillHints must have at most 20 entries" };
    }
    const hints: string[] = [];
    for (const h of raw.skillHints) {
      if (typeof h !== "string" || h.length > 200) {
        return { error: "config.skillHints entries must be strings of at most 200 chars" };
      }
      const trimmed = h.trim();
      if (trimmed) hints.push(trimmed);
    }
    if (hints.length > 0) value.skillHints = hints;
  }

  if (raw.gateImage !== undefined) {
    if (typeof raw.gateImage !== "string" || !isPlausibleImageRef(raw.gateImage)) {
      return { error: "config.gateImage must be a plausible Docker image reference (<=200 chars)" };
    }
    value.gateImage = raw.gateImage;
  }

  if (raw.schedule !== undefined) {
    if (typeof raw.schedule !== "object" || raw.schedule === null) {
      return { error: "config.schedule must be an object" };
    }
    const s = raw.schedule as Record<string, unknown>;
    if (typeof s.enabled !== "boolean") {
      return { error: "config.schedule.enabled must be a boolean" };
    }
    if (s.mode !== "interval" && s.mode !== "daily") {
      return { error: 'config.schedule.mode must be "interval" or "daily"' };
    }
    if (s.mode === "interval") {
      const n = s.intervalHours;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 24 * 30) {
        return { error: "config.schedule.intervalHours must be an integer between 1 and 720" };
      }
      value.schedule = { enabled: s.enabled, mode: "interval", intervalHours: n };
    } else {
      const hour = s.hour;
      const minute = s.minute;
      if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23) {
        return { error: "config.schedule.hour must be an integer between 0 and 23" };
      }
      if (typeof minute !== "number" || !Number.isInteger(minute) || minute < 0 || minute > 59) {
        return { error: "config.schedule.minute must be an integer between 0 and 59" };
      }
      value.schedule = { enabled: s.enabled, mode: "daily", hour, minute };
    }
  }

  return { value: Object.keys(value).length > 0 ? value : undefined };
}

/** A project's own maxAttempts override (F9), or the engine-wide default. */
function defaultMaxAttempts(project: Project): number {
  return project.config?.maxAttempts ?? 3;
}

/** The `origin` remote URL of a git working copy, or null if it isn't one
 *  (no .git, no origin, or git failed for any other reason). */
async function gitOriginUrl(dir: string): Promise<string | null> {
  try {
    const { stdout } = await pexecFile("git", ["remote", "get-url", "origin"], {
      cwd: dir,
      encoding: "utf-8",
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** True if `ancestor` is `of` itself or a directory containing it — i.e.
 *  deleting `ancestor` would also delete `of`. */
function isPathAncestorOrSame(ancestor: string, of: string): boolean {
  const a = ancestor.endsWith("/") ? ancestor.slice(0, -1) : ancestor;
  const b = of.endsWith("/") ? of.slice(0, -1) : of;
  return b === a || b.startsWith(`${a}/`);
}

/**
 * Guard against a project.localPath that would make DELETE /api/projects/:id
 * (or a future clone) destroy something it shouldn't. `localPath` must
 * already have `~` expanded to an absolute path.
 */
function validateLocalPath(localPath: string): string | null {
  if (!isAbsolute(localPath)) {
    return "localPath must be an absolute path";
  }
  const resolved = resolve(localPath);
  const home = homedir();
  if (resolved === "/") return "localPath cannot be '/'";
  if (resolved === home) return "localPath cannot be the home directory itself";
  if (isPathAncestorOrSame(resolved, process.cwd())) {
    return "localPath cannot be an ancestor of (or the same as) the server's own working directory";
  }
  if (isPathAncestorOrSame(resolved, resolve(ENV.reposDir))) {
    return "localPath cannot be an ancestor of (or the same as) the repos directory";
  }
  return null;
}

/**
 * A project's localPath either shouldn't exist yet (git clone will create
 * it), should be empty, or — if the operator points at a directory that
 * already exists — must already be a clone of the SAME repo. Anything else
 * (an unrelated project, a home directory full of dotfiles, etc.) is
 * rejected rather than silently reused (and later, on delete, rm -rf'd).
 */
async function localPathOkForClone(
  localPath: string,
  repoUrl: string,
): Promise<string | null> {
  if (!existsSync(localPath)) return null;
  if (!statSync(localPath).isDirectory()) {
    return "localPath already exists and is not a directory";
  }
  if (readdirSync(localPath).length === 0) return null;

  const origin = await gitOriginUrl(localPath);
  if (origin === repoUrl) return null;
  return origin
    ? `localPath already exists and is a git clone of a different repository (${origin})`
    : "localPath already exists, is non-empty, and is not a git clone of this repository";
}

/**
 * Whether DELETE /api/projects/:id may rm -rf a project's localPath: only
 * when it's deep enough to plausibly be a real clone (not e.g. the home
 * directory itself) AND its origin still matches the project's repoUrl. A
 * hand-edited localPath pointing anywhere else is left alone; the DB rows
 * are still deleted, but the operator is warned to clean up manually.
 */
async function safeToDeleteLocalPath(
  localPath: string,
  repoUrl: string,
): Promise<boolean> {
  if (localPath.length <= homedir().length + 1) return false;
  if (!existsSync(join(localPath, ".git"))) return false;
  return (await gitOriginUrl(localPath)) === repoUrl;
}

/** Replace secret fields with SECRET_SENTINEL before a settings object leaves
 *  the server (GET or PUT response). */
function redactSettings(settings: SettingsType): SettingsType {
  return {
    ...settings,
    apiToken: settings.apiToken ? SECRET_SENTINEL : undefined,
    telegram: settings.telegram && {
      ...settings.telegram,
      botToken: settings.telegram.botToken ? SECRET_SENTINEL : undefined,
    },
  };
}

async function main() {
  // S7: override only the `url` field of Fastify's default req serializer
  // (method/host/remoteAddress/etc. stay exactly as the default reports
  // them) so a token in the query string never reaches the logs.
  const app = Fastify({
    logger: {
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: redactTokenFromUrl(request.url),
            host: request.host,
            remoteAddress: request.ip,
            remotePort: request.socket ? request.socket.remotePort : undefined,
          };
        },
      },
    },
  });

  // Allowlist only — the dev web app's own origins plus any operator-added
  // CORS_ORIGINS. `origin: true` (reflect-any-origin) would let ANY website
  // open in the operator's browser call this API. Once the server serves the
  // built web app itself (F10), production traffic is same-origin and this
  // allowlist stops mattering.
  const DEV_WEB_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
  await app.register(cors, {
    origin: [...DEV_WEB_ORIGINS, ...ENV.corsOrigins],
  });
  await app.register(websocket);
  // F27: plan-mode attachment uploads. The route-level `req.file({ limits })`
  // call is the actual enforcement point (see the attachments routes below);
  // this registration-level default just keeps any future multipart route
  // from silently inheriting the plugin's own much smaller 1MB default.
  await app.register(multipart, {
    limits: { files: 1, fileSize: MAX_ATTACHMENT_BYTES },
  });

  // F10: once the web app is built (`apps/web/dist`), serve it from this same
  // process/port — one command, one port, no CORS needed in production
  // (same-origin). `here` is 3 directories below the repo root whether this
  // runs from source (`src/index.ts`, tsx) or the tsup bundle
  // (`dist/index.js`), so the relative path is identical either way. In dev
  // (Vite's own server on :5173, proxying /api + /ws here) this directory
  // won't exist, so this is a no-op.
  const here = dirname(fileURLToPath(import.meta.url));
  // F24: same "3 directories below the repo root" reasoning as webDist below —
  // read once at boot (not per-request) so /api/health and SetupView can show
  // what's actually deployed on a remote box instead of "ssh in and guess".
  const repoRoot = resolve(here, "../../../");
  const version = (
    JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  const webDist = resolve(repoRoot, "apps/web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      const url = req.raw.url ?? "";
      const isApiOrWs =
        url.startsWith("/api/") || url === WS_PATH || url.startsWith(`${WS_PATH}?`);
      if (isApiOrWs) return reply.code(404).send({ error: "not found" });
      return reply.type("text/html").sendFile("index.html");
    });
    app.log.info(`serving built web app from ${webDist}`);
  }

  const db = setupDb();
  const selfUpdater = new SelfUpdater({
    repoRoot,
    mock: ENV.mock,
  });
  const hub = new WsHub();
  const engine = new EngineRunner(db, hub);
  const maintenanceTimers: ReturnType<typeof setInterval>[] = [];
  const backgroundMaintenance = new Set<Promise<void>>();
  const requestControllers = new Set<AbortController>();

  // ensure settings exist
  if (!repo.getSettings(db)) {
    repo.upsertSettings(db, defaultSettings());
  }

  // Every agent output line is persisted forever otherwise — a few long runs
  // grow the logs table into hundreds of MB, slowing the WAL and snapshot
  // queries. Prune on boot (an old fat DB shrinks immediately) and again
  // once a day thereafter; recent history (what GET /api/tasks/:id/logs
  // actually serves) is unaffected either way.
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  function pruneOldLogs(): void {
    try {
      const deleted = repo.pruneLogs(db, ENV.logRetentionDays);
      if (deleted > 0) {
        app.log.info(`pruned ${deleted} old log row(s) (retention: ${ENV.logRetentionDays}d)`);
      }
    } catch (err) {
      app.log.warn(`log pruning failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  pruneOldLogs();
  const logPruneTimer = setInterval(pruneOldLogs, ONE_DAY_MS);
  logPruneTimer.unref();
  maintenanceTimers.push(logPruneTimer);

  // B23: mirrors pruneOldLogs — the notifications table otherwise grows
  // unbounded across months of autonomous runs. Never touches a pending
  // approval regardless of age (see pruneNotifications()'s own guard).
  function pruneOldNotifications(): void {
    try {
      const deleted = repo.pruneNotifications(db, ENV.notificationRetentionDays);
      if (deleted > 0) {
        app.log.info(
          `pruned ${deleted} old notification(s) (retention: ${ENV.notificationRetentionDays}d)`,
        );
      }
    } catch (err) {
      app.log.warn(
        `notification pruning failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  pruneOldNotifications();
  const notificationPruneTimer = setInterval(pruneOldNotifications, ONE_DAY_MS);
  notificationPruneTimer.unref();
  maintenanceTimers.push(notificationPruneTimer);

  // F17: online-backup the DB on boot and once a day thereafter. No-op for
  // a mock/in-memory boot (nothing durable to protect). A failed backup
  // must never crash the server — log a warning and move on.
  function backupDb(): void {
    const backup = runBackup(
      db,
      ENV.mock ? ":memory:" : ENV.dbPath,
      ENV.dbBackupDir,
      ENV.dbBackupKeep,
    )
      .then((result) => {
        if (!result.skipped) app.log.info(`DB backup written: ${result.file}`);
      })
      .catch((err) => {
        app.log.warn(`DB backup failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    backgroundMaintenance.add(backup);
    void backup.finally(() => backgroundMaintenance.delete(backup));
  }
  backupDb();
  const backupTimer = setInterval(backupDb, ONE_DAY_MS);
  backupTimer.unref();
  maintenanceTimers.push(backupTimer);

  // F19: cron-style auto-start — checked roughly once a minute (fine enough
  // granularity for a "daily at HH:MM" schedule) against every project's
  // config.schedule. Calls the exact same engine.start() the UI's Start
  // button does — no new dispatch mechanism. engine.start() is itself a
  // no-op if the project is already running; a manual dispatch in flight
  // throws, which is caught and skipped here (same as the /start route)
  // rather than treated as a real failure.
  const SCHEDULE_CHECK_MS = 60 * 1000;
  function checkSchedules(): void {
    for (const project of repo.getProjects(db)) {
      if (!isScheduleDue(project.config?.schedule, project.lastScheduledRunAt)) continue;
      // Only stamp lastScheduledRunAt on an actual successful kickoff — if
      // engine.start() throws (a manual dispatch is in flight), this cycle
      // doesn't count, so the next check can retry instead of silently
      // losing the schedule slot until the next interval/day.
      void startProject(db, engine, broadcast, project.id)
        .then((result) => {
          if (!result.ok) {
            app.log.info(
              `scheduled start skipped for "${project.name}": ${result.error}`,
            );
            return;
          }
          // Mirror the /start route: mark the project running and tell open
          // tabs the run began. Without this the UI kept showing the
          // pre-run status (completed/paused/created) for the whole
          // scheduled run, only correcting itself when the run's
          // finally-block wrote the final status.
          const updated = repo.updateProject(db, project.id, {
            status: "running",
            lastScheduledRunAt: new Date().toISOString(),
          });
          if (updated) broadcast({ type: "project.updated", payload: updated });
          app.log.info(`scheduled start: ${project.name}`);
        });
    }
  }
  const scheduleTimer = setInterval(checkSchedules, SCHEDULE_CHECK_MS);
  scheduleTimer.unref();
  maintenanceTimers.push(scheduleTimer);

  // Zombie approvals (B10): any approval-notification still unresolved from
  // before this boot has no live resolver anymore (EngineRunner.pendingApprovals
  // lived only in the previous process's memory) — stamp them expired now, before
  // resume-on-boot re-dispatches running projects, so the UI/Telegram never show
  // dead Approve/Reject controls for them.
  const expiredApprovals = repo.expireStaleApprovals(db);
  if (expiredApprovals > 0) {
    app.log.info(`expired ${expiredApprovals} stale approval notification(s) from before this boot`);
  }

  // F22: seeded *after* the expiry sweep above, not inside setupDb() —
  // B10's expireStaleApprovals runs unconditionally on every boot (mock or
  // not) and would otherwise immediately stamp a freshly-seeded pending
  // approval "expired_restart" before anyone ever saw it live, the same
  // interaction U1's own live-verification had to work around.
  if (ENV.mock) {
    for (const n of seed().notifications) {
      repo.createNotification(db, n);
    }
  }

  /** ENV.apiToken wins over the settings-stored one; either enables auth. */
  function getApiToken(): string | undefined {
    return ENV.apiToken || repo.getSettings(db)?.apiToken || undefined;
  }

  /**
   * Constant-time token compare (S6). `timingSafeEqual` throws on unequal
   * buffer lengths rather than returning false, so the length check must
   * come first — but comparing lengths still leaks length, not content,
   * which is the same tradeoff every constant-time-compare guide accepts.
   */
  function safeTokenEqual(candidate: string | undefined, expected: string): boolean {
    if (candidate === undefined) return false;
    const a = Buffer.from(candidate, "utf-8");
    const b = Buffer.from(expected, "utf-8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // Refuse to come up wide-open-and-unauthenticated: if HOST is bound beyond
  // loopback, either a token must gate the API or the operator must
  // explicitly opt into ALLOW_UNAUTHENTICATED=1 (e.g. a throwaway sandbox).
  const isLoopbackHost = ENV.host === "127.0.0.1" || ENV.host === "localhost";
  if (!isLoopbackHost && !getApiToken() && !ENV.allowUnauthenticated) {
    app.log.error(
      `HOST=${ENV.host} exposes the API beyond localhost with no API_TOKEN set. ` +
        `Set API_TOKEN (or settings.apiToken) to require auth, or set ` +
        `ALLOW_UNAUTHENTICATED=1 to start anyway (not recommended).`,
    );
    process.exit(1);
  }

  // Bearer-token auth (off by default). Skips /api/health so uptime checks
  // never need the token. The /ws upgrade takes it as `?token=` since
  // browsers can't set custom headers on a WebSocket handshake.
  app.addHook("onRequest", async (req, reply) => {
    const token = getApiToken();
    if (!token) return; // auth disabled — default, loopback-only use

    const url = req.raw.url ?? "";
    if (url === "/api/health" || url.startsWith("/api/health?")) return;

    const isApi = url.startsWith("/api/");
    const isWs = url === WS_PATH || url.startsWith(`${WS_PATH}?`);
    if (!isApi && !isWs) return;

    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const queryToken = isWs ? (req.query as { token?: string }).token : undefined;

    if (!safeTokenEqual(bearer, token) && !safeTokenEqual(queryToken, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  function broadcast(e: ServerEvent) {
    hub.broadcast(e);
  }

  /**
   * Resolve a pending approval from any channel (HTTP or Telegram). `resolved`
   * is false when no in-memory resolver was found for this notification id —
   * always the case for a B10 zombie (server restarted since it was created,
   * so nothing is actually waiting on it anymore) — in which case the DB is
   * left as-is (already stamped `expired_restart` from boot) rather than
   * overwriting that with the human's choice, which would misleadingly read
   * as a real response having taken effect.
   */
  function resolveNotification(
    id: string,
    choice: string,
  ): { notification: Notification; resolved: boolean } | null {
    const resolved = engine.resolveApproval(id, choice);
    if (!resolved) {
      const notification = repo.getNotification(db, id);
      if (!notification) return null;
      repo.createAuditEntry(db, {
        projectId: notification.projectId,
        taskId: notification.taskId,
        kind: "approval_resolved",
        actor: "human",
        summary: `${notification.title} → ${choice} (expired — no active run was waiting on it)`,
      });
      return { notification, resolved: false };
    }
    const notification = repo.respondToNotification(db, id, choice);
    if (!notification) return null;
    repo.createAuditEntry(db, {
      projectId: notification.projectId,
      taskId: notification.taskId,
      kind: "approval_resolved",
      actor: "human",
      summary: `${notification.title} → ${choice}`,
    });
    broadcast({ type: "notification", payload: notification });
    return { notification, resolved: true };
  }

  /** Shared planner/health path into B40's exactly-once ledger. */
  function recordModelInvocation(event: ModelInvocation, projectId?: string): void {
    const saved = persistInvocationEvent(db, {
      ...event,
      projectId: event.projectId ?? projectId,
    });
    if (!saved.transitioned || !saved.cost) return;
    broadcast({ type: "cost.updated", payload: saved.cost });
    if (saved.invocation.projectId) {
      engine.checkAndPushBudgetAlerts(saved.invocation.projectId);
    }
  }

  // ── Telegram (optional second channel) ──
  let telegram: TelegramBot | undefined;
  let telegramHealth: TelegramDeliveryHealth = {
    enabled: false,
    running: false,
    state: "disabled",
  };

  function projectControls(): TelegramCommandReply["inlineKeyboard"] {
    return repo.getProjects(db).slice(0, 12).map((project) => [
      {
        text: project.status === "running" ? `⏸ ${project.name}` : `▶ ${project.name}`,
        callbackData: `proj:${project.status === "running" ? "pause" : "start"}:${project.id}`,
      },
      { text: "Status", callbackData: `proj:status:${project.id}` },
    ]);
  }

  async function telegramCommand(
    cmd: string,
    args: string[],
  ): Promise<string | TelegramCommandReply> {
    switch (cmd) {
      case "help":
        return [
          "Commands:",
          "/status — projects + task counts",
          "/cost — spend this month",
          "/projects — list project ids",
          "/start <project-name-or-id-prefix>",
          "/pause <project-name-or-id-prefix>",
          "/autonomous [on|off] — view/flip the merge policy",
          "/pending — re-send open approvals",
          "/stopall — stop everything running (asks to confirm)",
          "/retry <taskId-or-prefix> — retry a failed/blocked task",
          "/digest [off|terminal|all] — view/set the status-digest level",
          "/health — per-model cooldown/quota/last-check summary",
        ].join("\n");
      case "projects": {
        const ps = repo.getProjects(db);
        return ps.length
          ? {
              text: ps.map((p) => `${p.name} [${p.status}] — ${p.id}`).join("\n"),
              inlineKeyboard: projectControls(),
            }
          : "No projects.";
      }
      case "status": {
        const ps = repo.getProjects(db);
        if (!ps.length) return "No projects.";
        return {
          text: ps.map((p) => {
            const ts = repo.getTasks(db, p.id);
            const done = ts.filter((t) => t.status === "done").length;
            const failed = ts.filter((t) => t.status === "failed").length;
            return `${p.name} [${p.status}] ${done}/${ts.length} done${failed ? `, ${failed} failed` : ""}`;
          })
          .join("\n"),
          inlineKeyboard: projectControls(),
        };
      }
      case "cost": {
        const monthly = repo.getGlobalMonthlyCost(db);
        const lines = repo
          .getProjects(db)
          .map((p) => `  ${p.name}: $${repo.getCostSummary(db, p.id).totalUsd.toFixed(4)}`);
        return `Spend this month: $${monthly.toFixed(4)}\n${lines.join("\n")}`;
      }
      case "start":
      case "pause": {
        const ref = args.join(" ");
        if (!ref) return `Usage: /${cmd} <project-name-or-id-prefix>`;
        const found = findProjectByPrefix(db, ref);
        if (!found.ok) return found.error;
        const project = found.project;
        if (cmd === "start") {
          const result = await startProject(db, engine, broadcast, project.id);
          if (!result.ok) return `Could not start ${project.name}: ${result.error}`;
          return `Started ${project.name}`;
        }
        const result = await pauseProject(db, engine, broadcast, project.id, true);
        if (!result.ok) return `Could not pause ${project.name}: ${result.error}`;
        return `Paused ${project.name}`;
      }
      case "autonomous": {
        const settings = repo.getSettings(db) ?? defaultSettings();
        const arg = (args[0] ?? "").toLowerCase();
        if (!arg) {
          return settings.mergePolicy === "fully_autonomous"
            ? "Autonomous mode is ON — validated changes auto-merge, but destructive-change rails and validator escalations still require a human."
            : `Autonomous mode is OFF (merge policy: ${settings.mergePolicy}).`;
        }
        if (arg !== "on" && arg !== "off") return "Usage: /autonomous [on|off]";
        const policy: MergePolicy = arg === "on" ? "fully_autonomous" : "hard_gate_flag_risky";
        setMergePolicy(db, policy, "telegram");
        return arg === "on"
          ? "Autonomous mode ON — validated changes auto-merge; destructive-change rails and validator escalations still require a human."
          : `Autonomous mode OFF — back to "${policy}" (risky changes ask before merging again).`;
      }
      case "pending": {
        if (!telegram) return "Telegram is not running.";
        const count = resendPendingApprovals(db, telegram);
        return count === 0
          ? "Nothing pending."
          : `Re-sent ${count} pending approval${count === 1 ? "" : "s"}.`;
      }
      case "stopall": {
        const projects = repo.getProjects(db);
        const active = projects.filter((p) => engine.hasActivity(p.id));
        if (active.length === 0) return "Nothing is running.";
        const activeTasks = active.reduce(
          (sum, p) =>
            sum +
            repo
              .getTasks(db, p.id)
              .filter((t) => t.status === "in_progress" || t.status === "in_review").length,
          0,
        );
        telegram?.confirmStopAll(
          `⚠️ This will stop ${active.length} active project${active.length === 1 ? "" : "s"} ` +
            `(${activeTasks} active task${activeTasks === 1 ? "" : "s"}): ` +
            `${active.map((p) => p.name).join(", ")}.`,
        );
        return ""; // confirmStopAll already sent its own message with the Yes/No keyboard
      }
      case "retry": {
        const prefix = args[0];
        if (!prefix) return "Usage: /retry <taskId-or-prefix>";
        const found = findTaskByIdPrefix(db, prefix);
        if (!found.ok) return found.error;
        const result = await retryTask(db, engine, broadcast, found.task.id, "telegram");
        return result.ok ? `Retrying "${result.task.title}".` : `Could not retry: ${result.error}`;
      }
      case "digest": {
        const settings = repo.getSettings(db) ?? defaultSettings();
        const arg = (args[0] ?? "").toLowerCase();
        if (!arg) return `Digest is currently: ${settings.telegram?.digest ?? "off"}`;
        if (arg !== "off" && arg !== "terminal" && arg !== "all") {
          return "Usage: /digest [off|terminal|all]";
        }
        if (!settings.telegram) return "Telegram isn't configured in Settings yet.";
        repo.upsertSettings(db, {
          ...settings,
          telegram: { ...settings.telegram, digest: arg },
        });
        return `Digest set to: ${arg}`;
      }
      case "health": {
        const models = computeModelHealth(db, engine);
        if (models.length === 0) return "No models configured.";
        const lines = models.map((m) => {
          const parts: string[] = [];
          if (m.coolingDownUntil) {
            parts.push(`cooling until ${new Date(m.coolingDownUntil).toLocaleTimeString()}`);
          }
          if (m.windowUsage) {
            const { runs, costUsd, maxRuns, maxCostUsd } = m.windowUsage;
            const runsPart = maxRuns != null ? `${runs}/${maxRuns} calls` : `${runs} calls`;
            const costPart = maxCostUsd != null ? `$${costUsd.toFixed(2)}/$${maxCostUsd.toFixed(2)}` : null;
            parts.push([runsPart, costPart].filter(Boolean).join(", "));
          }
          if (m.lastCheck) {
            parts.push(m.lastCheck.ok ? "last check ok" : `last check FAILED${m.lastCheck.error ? `: ${m.lastCheck.error}` : ""}`);
          }
          const prefix = m.enabled ? "" : "(disabled) ";
          return `${prefix}${m.displayName}: ${parts.length ? parts.join(" — ") : "no data yet"}`;
        });
        return lines.slice(0, 15).join("\n");
      }
      default:
        return `Unknown command /${cmd}. Try /help`;
    }
  }

  /** (Re)start the bot from current settings. Safe to call repeatedly. */
  function configureTelegram() {
    if (telegram) {
      telegram.stop();
      telegram = undefined;
      engine.setNotifier(undefined);
    }
    const settings = repo.getSettings(db) ?? defaultSettings();
    const tg = settings.telegram;
    if (!tg?.enabled) {
      telegramHealth = { enabled: false, running: false, state: "disabled" };
      return;
    }
    const tokenVar = tg.botTokenRef ?? "TELEGRAM_BOT_TOKEN";
    // Raw token (stored in settings) wins; otherwise read the named env var.
    const token = tg.botToken || process.env[tokenVar];
    if (!token) {
      telegramHealth = {
        enabled: true,
        running: false,
        state: "degraded",
        lastError: `No bot token configured (${tokenVar})`,
        lastErrorAt: new Date().toISOString(),
      };
      app.log.warn(
        `telegram enabled but no token (set botToken or env var ${tokenVar}) — bot not started`,
      );
      return;
    }
    telegram = new TelegramBot(
      token,
      tg.chatId ?? "",
      {
        onApproval: (id, choice) => {
          return resolveNotification(id, choice)?.resolved ?? false;
        },
        onCommand: telegramCommand,
        onProjectAction: async (action, projectId) => {
          const project = repo.getProject(db, projectId);
          if (!project) return "Project no longer exists.";
          if (action === "status") {
            const tasks = repo.getTasks(db, projectId);
            const done = tasks.filter((task) => task.status === "done").length;
            const failed = tasks.filter((task) => task.status === "failed").length;
            return `${project.name} [${project.status}] ${done}/${tasks.length} done${failed ? `, ${failed} failed` : ""}`;
          }
          const result = action === "start"
            ? await startProject(db, engine, broadcast, projectId)
            : await pauseProject(db, engine, broadcast, projectId, true);
          return result.ok
            ? `${action === "start" ? "Started" : "Paused"} ${result.project.name}`
            : `Could not ${action} ${project.name}: ${result.error}`;
        },
        onApprovalDeliveryFailure: (notificationId, error) => {
          notifyTelegramApprovalFailure(db, broadcast, notificationId, error);
        },
        onStopAllConfirm: async (confirmed) => {
          if (!confirmed) return "Cancelled — nothing was stopped.";
          const stoppedIds = await stopAllProjects(db, engine, broadcast, "telegram");
          return stoppedIds.length > 0
            ? `Stopped ${stoppedIds.length} project${stoppedIds.length === 1 ? "" : "s"}.`
            : "Nothing to stop (already idle).";
        },
      },
      (m) => app.log.info(m),
    );
    telegram.start();
    telegramHealth = telegram.health;
    engine.setNotifier(telegram);
    // Restart/settings-save recovery: re-send every still-live approval.
    resendPendingApprovals(db, telegram);
  }

  configureTelegram(); // start the bot at boot if enabled

  let engineShutdown: ReturnType<EngineRunner["shutdown"]> | undefined;
  const shutdown = new ShutdownCoordinator({
    stopAccepting: () => {
      for (const timer of maintenanceTimers) clearInterval(timer);
      for (const controller of requestControllers) controller.abort();
      requestControllers.clear();
      engineShutdown ??= engine.shutdown(repo.getProjects(db));
    },
    stopEngine: () => engineShutdown ?? engine.shutdown(repo.getProjects(db)),
    stopTelegram: () => {
      telegram?.stop();
      if (telegram) telegramHealth = telegram.health;
      telegram = undefined;
      engine.setNotifier(undefined);
    },
    flushLogs: async () => {
      engine.flushPendingLogs();
      await Promise.allSettled([...backgroundMaintenance]);
    },
    recordAudit: (reason, result) => {
      for (const projectId of result.stoppedProjectIds) {
        repo.updateProject(db, projectId, { status: "paused" });
        repo.createAuditEntry(db, {
          projectId,
          kind: "shutdown",
          actor: "engine",
          summary: `Runtime stopped for ${reason}`,
          detail: {
            settled: result.settled,
            pendingProjectIds: result.pendingProjectIds,
            pendingRollbackIds: result.pendingRollbackIds,
          },
        });
      }
    },
    closeServer: async () => {
      hub.close();
      await app.close();
    },
    checkpointDb: () => {
      if (!ENV.mock) db.pragma("wal_checkpoint(TRUNCATE)");
    },
    closeDb: () => {
      db.close();
    },
    log: (message, error) => {
      if (error) {
        app.log.error(
          `${message}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
        );
      } else {
        app.log.info(message);
      }
    },
    exit: (code) => process.exit(code),
  });

  // Existing keep-alive connections may issue another request while the
  // engine drains. Health remains readable; every mutating action is refused.
  app.addHook("onRequest", async (req, reply) => {
    if (shutdown.snapshot.state !== "shutting_down") return;
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      return;
    }
    return reply.code(503).send({ error: "server is shutting down" });
  });

  // ── Health ──
  app.get("/api/health", async () => {
    const dockerAvailable = await detectDocker();
    const settings = repo.getSettings(db) ?? defaultSettings();
    const dockerRequired = settings.sandboxGates === "required";
    return buildRuntimeHealth({
      lifecycle: shutdown.snapshot,
      mock: ENV.mock,
      version,
      dockerAvailable,
      dockerRequired,
      telegram: telegram?.health ?? telegramHealth,
    });
  });

  // ── Projects ──

  /** Expand a leading `~` to the home dir (shells do this; raw fs calls don't). */
  function expandHome(p: string): string {
    if (p === "~") return homedir();
    if (p.startsWith("~/")) return join(homedir(), p.slice(2));
    return p;
  }

  /**
   * Pick a readable, collision-free local clone dir: a slug of `name` under
   * `baseDir`, deduped with a numeric suffix against both disk and any other
   * project's `localPath` (which may not exist on disk yet — clones happen
   * lazily on first dispatch via GitService.ensureClone).
   */
  function uniqueLocalPath(baseDir: string, name: string): string {
    const slug = slugifyRepoName(name);
    const taken = new Set(repo.getProjects(db).map((p) => p.localPath));
    let candidate = join(baseDir, slug);
    for (let n = 2; existsSync(candidate) || taken.has(candidate); n++) {
      candidate = join(baseDir, `${slug}-${n}`);
    }
    return candidate;
  }

  app.post("/api/projects", async (req, reply) => {
    const body = req.body as {
      name: string;
      repoUrl?: string;
      createRepo?: boolean;
      repoName?: string;
      defaultBranch?: string;
      budgetUsd?: number;
      localPath?: string;
      config?: unknown;
    };
    if (!body.name) {
      return reply.code(400).send({ error: "name is required" });
    }

    const configResult = parseProjectConfig(body.config);
    if ("error" in configResult) {
      return reply.code(400).send({ error: configResult.error });
    }

    let repoUrl = body.repoUrl ?? "https://github.com/placeholder/repo";
    if (body.createRepo) {
      try {
        const created = createGithubRepo(body.repoName || body.name);
        repoUrl = created.repoUrl;
      } catch (err) {
        return reply.code(502).send({
          error: `could not create repo: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else if (!body.repoUrl) {
      return reply
        .code(400)
        .send({ error: "provide a repoUrl or set createRepo" });
    } else if (!isValidRepoUrl(body.repoUrl.trim())) {
      return reply.code(400).send({
        error:
          "repoUrl must be https://github.com/<owner>/<repo> or git@github.com:<owner>/<repo>",
      });
    }

    const defaultBranch = body.defaultBranch?.trim() || "main";
    if (!isValidBranchName(defaultBranch)) {
      return reply.code(400).send({
        error: "defaultBranch may only contain letters, digits, '.', '_', '/', '-', and must not start with '-'",
      });
    }

    const settings = repo.getSettings(db) ?? defaultSettings();
    const baseDir = expandHome(settings.defaultProjectsDir || ENV.reposDir);
    const localPath = body.localPath?.trim()
      ? expandHome(body.localPath.trim())
      : uniqueLocalPath(baseDir, body.name);

    const pathError = validateLocalPath(localPath);
    if (pathError) return reply.code(400).send({ error: pathError });
    const cloneError = await localPathOkForClone(localPath, repoUrl);
    if (cloneError) return reply.code(400).send({ error: cloneError });

    const id = crypto.randomUUID();
    const project = repo.createProject(db, {
      id,
      name: body.name,
      repoUrl,
      defaultBranch,
      localPath,
      budgetUsd: body.budgetUsd,
      config: configResult.value,
      status: "created",
    });
    broadcast({ type: "project.updated", payload: project });
    return reply.code(201).send({ project });
  });

  app.get("/api/projects", async () => {
    return { projects: repo.getProjects(db) };
  });

  app.get("/api/projects/:id", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    return { project };
  });

  app.patch("/api/projects/:id", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const body = req.body as {
      name?: string;
      budgetUsd?: number | null;
      defaultBranch?: string;
      config?: unknown;
    };
    const updates: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) updates.name = body.name.trim();
    if (typeof body.defaultBranch === "string" && body.defaultBranch.trim()) {
      const defaultBranch = body.defaultBranch.trim();
      if (!isValidBranchName(defaultBranch)) {
        return reply.code(400).send({
          error: "defaultBranch may only contain letters, digits, '.', '_', '/', '-', and must not start with '-'",
        });
      }
      updates.defaultBranch = defaultBranch;
    }
    // null clears the cap; a number sets it; undefined leaves it unchanged.
    if (body.budgetUsd === null) updates.budgetUsd = undefined;
    else if (typeof body.budgetUsd === "number" && body.budgetUsd >= 0) {
      updates.budgetUsd = body.budgetUsd;
    }
    // null clears the config override; an object replaces it wholesale;
    // undefined (the key absent) leaves it unchanged.
    if (body.config !== undefined) {
      const configResult = parseProjectConfig(body.config);
      if ("error" in configResult) {
        return reply.code(400).send({ error: configResult.error });
      }
      updates.config = configResult.value;
    }

    const updated = repo.updateProject(db, id, updates as Parameters<typeof repo.updateProject>[2]);
    if (updated) broadcast({ type: "project.updated", payload: updated });
    // F7: a changed budget cap re-arms the 50%/80% alerts for this project —
    // otherwise raising the cap after hitting 80% would permanently silence
    // future warnings even once spend climbs back past the same thresholds.
    if ("budgetUsd" in updates) repo.clearBudgetAlerts(db, `project:${id}`);
    return { project: updated };
  });

  app.delete("/api/projects/:id", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    if (engine.hasActivity(id)) {
      return reply
        .code(409)
        .send({ error: "project execution is active or still stopping — wait for it to settle before deleting" });
    }

    // Best-effort cleanup of the local clone + any leftover task worktrees
    // (`${localPath}-wt-<taskId>`). The DB delete below is the source of
    // truth; a failure here just leaves orphaned files on disk. Only ever
    // rm -rf when localPath still looks like a real, deep-enough clone of
    // THIS project's repo — a hand-edited localPath (e.g. "~" or "/") is
    // left untouched rather than wiped.
    try {
      const exists = existsSync(project.localPath);
      if (exists && (await safeToDeleteLocalPath(project.localPath, project.repoUrl))) {
        rmSync(project.localPath, { recursive: true, force: true });
        const parent = dirname(project.localPath);
        const base = project.localPath.slice(parent.length + 1);
        if (existsSync(parent)) {
          for (const entry of readdirSync(parent)) {
            if (entry.startsWith(`${base}-wt-`)) {
              rmSync(join(parent, entry), { recursive: true, force: true });
            }
          }
        }
      } else if (exists) {
        app.log.warn(
          `refusing to delete local files for project ${id}: ${project.localPath} ` +
            `is not a recognized git clone of ${project.repoUrl} — DB rows removed, disk left untouched`,
        );
      }
    } catch (err) {
      app.log.warn(`could not clean up local files for project ${id}: ${err}`);
    }

    repo.deleteProject(db, id);
    broadcast({ type: "project.deleted", payload: { id } });
    return reply.code(204).send();
  });

  app.post("/api/projects/:id/plan", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    // Same lock as the chat/deconstruct/commit routes below (defined there).
    const lockErr = planningLockError(project);
    if (lockErr) return reply.code(409).send({ error: lockErr });

    const body = req.body as { goal?: string; requireApproval?: boolean } | undefined;

    repo.updateProject(db, id, { status: "planning" });
    const goal = body?.goal ?? "";
    const settings = repo.getSettings(db) ?? defaultSettings();

    let prdMarkdown: string;
    const createdTasks: Task[] = [];
    const cancellation = plannerRequestCancellation(
      req.raw,
      reply.raw,
      requestControllers,
    );

    try {
      // Real planner: whichever model routing.planner resolves to turns the
      // goal into a PRD + dependency-ordered DAG (F37). A misconfigured
      // opencode planner falls into this same try/catch's stub fallback below
      // rather than a special-cased error — this legacy single-shot endpoint
      // never hard-fails, by design.
      const plannerModel = resolvePlannerModel(settings, "deconstruct");
      const cwd = await resolvePlannerCwd(project);
      const plan = await runPlanner(
        goal,
        project.name,
        cwd,
        plannerModel,
        (msg) => app.log.warn(msg),
        cancellation.signal,
        (event) => recordModelInvocation(event, id),
      );
      prdMarkdown = plan.prdMarkdown;
      // No review step on this single-shot path, so inject the standing docs
      // task here directly rather than relying on the Plan tab to add it.
      const tasksWithDocs = ensureDocsTask(plan.tasks, buildDocsTaskDraft(settings));
      createdTasks.push(...materializeTasks(db, project, tasksWithDocs, settings));
    } catch (err) {
      if (cancellation.signal.aborted) {
        repo.updateProject(db, id, { status: "planned" });
        return reply.code(499).send({ error: "planner request cancelled" });
      }
      // Fallback so planning never hard-fails (e.g. claude unavailable).
      app.log.warn(
        `planner failed, using stub: ${err instanceof Error ? err.message : String(err)}`,
      );
      prdMarkdown = `# PRD: ${project.name}\n\n${goal || "No goal provided."}\n`;
      const t1 = repo.createTask(db, {
        id: crypto.randomUUID(),
        projectId: id,
        title: "Initial setup & scaffolding",
        description: goal || "Set up the project structure",
        difficulty: "easy",
        status: "ready",
        dependsOn: [],
        acceptanceCriteria: ["Project builds", "Tests pass"],
        assignedModel: pickAssignedModel(settings.routing, "easy"),
        scopePaths: ["**/*"],
        attempts: 0,
        maxAttempts: defaultMaxAttempts(project),
      });
      const t2 = repo.createTask(db, {
        id: crypto.randomUUID(),
        projectId: id,
        title: "Core implementation",
        description: "Implement the main feature logic",
        difficulty: "medium",
        status: "backlog",
        dependsOn: [t1.id],
        acceptanceCriteria: ["Feature works end-to-end"],
        assignedModel: pickAssignedModel(settings.routing, "medium"),
        scopePaths: ["**/*"],
        attempts: 0,
        maxAttempts: defaultMaxAttempts(project),
      });
      createdTasks.push(t1, t2);
    } finally {
      cancellation.cleanup();
    }

    repo.updateProject(db, id, { status: "planned" });
    broadcast({ type: "project.updated", payload: repo.getProject(db, id)! });
    for (const t of createdTasks) {
      broadcast({ type: "task.updated", payload: t });
    }

    return {
      project: repo.getProject(db, id)!,
      tasks: repo.getTasks(db, id),
      prdMarkdown,
    };
  });

  // ── Planning: chat → deconstruct → commit ──

  // Planning writes are locked while the autonomous loop is running: a
  // mid-run /plan/commit would clobber project.status (planning → planned)
  // underneath the running loop and desync Start/Pause, and a mid-run task
  // batch would race the DAG the loop is already executing. Reads (session,
  // sessions archive, attachments list) stay open so the Plan tab can show
  // history during a run; chat re-opens when the run finishes.
  const planningLockError = (project: Project): string | null =>
    project.status === "running"
      ? "tasks are running — planning re-opens when the run finishes (chat history stays visible below)"
      : planningCommitInProgress(project.id)
        ? "planning commit is in progress — wait for it to finish before editing or retrying"
        : null;

  // One conversational turn. The web chat panel sends the full transcript.
  app.post("/api/projects/:id/plan/chat", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const lockErr = planningLockError(project);
    if (lockErr) return reply.code(409).send({ error: lockErr });

    const body = req.body as { messages?: PlanChatMessage[] } | undefined;
    const messages = body?.messages ?? [];
    if (messages.length === 0) {
      return reply.code(400).send({ error: "messages required" });
    }

    // F37: an opencode-runner planner is a config problem, not a runtime
    // failure — reject it up front with a clear 400 instead of letting it
    // surface as an opaque 502 from deep inside the try block below.
    let plannerModel: PlannerModel;
    try {
      plannerModel = resolvePlannerModel(repo.getSettings(db) ?? defaultSettings(), "chat");
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    const cancellation = plannerRequestCancellation(
      req.raw,
      reply.raw,
      requestControllers,
    );
    try {
      const cwd = await resolvePlannerCwd(project);
      // F27: name-only list of whatever's currently in context/attachments/
      // — buildChatPrompt turns this into a "read these with your file
      // tools" pointer, not an inline dump.
      const attachmentNames = listAttachments(attachmentsDir(project, ENV.mock)).map(
        (a) => a.name,
      );
      const { reply: text, costUsd } = await runPlannerChat(
        messages,
        project.name,
        cwd,
        plannerModel,
        buildPriorContext(db, project),
        attachmentNames,
        cancellation.signal,
        (event) => recordModelInvocation(event, id),
      );
      // Persist the full conversation (including assistant reply) so the Plan
      // tab can restore it on reload or after a tab switch.
      const updatedMessages = [...messages, { role: "assistant" as const, content: text }];
      repo.savePlanningSession(db, id, { messages: updatedMessages });
      recordPlanChatTurn(
        db,
        project,
        ENV.mock,
        updatedMessages,
        plannerModelLabel(plannerModel),
        (msg) => app.log.warn(msg),
      );
      return { reply: text, costUsd };
    } catch (err) {
      return reply.code(502).send({
        error: `planner chat failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      cancellation.cleanup();
    }
  });

  // Deconstruct the agreed conversation into a draft task DAG (NOT yet persisted as tasks).
  app.post("/api/projects/:id/plan/deconstruct", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const lockErr = planningLockError(project);
    if (lockErr) return reply.code(409).send({ error: lockErr });

    const body = req.body as Partial<PlanDeconstructRequest> | undefined;
    const messages = body?.messages ?? [];
    if (messages.length === 0) {
      return reply.code(400).send({ error: "messages required" });
    }
    if (
      body?.figmaVerification !== undefined &&
      body.figmaVerification !== "live" &&
      body.figmaVerification !== "attachments"
    ) {
      return reply.code(400).send({ error: "invalid figmaVerification mode" });
    }

    const settings = repo.getSettings(db) ?? defaultSettings();
    // F37: same up-front rejection as /plan/chat above.
    let plannerModel: PlannerModel;
    try {
      plannerModel = resolvePlannerModel(settings, "deconstruct");
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    const cancellation = plannerRequestCancellation(
      req.raw,
      reply.raw,
      requestControllers,
    );
    try {
      const cwd = await resolvePlannerCwd(project);
      const attachmentNames = listAttachments(attachmentsDir(project, ENV.mock)).map(
        (a) => a.name,
      );
      if (
        body?.figmaVerification === "attachments" &&
        attachmentNames.length === 0
      ) {
        return reply.code(400).send({
          error: "attach at least one screenshot before using the Figma attachment fallback",
        });
      }
      const planningSession = repo.getPlanningSession(db, id);
      const { output, costUsd, verifiedFigmaReferences } = await runPlannerDeconstruct(
        messages,
        project.name,
        cwd,
        plannerModel,
        buildPriorContext(db, project),
        attachmentNames,
        (msg) => app.log.warn(msg),
        cancellation.signal,
        (event) => recordModelInvocation(event, id),
        planningSession.verifiedFigmaReferences,
        (references) =>
          repo.savePlanningSession(db, id, {
            verifiedFigmaReferences: references,
          }),
        body?.figmaVerification ?? "live",
      );
      const tasks = withAssignedModels(
        output,
        settings,
        verifiedFigmaReferences,
      );
      // Persist draft tasks + PRD + AGENTS.md (F38) so the Plan tab can
      // restore them on reload.
      repo.savePlanningSession(db, id, {
        messages,
        prd: output.prdMarkdown,
        draftTasks: tasks,
        agentsMd: output.agentsMd,
        verifiedFigmaReferences: verifiedFigmaReferences ?? null,
      });
      recordPlanDeconstruct(
        db,
        project,
        ENV.mock,
        messages,
        output.prdMarkdown,
        tasks,
        plannerModelLabel(plannerModel),
        (msg) => app.log.warn(msg),
      );
      return {
        prdMarkdown: output.prdMarkdown,
        tasks,
        costUsd,
        agentsMd: output.agentsMd,
        verifiedFigmaReferences,
      };
    } catch (err) {
      if (err instanceof FigmaVerificationError) {
        return reply.code(409).send({
          error: err.message,
          code: "FIGMA_VERIFICATION_FAILED",
          details: { issue: err.issue, costUsd: err.costUsd },
        });
      }
      return reply.code(502).send({
        error: `deconstruction failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      cancellation.cleanup();
    }
  });

  // Save the user's in-progress edits to the draft task table without committing.
  app.post("/api/projects/:id/plan/save-draft", async (req, reply) => {
    const { id } = req.params as RouteParams;
    if (!repo.getProject(db, id)) return reply.code(404).send({ error: "project not found" });
    const body = req.body as { prdMarkdown?: string; tasks?: DraftTask[]; agentsMd?: string };
    repo.savePlanningSession(db, id, {
      prd: body.prdMarkdown,
      draftTasks: body.tasks ?? null,
      agentsMd: body.agentsMd,
    });
    return { ok: true };
  });

  // Return the persisted planning session for the Plan tab to restore on load.
  app.get("/api/projects/:id/plan/session", async (req, reply) => {
    const { id } = req.params as RouteParams;
    if (!repo.getProject(db, id)) return reply.code(404).send({ error: "project not found" });
    const session = repo.getPlanningSession(db, id);
    const planCostUsd = (
      db.prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total
         FROM model_invocations
         WHERE project_id = ? AND stage IN ('planner', 'deconstructor', 'health')`,
      ).get(id) as { total: number }
    ).total;
    return { ...session, planCostUsd };
  });

  // F28 read side: the archived plan-session markdown files, newest first —
  // the Plan tab's read-only chat history once a plan is committed (the live
  // session row is cleared then) and while tasks run.
  app.get("/api/projects/:id/plan/sessions", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    return { sessions: listArchivedSessions(project, ENV.mock) };
  });

  // F27: planning-context attachments — images/PDFs/reference files the
  // planner reads with its own file tools from the project's clone (see
  // attachments.ts for the storage-safety reasoning).
  app.get("/api/projects/:id/plan/attachments", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    return { attachments: listAttachments(attachmentsDir(project, ENV.mock)) };
  });

  app.post("/api/projects/:id/plan/attachments", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    let data;
    try {
      data = await req.file({ limits: { fileSize: MAX_ATTACHMENT_BYTES } });
    } catch {
      return reply.code(400).send({ error: "expected a multipart file upload" });
    }
    if (!data) return reply.code(400).send({ error: "no file provided" });

    const sanitized = sanitizeAttachmentName(data.filename);
    if (!sanitized) {
      return reply.code(400).send({
        error:
          "invalid filename — must have an allowed extension (png, jpg, jpeg, gif, webp, pdf, md, txt, csv, json)",
      });
    }

    let buffer: Buffer;
    try {
      buffer = await data.toBuffer();
    } catch (err) {
      if (err instanceof app.multipartErrors.RequestFileTooLargeError) {
        return reply.code(413).send({
          error: `file exceeds the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB limit`,
        });
      }
      throw err;
    }

    const dir = attachmentsDir(project, ENV.mock);
    return { attachments: saveAttachment(dir, sanitized, buffer) };
  });

  app.delete("/api/projects/:id/plan/attachments/:name", async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const updated = removeAttachment(attachmentsDir(project, ENV.mock), name);
    if (updated === null) return reply.code(404).send({ error: "attachment not found" });
    return { attachments: updated };
  });

  // Commit the (user-edited) draft tasks into real Task rows.
  app.post("/api/projects/:id/plan/commit", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const lockErr = planningLockError(project);
    if (lockErr) return reply.code(409).send({ error: lockErr });

    const body = req.body as { prdMarkdown?: string; tasks?: DraftTask[]; agentsMd?: string };
    if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
      return reply.code(400).send({ error: "tasks required" });
    }

    const settings = repo.getSettings(db) ?? defaultSettings();
    // The label is cosmetic only (this route doesn't itself call the planner)
    // so a since-changed/invalid routing.planner falls back to a generic label
    // rather than failing persistence over it.
    let committedPlannerLabel = "planner";
    try {
      committedPlannerLabel = plannerModelLabel(resolvePlannerModel(settings, "chat"));
    } catch {
      /* leave the generic fallback */
    }
    let committed;
    try {
      committed = await commitPlanningDraft(
        db,
        project,
        {
          prdMarkdown: body.prdMarkdown,
          tasks: body.tasks,
          agentsMd: body.agentsMd,
        },
        settings,
        committedPlannerLabel,
        ENV.mock,
        (message) => app.log.warn(message),
        { git: planningGitPersistence },
      );
    } catch (err) {
      const current = repo.getProject(db, id)!;
      broadcast({ type: "project.updated", payload: current });
      const message = err instanceof Error ? err.message : String(err);
      app.log.error(`planning commit failed for ${id}: ${message}`);
      const status = err instanceof PlanningCommitError && err.stage === "busy" ? 409 : 502;
      return reply.code(status).send({
        error: message,
        stage: err instanceof PlanningCommitError ? err.stage : "unknown",
      });
    }

    broadcast({ type: "project.updated", payload: committed.project });
    for (const task of committed.createdTasks) {
      broadcast({ type: "task.updated", payload: task });
    }

    const { createdTasks: _createdTasks, ...response } = committed;
    return response;
  });

  app.post("/api/projects/:id/start", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const result = await startProject(db, engine, broadcast, id);
    return result.ok
      ? { project: result.project }
      : reply.code(result.status).send({ error: result.error });
  });

  app.post("/api/projects/:id/pause", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const body = (req.body as { drain?: boolean } | undefined) ?? {};
    const result = await pauseProject(db, engine, broadcast, id, body.drain);
    return result.ok
      ? { project: result.project }
      : reply.code(result.status).send({ error: result.error });
  });

  // F23: the global "Stop all" panic button — one confirmed tap aborts
  // every currently-running project at once (autonomous loop + any
  // in-flight manual dispatch), same abort semantics as a per-project
  // Stop now. Always a hard stop, no drain option — this exists for "make
  // it stop NOW", not a graceful multi-project wind-down.
  app.post("/api/engine/stop-all", async () => {
    // One audit entry per affected project (not one global entry) since
    // AuditEntry.projectId is required and the Audit tab is per-project —
    // every affected project's own audit trail should show it was stopped,
    // with the full list of what else was hit alongside it (see
    // stopAllProjects above — shared with the Telegram /stopall command).
    const stoppedIds = await stopAllProjects(db, engine, broadcast, "human");
    return { projectIds: stoppedIds };
  });

  // ── Tasks ──
  app.get("/api/projects/:id/tasks", async (req) => {
    const { id } = req.params as RouteParams;
    return { tasks: repo.getTasks(db, id) };
  });

  // Materialize a single new task (F3 — "add a task while running"). B9's
  // Orchestrator.reconcileTasks() picks this up live if the project's
  // autonomous loop is already running; otherwise it just sits in
  // backlog/ready until the next Start.
  app.post("/api/projects/:id/tasks", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const body = req.body as {
      title?: string;
      description?: string;
      difficulty?: string;
      role?: string;
      acceptanceCriteria?: string[];
      dependsOn?: string[];
      scopePaths?: string[];
      assignedModel?: string;
    };
    const title = body.title?.trim();
    if (!title) return reply.code(400).send({ error: "title is required" });

    const difficulty = body.difficulty ?? "medium";
    if (!["easy", "medium", "hard"].includes(difficulty)) {
      return reply.code(400).send({ error: `invalid difficulty "${difficulty}"` });
    }

    const dependsOn = body.dependsOn ?? [];
    const existingIds = new Set(repo.getTasks(db, id).map((t) => t.id));
    const badDep = dependsOn.find((d) => !existingIds.has(d));
    if (badDep) {
      return reply.code(400).send({ error: `dependsOn references unknown task "${badDep}"` });
    }

    const settings = repo.getSettings(db) ?? defaultSettings();
    const difficultyTyped = difficulty as Difficulty;
    const role = body.role as Role | undefined;
    const assignedModel =
      (body.assignedModel as ModelId | undefined) ??
      pickAssignedModel(settings.routing, difficultyTyped, role);

    const task = repo.createTask(db, {
      id: crypto.randomUUID(),
      projectId: id,
      title,
      description: body.description ?? "",
      difficulty: difficultyTyped,
      status: dependsOn.length === 0 ? "ready" : "backlog",
      dependsOn,
      acceptanceCriteria: body.acceptanceCriteria ?? [],
      assignedModel,
      role,
      scopePaths: body.scopePaths?.length ? body.scopePaths : ["**/*"],
      attempts: 0,
      maxAttempts: defaultMaxAttempts(project),
    });

    repo.createAuditEntry(db, {
      projectId: id,
      taskId: task.id,
      kind: "task_added",
      actor: "human",
      summary: `Added task: ${task.title}`,
    });

    broadcast({ type: "task.updated", payload: task });
    return { task };
  });

  app.get("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const task = repo.getTask(db, id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    return { task };
  });

  app.patch("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const existing = repo.getTask(db, id);
    if (!existing) return reply.code(404).send({ error: "task not found" });

    const body = req.body as {
      status?: string;
      assignedModel?: string;
      acceptanceCriteria?: string[];
      scopePaths?: string[];
    };

    // A task that's actively executing (author running, or in_review while
    // gates/validator run) already captured its model/scope for this run
    // (the fallback chain and worktree are built from them at dispatch time)
    // — changing them now wouldn't be picked up until the next attempt at
    // best, and would be confusing mid-flight. Same reasoning covers status:
    // the only way to affect a live task is Stop (aborts the process / marks
    // it to bail at the next stage boundary); a raw status PATCH here would
    // just get silently overwritten by the engine's own next onTaskUpdated
    // call.
    if (
      (existing.status === "in_progress" || existing.status === "in_review") &&
      (body.status || body.assignedModel || body.scopePaths)
    ) {
      return reply.code(409).send({
        error: `task is ${existing.status} — use Stop to interrupt it, or wait for this attempt to finish before changing status/model/scope`,
      });
    }

    if (body.status !== undefined) {
      if (!TASK_STATUSES.includes(body.status as TaskStatus)) {
        return reply.code(400).send({
          error: `invalid status "${body.status}" — must be one of: ${TASK_STATUSES.join(", ")}`,
        });
      }
      // done is a merged/final state — only Rollback (revert the merge) or
      // Retry (re-run from scratch, which resets status itself) may move a
      // task off it. A raw PATCH back to e.g. in_progress would let orphan
      // recovery requeue and re-run work that's already merged to main.
      if (existing.status === "done") {
        return reply.code(409).send({
          error: "task is done — use Rollback to revert the merge or Retry to re-run it, not a direct status change",
        });
      }
      // Every other target (in_progress, in_review, changes_requested, done,
      // failed) is a state the engine itself assigns as the pipeline
      // progresses; the only human-meaningful manual transition is requeuing.
      if (body.status !== "backlog" && body.status !== "ready") {
        return reply.code(400).send({
          error: `PATCH can only requeue a task to "backlog" or "ready" — "${body.status}" is set by the engine as the task runs, not by hand`,
        });
      }
    }

    // The validator must differ from the author or ValidatorImpl.review()
    // throws "self-review is forbidden" mid-run (after gates already passed,
    // wasting that attempt). Catch the collision here instead, where it's a
    // clear 400 the UI can surface immediately.
    if (body.assignedModel) {
      const settings = repo.getSettings(db) ?? defaultSettings();
      const validatorModel =
        settings.routing.validatorByDifficulty[existing.difficulty];
      if (body.assignedModel === validatorModel) {
        return reply.code(400).send({
          error: `${body.assignedModel} is also the validator for ${existing.difficulty} tasks — choose a different author model or change the validator routing in Settings`,
        });
      }
    }

    const updates: Record<string, unknown> = {};
    if (body.status) updates.status = body.status;
    if (body.assignedModel) updates.assignedModel = body.assignedModel;
    if (body.acceptanceCriteria) updates.acceptanceCriteria = body.acceptanceCriteria;
    if (body.scopePaths) updates.scopePaths = body.scopePaths;

    const updated = repo.updateTask(db, id, updates as Parameters<typeof repo.updateTask>[2]);
    if (updated) broadcast({ type: "task.updated", payload: updated });
    return { task: updated };
  });

  app.post("/api/tasks/:id/dispatch", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const task = repo.getTask(db, id);
    if (!task) return reply.code(404).send({ error: "task not found" });

    if (task.status !== "ready" && task.status !== "backlog") {
      return reply.code(409).send({ error: `task is ${task.status}, not dispatchable` });
    }

    const settings = repo.getSettings(db);
    if (!settings) return reply.code(500).send({ error: "settings not found" });

    // Budget check
    const budgetMsg = checkBudget(db, task.projectId, task.assignedModel, settings);
    if (budgetMsg) {
      return reply.code(403).send({ error: `budget cap: ${budgetMsg}` });
    }

    // Persist a priority request. Status/attempts change only when the shared
    // scheduler genuinely dispatches the task and emits its run event.
    const project = repo.getProject(db, task.projectId)!;
    try {
      return { task: await engine.dispatchOne(project, task.id) };
    } catch (err) {
      return reply.code(409).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/api/tasks/:id/stop", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const task = repo.getTask(db, id);
    if (!task) return reply.code(404).send({ error: "task not found" });

    // Stop is an active-process operation, not a generic status editor.
    const stoppedLive = engine.stopTask(task.projectId, id);
    if (!stoppedLive) {
      return reply.code(409).send({ error: "task has no active execution to stop" });
    }

    // The WHERE status guard makes a terminal engine update win if it commits
    // first. Never turn a task that actually completed into "blocked".
    const stopOutcome = repo.markTaskStoppedIfActive(db, id);
    const updatedTask = stopOutcome.task ?? task;
    if (!stopOutcome.changed) {
      return { task: updatedTask };
    }

    const runs = repo.getRuns(db, id);
    const activeRun = runs.find((r) => r.status === "running");
    if (activeRun) {
      const now = new Date().toISOString();
      repo.updateRun(db, activeRun.id, {
        status: "stopped",
        endedAt: now,
        exitReason: "killed",
      });
      broadcast({
        type: "run.updated",
        payload: repo.getRun(db, activeRun.id)!,
      });
    }

    broadcast({ type: "task.updated", payload: updatedTask });

    repo.createAuditEntry(db, {
      projectId: task.projectId,
      taskId: id,
      kind: "stopped",
      actor: "human",
      summary: `Stopped "${task.title}" — agent process aborted`,
    });

    return { task: updatedTask };
  });

  // Start or resume a task's gated, human-approved rollback PR.
  app.post("/api/tasks/:id/rollback", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const task = repo.getTask(db, id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    if (!task.prNumber) {
      return reply.code(409).send({ error: "task has no merged PR to roll back" });
    }
    const project = repo.getProject(db, task.projectId);
    if (!project) return reply.code(404).send({ error: "project not found" });

    try {
      const rollback = await engine.rollback(project, task);
      return reply.code(202).send({ task, rollback });
    } catch (err) {
      return reply.code(409).send({
        error: `rollback could not start: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  app.get("/api/tasks/:id/rollback", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const task = repo.getTask(db, id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    if (!task.prNumber) return { rollback: null };
    return {
      rollback: repo.getRollbackJobForTask(db, task.id, task.prNumber),
    };
  });

  // Retry a failed/blocked task from scratch (resets attempts, re-dispatches).
  app.post("/api/tasks/:id/retry", async (req, reply) => {
    const { id } = req.params as RouteParams;
    // retryTask (above main()) also backs the Telegram /retry command — a
    // prior failed attempt's prNumber/branch/worktreePath are cleared there
    // so the new attempt's freshly-branched worktree can push to the same
    // branch name without a non-fast-forward rejection.
    const result = await retryTask(db, engine, broadcast, id, "human");
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return { task: result.task };
  });

  // PR diff for a task (for the in-UI diff viewer).
  app.get("/api/tasks/:id/diff", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const task = repo.getTask(db, id);
    if (!task) return reply.code(404).send({ error: "task not found" });
    if (!task.prNumber) {
      return reply.code(409).send({ error: "task has no PR yet" });
    }
    const project = repo.getProject(db, task.projectId);
    if (!project) return reply.code(404).send({ error: "project not found" });

    try {
      const diff = getPrDiff(project.repoUrl, task.prNumber);
      const MAX = 200_000;
      return {
        prNumber: task.prNumber,
        diff: diff.length > MAX ? diff.slice(0, MAX) + "\n… (diff truncated)" : diff,
      };
    } catch (err) {
      return reply.code(502).send({
        error: `could not fetch diff: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // ── Runs ──
  app.get("/api/tasks/:id/runs", async (req) => {
    const { id } = req.params as RouteParams;
    return { runs: repo.getRuns(db, id) };
  });

  // Every validator verdict for a task, newest first (F2's Review tab).
  app.get("/api/tasks/:id/decisions", async (req) => {
    const { id } = req.params as RouteParams;
    return { decisions: repo.getMergeDecisions(db, id) };
  });

  app.get("/api/runs/:id/logs", async (req) => {
    const { id } = req.params as RouteParams;
    return { logs: repo.getLogs(db, id) };
  });

  // Every onLog emission is keyed by task_id regardless of which run it
  // belongs to (or whether a run exists yet at all — engine-level logs), so
  // this is the route that actually backs the Board's log history after a
  // reload; runLogs above matches nothing for logs written before runId was
  // populated correctly.
  app.get("/api/tasks/:id/logs", async (req, reply) => {
    const { id } = req.params as RouteParams;
    if (!repo.getTask(db, id)) return reply.code(404).send({ error: "task not found" });
    const query = req.query as { after?: string; limit?: string };
    const limit = query.limit
      ? Math.max(1, Math.min(5000, parseInt(query.limit, 10) || 1000))
      : 1000;
    return { logs: repo.getLogsByTask(db, id, { after: query.after, limit }) };
  });

  // ── Costs ──
  app.get("/api/projects/:id/costs", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const { totalUsd, byModel } = repo.getCostSummary(db, id);
    return {
      totalUsd,
      byModel,
      records: repo.getCosts(db, id),
    };
  });

  // Rich analytics: per-model + tokens, daily series, per-task, burn projection.
  app.get("/api/projects/:id/analytics", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const a = repo.getCostAnalytics(db, id);
    const tasks = repo.getTasks(db, id);
    const completedTasks = tasks.filter((t) => t.status === "done").length;
    const avgCostPerCompletedTask =
      completedTasks > 0 ? a.totalUsd / completedTasks : 0;

    let remainingBudgetUsd: number | undefined;
    let tasksUntilCap: number | undefined;
    if (project.budgetUsd) {
      remainingBudgetUsd = Math.max(0, project.budgetUsd - a.totalUsd);
      if (avgCostPerCompletedTask > 0) {
        tasksUntilCap = Math.floor(remainingBudgetUsd / avgCostPerCompletedTask);
      }
    }

    return {
      ...a,
      budgetUsd: project.budgetUsd,
      completedTasks,
      avgCostPerCompletedTask,
      remainingBudgetUsd,
      tasksUntilCap,
    };
  });

  // Pre-run estimate for all not-yet-done tasks in the project.
  app.get("/api/projects/:id/estimate", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const settings = repo.getSettings(db) ?? defaultSettings();
    return estimatePlan(db, id, settings);
  });

  // ── Settings ──
  app.get("/api/settings", async () => {
    const settings = repo.getSettings(db) ?? defaultSettings();
    return { settings: redactSettings(settings) };
  });

  app.put("/api/settings", async (req, reply) => {
    const body = req.body as { settings?: Partial<import("@orc/types").Settings> };
    if (!body.settings) return reply.code(400).send({ error: "settings body required" });

    const current = repo.getSettings(db) ?? defaultSettings();
    let patch: unknown = body.settings;
    if (typeof patch === "object" && patch !== null && !Array.isArray(patch)) {
      const objectPatch = { ...(patch as Record<string, unknown>) };
      // A round-tripped sentinel (or a field the client never touched) must
      // never overwrite the real stored secret. Preserve invalid non-string
      // values unchanged so the shared validator can reject them.
      const incomingApiToken = objectPatch.apiToken;
      if (
        incomingApiToken === SECRET_SENTINEL ||
        incomingApiToken === undefined ||
        incomingApiToken === null ||
        incomingApiToken === ""
      ) {
        objectPatch.apiToken = current.apiToken;
      }
      const incomingTelegram = objectPatch.telegram;
      if (
        typeof incomingTelegram === "object" &&
        incomingTelegram !== null &&
        !Array.isArray(incomingTelegram)
      ) {
        const telegramPatch = incomingTelegram as Record<string, unknown>;
        const incomingToken = telegramPatch.botToken;
        objectPatch.telegram = {
          ...telegramPatch,
          botToken:
            incomingToken === SECRET_SENTINEL ||
            incomingToken === undefined ||
            incomingToken === null ||
            incomingToken === ""
              ? current.telegram?.botToken
              : incomingToken,
        };
      }
      patch = objectPatch;
    }

    let merged: SettingsType;
    try {
      merged = mergeSettingsUpdate(current, patch);
    } catch (err) {
      if (err instanceof SettingsValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }

    const saved = repo.upsertSettings(db, merged);
    configureTelegram(); // apply enable/disable/token/chatId changes live

    // B28: this edit itself can only produce a routing-referenced model
    // that exists (checked above) — but a task's own `assignedModel` is a
    // row, not a setting, so it can still dangle here (this exact save
    // removed/renamed the model a still-active task points at). Not
    // blocking: the orchestrator's own dispatch/attempt-loop guards are the
    // actual safety net (requeue-to-backlog instead of a Fatal crash) —
    // this is purely an operator-visible heads-up in the server log.
    const validModelIds = new Set(merged.models.map((m) => m.id));
    for (const p of repo.getProjects(db)) {
      for (const t of repo.getTasks(db, p.id)) {
        if (
          t.status !== "done" &&
          t.status !== "failed" &&
          !validModelIds.has(t.assignedModel)
        ) {
          app.log.warn(
            `task ${t.id} ("${t.title}") in project ${p.id} is assigned to ` +
              `model "${t.assignedModel}", which no longer exists in Settings`,
          );
        }
      }
    }

    return { settings: redactSettings(saved) };
  });

  // Send a one-off test message. Uses saved config unless the body overrides it,
  // so the user can verify token + chat id before flipping `enabled` on.
  app.post("/api/telegram/test", async (req, reply) => {
    const body = (req.body as { token?: string; chatId?: string }) ?? {};
    const settings = repo.getSettings(db) ?? defaultSettings();
    const tg = settings.telegram;
    const tokenVar = tg?.botTokenRef ?? "TELEGRAM_BOT_TOKEN";
    const token = body.token || tg?.botToken || process.env[tokenVar];
    const chatId = body.chatId || tg?.chatId;
    if (!token) return reply.code(400).send({ ok: false, error: "no bot token" });
    if (!chatId) return reply.code(400).send({ ok: false, error: "no chat id" });
    const result = await sendTelegramMessage(
      token,
      chatId,
      "✅ Hoopedorc test message — your Telegram is wired up.",
    );
    return result;
  });

  // ── Notifications ──
  app.get("/api/notifications", async (req) => {
    const query = req.query as { projectId?: string };
    return { notifications: repo.getNotifications(db, query.projectId) };
  });

  app.post("/api/notifications/:id/respond", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const body = req.body as { choice: string };
    if (!body.choice) return reply.code(400).send({ error: "choice is required" });

    const result = resolveNotification(id, body.choice);
    if (!result) return reply.code(404).send({ error: "notification not found" });
    if (!result.resolved) {
      // B10: no in-memory resolver was waiting (the run that requested this
      // approval — if any — died with a previous server process). Say so
      // explicitly rather than returning 200 as if the choice took effect.
      return reply.code(410).send({
        notification: result.notification,
        error:
          "approval expired — the task will re-request approval if it's still needed",
      });
    }

    return { notification: result.notification };
  });

  // ── Audit log ──
  app.get("/api/projects/:id/audit", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    return { entries: repo.getAuditLog(db, id) };
  });

  // ── Setup / health check ──
  app.get("/api/setup", async (req, reply) => {
    const settings = repo.getSettings(db) ?? defaultSettings();
    const cancellation = plannerRequestCancellation(
      req.raw,
      reply.raw,
      requestControllers,
    );
    try {
      return await runSetupChecks(
        settings,
        repo.getProjects(db),
        cancellation.signal,
      );
    } finally {
      cancellation.cleanup();
    }
  });

  function runningProjectNames(): string[] {
    return repo
      .getProjects(db)
      .filter((project) => project.status === "running")
      .map((project) => project.name);
  }

  function selfUpdateRuntimeBlocker(): string | undefined {
    return getApiToken() && !ENV.apiToken
      ? "UI updates require API_TOKEN in .env so the detached updater can repeat the active-project check."
      : undefined;
  }

  // F50: read-only deployment capability plus durable progress from the
  // separate transient systemd updater.
  app.get("/api/setup/self-update", async () => {
    return selfUpdater.status(runningProjectNames(), selfUpdateRuntimeBlocker());
  });

  // No body by design: clients cannot choose a command, branch, checkout,
  // service, or argument. The fixed updater repeats every safety check after
  // launch to close the request-to-process race.
  app.post("/api/setup/self-update", async (_req, reply) => {
    try {
      const status = await selfUpdater.start(
        runningProjectNames(),
        selfUpdateRuntimeBlocker(),
      );
      return reply.code(202).send({ status });
    } catch (error) {
      if (error instanceof SelfUpdateRefusedError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  // Live-test every enabled model with a trivial prompt (costs a little).
  app.post("/api/setup/test-models", async (req, reply) => {
    const settings = repo.getSettings(db) ?? defaultSettings();
    const cancellation = plannerRequestCancellation(
      req.raw,
      reply.raw,
      requestControllers,
    );
    let result: Awaited<ReturnType<typeof testModels>>;
    try {
      result = await testModels(
        settings,
        ENV.opencodeBaseUrl,
        (event) => recordModelInvocation(event),
        cancellation.signal,
      );
    } finally {
      cancellation.cleanup();
    }
    // F6: persist each result so the health panel has a "last check" column
    // that survives a reload, not just whatever's in this response.
    const ts = new Date().toISOString();
    for (const r of result.results) {
      repo.createModelCheck(db, {
        invocationId: r.invocationId,
        modelId: r.id,
        displayName: r.displayName,
        ok: r.ok,
        costUsd: r.costUsd,
        ms: r.ms,
        reply: r.reply,
        error: r.error,
        ts,
      });
    }
    return result;
  });

  // Full opencode model roster, for the onboarding wizard's model-mapping step.
  app.get("/api/setup/models", async (req, reply) => {
    const cancellation = plannerRequestCancellation(
      req.raw,
      reply.raw,
      requestControllers,
    );
    try {
      return await getModelRoster(cancellation.signal);
    } finally {
      cancellation.cleanup();
    }
  });

  app.get("/api/setup/model-catalog", async (req, reply) => {
    const cancellation = plannerRequestCancellation(
      req.raw,
      reply.raw,
      requestControllers,
    );
    try {
      return await getModelCatalog(cancellation.signal);
    } finally {
      cancellation.cleanup();
    }
  });

  // Per-model observability for the multi-subscription audience (F6): last
  // health check, rolling failure rate + median duration from real runs, and
  // whether the model is currently cooling down from a rate limit.
  app.get("/api/setup/model-health", async () => {
    // computeModelHealth (above main()) also backs the Telegram /health command.
    return { models: computeModelHealth(db, engine) };
  });

  // ── Realtime (WebSocket) ──
  // Catch-up snapshot is scoped to the project a client subscribes to (see
  // WsHub.add) instead of replaying every project's full history on connect.
  hub.setSnapshotProvider((projectId) => {
    const project = repo.getProject(db, projectId);
    if (!project) return [];
    const events: ServerEvent[] = [
      { type: "project.updated", payload: project },
    ];
    for (const t of repo.getTasks(db, projectId)) {
      events.push({ type: "task.updated", payload: t });
      for (const r of repo.getRuns(db, t.id)) {
        events.push({ type: "run.updated", payload: r });
      }
    }
    return events;
  });

  app.get(WS_PATH, { websocket: true }, (socket) => {
    hub.add(socket);

    // The list of projects is needed up-front (before any subscribe) so the
    // project switcher can populate. Tasks/runs are deferred to subscribe.
    for (const p of repo.getProjects(db)) {
      socket.send(JSON.stringify({ type: "project.updated", payload: p }));
    }

    // MOCK mode: synthetic log stream
    if (ENV.mock) {
      const tasks = repo.getTasks(db, "proj-hoopedorc");
      const interval = setInterval(() => {
        const log: ServerEvent = {
          type: "log",
          payload: {
            id: crypto.randomUUID(),
            projectId: "proj-hoopedorc",
            runId: "run-mock",
            taskId: tasks[0]?.id ?? "t1",
            ts: new Date().toISOString(),
            level: "info",
            source: "agent",
            message: `mock log @ ${new Date().toLocaleTimeString()}`,
          },
        };
        socket.send(JSON.stringify(log));
      }, 2000);
      socket.on("close", () => clearInterval(interval));
    }
  });

  installShutdownHandlers(shutdown, process, (label, error) => {
    app.log.error(
      `${label}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    );
  });

  await app.listen({ port: ENV.port, host: ENV.host });
  shutdown.markRunning();
  app.log.info(
    `hoopedorc server up on ${ENV.host}:${ENV.port} (mock=${ENV.mock})`,
  );

  // Resume-on-boot. A project's status lives in the DB but the orchestrator
  // driving it lives only in this process's memory. So if the server restarts
  // while a project is "running" — crash, OOM, deploy, dev-server reload —
  // the project stays "running" in the DB with nothing actually working on it,
  // and silently hangs forever. On boot, re-dispatch any project still marked
  // "running"; the orchestrator's orphan recovery requeues whatever task was
  // mid-flight, so this picks up cleanly. Skipped in mock mode (no real engine).
  if (!ENV.mock) {
    const resumedRollbacks = engine.resumeRollbacks();
    if (resumedRollbacks > 0) {
      app.log.info(`resuming ${resumedRollbacks} rollback job(s) after restart`);
    }
    for (const p of repo.getProjects(db)) {
      if (p.status === "running" && !engine.hasActivity(p.id)) {
        app.log.info(`resuming project ${p.name} (${p.id}) after restart`);
        void engine.start(p).catch((err) => {
          app.log.error(
            `failed to resume ${p.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    }
    for (const p of repo.getProjects(db)) {
      if (engine.resumeQueued(p)) {
        app.log.info(`resuming queued task dispatches for ${p.name} (${p.id})`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
