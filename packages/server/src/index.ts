import "dotenv/config";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { Project, ServerEvent, Task } from "@orc/types";
import { WS_PATH, pickAssignedModel } from "@orc/types";
import { GitServiceImpl } from "@orc/engine";
import { ENV, defaultSettings } from "./config";
import { seed } from "./mock";
import type { Db } from "./db/index";
import { initDb } from "./db/index";
import * as repo from "./db/repo";
import { WsHub } from "./ws-hub";
import { EngineRunner } from "./engine-runner";
import {
  runPlanner,
  runPlannerChat,
  runPlannerDeconstruct,
  type PlanOutput,
} from "./planner";
import { createGithubRepo, getPrDiff, slugifyRepoName } from "./github";
import { checkBudget } from "./budget";
import { estimatePlan } from "./estimate";
import { TelegramBot, sendTelegramMessage } from "./telegram";
import { runSetupChecks, testModels } from "./setup";
import type {
  DraftTask,
  PlanChatMessage,
  Settings as SettingsType,
} from "@orc/types";

type RouteParams = { id: string };

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

/** A planner/draft task: dependsOn are indices into the same array. */
type MaterializableTask = {
  title: string;
  description: string;
  difficulty: Task["difficulty"];
  role?: Task["role"];
  acceptanceCriteria: string[];
  dependsOn: number[];
  scopePaths: string[];
  assignedModel?: Task["assignedModel"];
};

/**
 * Turn index-based draft tasks into real Task rows, resolving index deps to ids
 * and computing readiness from deps. Shared by /plan and /plan/commit.
 */
function materializeTasks(
  db: Db,
  projectId: string,
  drafts: MaterializableTask[],
  settings: SettingsType,
): Task[] {
  const ids = drafts.map(() => crypto.randomUUID());
  return drafts.map((pt, i) =>
    repo.createTask(db, {
      id: ids[i]!,
      projectId,
      title: pt.title,
      description: pt.description,
      difficulty: pt.difficulty,
      status: pt.dependsOn.length === 0 ? "ready" : "backlog",
      dependsOn: pt.dependsOn.map((d) => ids[d]!).filter(Boolean),
      acceptanceCriteria: pt.acceptanceCriteria,
      assignedModel:
        pt.assignedModel ??
        pickAssignedModel(settings.routing, pt.difficulty, pt.role),
      role: pt.role,
      scopePaths: pt.scopePaths,
      attempts: 0,
      maxAttempts: 3,
    }),
  );
}

/**
 * A standing documentation task: no dependencies, so it dispatches immediately
 * alongside the first coding tasks instead of waiting for everything else to
 * land first ("docs while others code"). Scoped to README.md/docs/** so it
 * can never collide with any coding task's scope.
 */
function buildDocsTaskDraft(settings: SettingsType): DraftTask {
  return {
    title: "Project documentation",
    description:
      "Write thorough project documentation in README.md: what the project does, how to " +
      "install dependencies, how to run it locally (dev server, build, start/production), " +
      "and the key dependencies and why they're used. Base this on the PRD and whatever " +
      "code already exists in the repo when you run — other tasks may still be in progress " +
      "in parallel, so describe what's planned vs. what's already implemented rather than " +
      "claiming everything is done. Prefer accuracy over completeness.",
    difficulty: "easy",
    role: "docs",
    acceptanceCriteria: [
      "README.md exists at the repo root",
      "README explains what the project does in plain language",
      "README lists exact install commands",
      "README lists exact commands to run it locally and to build/start for production",
      "README lists key dependencies and what each is for",
    ],
    dependsOn: [],
    scopePaths: ["README.md", "docs/**"],
    assignedModel: pickAssignedModel(settings.routing, "easy", "docs"),
  };
}

/** Add a standing docs task unless one already exists (avoid duplicates). */
function ensureDocsTask<T extends { role?: Task["role"] }>(
  tasks: T[],
  docsTask: T,
): T[] {
  return tasks.some((t) => t.role === "docs") ? tasks : [...tasks, docsTask];
}

/** Resolve each draft task's suggested author model for display before commit. */
function withAssignedModels(
  output: PlanOutput,
  settings: SettingsType,
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
  return ensureDocsTask(tasks, buildDocsTaskDraft(settings));
}

const gitForPlanning = new GitServiceImpl();

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

async function main() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const db = setupDb();
  const hub = new WsHub();
  const engine = new EngineRunner(db, hub);

  // ensure settings exist
  if (!repo.getSettings(db)) {
    repo.upsertSettings(db, defaultSettings());
  }

  function broadcast(e: ServerEvent) {
    hub.broadcast(e);
  }

  /** Resolve a pending approval from any channel (HTTP or Telegram). */
  function resolveNotification(id: string, choice: string) {
    const notification = repo.respondToNotification(db, id, choice);
    if (!notification) return null;
    engine.resolveApproval(id, choice);
    repo.createAuditEntry(db, {
      projectId: notification.projectId,
      taskId: notification.taskId,
      kind: "approval_resolved",
      actor: "human",
      summary: `${notification.title} → ${choice}`,
    });
    broadcast({ type: "notification", payload: notification });
    return notification;
  }

  /** Record + broadcast planner spend so it counts against the project budget. */
  function recordPlanningCost(projectId: string, costUsd: number) {
    if (costUsd <= 0) return;
    const cost = repo.createCost(db, {
      projectId,
      model: "claude",
      costUsd,
      tokensIn: 0,
      tokensOut: 0,
      ts: new Date().toISOString(),
    });
    broadcast({ type: "cost.updated", payload: cost });
  }

  // ── Telegram (optional second channel) ──
  let telegram: TelegramBot | undefined;

  async function telegramCommand(cmd: string, args: string[]): Promise<string> {
    switch (cmd) {
      case "help":
        return [
          "Commands:",
          "/status — projects + task counts",
          "/cost — spend this month",
          "/projects — list project ids",
          "/start <projectId>",
          "/pause <projectId>",
        ].join("\n");
      case "projects": {
        const ps = repo.getProjects(db);
        return ps.length
          ? ps.map((p) => `${p.name} [${p.status}] — ${p.id}`).join("\n")
          : "No projects.";
      }
      case "status": {
        const ps = repo.getProjects(db);
        if (!ps.length) return "No projects.";
        return ps
          .map((p) => {
            const ts = repo.getTasks(db, p.id);
            const done = ts.filter((t) => t.status === "done").length;
            const failed = ts.filter((t) => t.status === "failed").length;
            return `${p.name} [${p.status}] ${done}/${ts.length} done${failed ? `, ${failed} failed` : ""}`;
          })
          .join("\n");
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
        const id = args[0];
        if (!id) return `Usage: /${cmd} <projectId>`;
        const project = repo.getProject(db, id);
        if (!project) return `No project ${id}`;
        if (cmd === "start") {
          repo.updateProject(db, id, { status: "running" });
          const running = repo.getProject(db, id)!;
          broadcast({ type: "project.updated", payload: running });
          await engine.start(running);
          return `Started ${project.name}`;
        }
        await engine.pause(project);
        repo.updateProject(db, id, { status: "paused" });
        broadcast({ type: "project.updated", payload: repo.getProject(db, id)! });
        return `Paused ${project.name}`;
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
    if (!tg?.enabled) return;
    const tokenVar = tg.botTokenRef ?? "TELEGRAM_BOT_TOKEN";
    // Raw token (stored in settings) wins; otherwise read the named env var.
    const token = tg.botToken || process.env[tokenVar];
    if (!token) {
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
          resolveNotification(id, choice);
        },
        onCommand: telegramCommand,
      },
      (m) => app.log.info(m),
    );
    telegram.start();
    engine.setNotifier(telegram);
  }

  configureTelegram(); // start the bot at boot if enabled

  // ── Health ──
  app.get("/api/health", async () => ({ ok: true, mock: ENV.mock }));

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
    };
    if (!body.name) {
      return reply.code(400).send({ error: "name is required" });
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
    }

    const settings = repo.getSettings(db) ?? defaultSettings();
    const baseDir = expandHome(settings.defaultProjectsDir || ENV.reposDir);
    const localPath = body.localPath?.trim()
      ? expandHome(body.localPath.trim())
      : uniqueLocalPath(baseDir, body.name);

    const id = crypto.randomUUID();
    const project = repo.createProject(db, {
      id,
      name: body.name,
      repoUrl,
      defaultBranch: body.defaultBranch ?? "main",
      localPath,
      budgetUsd: body.budgetUsd,
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
    };
    const updates: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) updates.name = body.name.trim();
    if (typeof body.defaultBranch === "string" && body.defaultBranch.trim()) {
      updates.defaultBranch = body.defaultBranch.trim();
    }
    // null clears the cap; a number sets it; undefined leaves it unchanged.
    if (body.budgetUsd === null) updates.budgetUsd = undefined;
    else if (typeof body.budgetUsd === "number" && body.budgetUsd >= 0) {
      updates.budgetUsd = body.budgetUsd;
    }

    const updated = repo.updateProject(db, id, updates as Parameters<typeof repo.updateProject>[2]);
    if (updated) broadcast({ type: "project.updated", payload: updated });
    return { project: updated };
  });

  app.delete("/api/projects/:id", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    if (engine.isRunning(id)) {
      return reply
        .code(409)
        .send({ error: "project is running — pause it before deleting" });
    }

    // Best-effort cleanup of the local clone + any leftover task worktrees
    // (`${localPath}-wt-<taskId>`). The DB delete below is the source of
    // truth; a failure here just leaves orphaned files on disk.
    try {
      if (existsSync(project.localPath)) {
        rmSync(project.localPath, { recursive: true, force: true });
      }
      const parent = dirname(project.localPath);
      const base = project.localPath.slice(parent.length + 1);
      if (existsSync(parent)) {
        for (const entry of readdirSync(parent)) {
          if (entry.startsWith(`${base}-wt-`)) {
            rmSync(join(parent, entry), { recursive: true, force: true });
          }
        }
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

    const body = req.body as { goal?: string; requireApproval?: boolean } | undefined;

    repo.updateProject(db, id, { status: "planning" });
    const goal = body?.goal ?? "";
    const settings = repo.getSettings(db) ?? defaultSettings();

    let prdMarkdown: string;
    const createdTasks: Task[] = [];

    try {
      // Real planner: Claude turns the goal into a PRD + dependency-ordered DAG.
      const cwd = await resolvePlannerCwd(project);
      const plan = await runPlanner(goal, project.name, cwd, ENV.plannerDeconstructModel);
      prdMarkdown = plan.prdMarkdown;
      // No review step on this single-shot path, so inject the standing docs
      // task here directly rather than relying on the Plan tab to add it.
      const tasksWithDocs = ensureDocsTask(plan.tasks, buildDocsTaskDraft(settings));
      createdTasks.push(...materializeTasks(db, id, tasksWithDocs, settings));
    } catch (err) {
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
        maxAttempts: 3,
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
        maxAttempts: 3,
      });
      createdTasks.push(t1, t2);
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

  // ── Planning: chat (Sonnet) → deconstruct (Opus) → commit ──

  // One conversational turn. The web chat panel sends the full transcript.
  app.post("/api/projects/:id/plan/chat", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const body = req.body as { messages?: PlanChatMessage[] } | undefined;
    const messages = body?.messages ?? [];
    if (messages.length === 0) {
      return reply.code(400).send({ error: "messages required" });
    }

    try {
      const cwd = await resolvePlannerCwd(project);
      const { reply: text, costUsd } = await runPlannerChat(
        messages,
        project.name,
        cwd,
        ENV.plannerChatModel,
      );
      recordPlanningCost(id, costUsd);
      // Persist the full conversation (including assistant reply) so the Plan
      // tab can restore it on reload or after a tab switch.
      repo.savePlanningSession(db, id, {
        messages: [...messages, { role: "assistant", content: text }],
      });
      return { reply: text, costUsd };
    } catch (err) {
      return reply.code(502).send({
        error: `planner chat failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // Deconstruct the agreed conversation into a draft task DAG (NOT yet persisted as tasks).
  app.post("/api/projects/:id/plan/deconstruct", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const body = req.body as { messages?: PlanChatMessage[] } | undefined;
    const messages = body?.messages ?? [];
    if (messages.length === 0) {
      return reply.code(400).send({ error: "messages required" });
    }

    try {
      const cwd = await resolvePlannerCwd(project);
      const { output, costUsd } = await runPlannerDeconstruct(
        messages,
        project.name,
        cwd,
        ENV.plannerDeconstructModel,
      );
      recordPlanningCost(id, costUsd);
      const settings = repo.getSettings(db) ?? defaultSettings();
      const tasks = withAssignedModels(output, settings);
      // Persist draft tasks + PRD so the Plan tab can restore them on reload.
      repo.savePlanningSession(db, id, {
        messages,
        prd: output.prdMarkdown,
        draftTasks: tasks,
      });
      return { prdMarkdown: output.prdMarkdown, tasks, costUsd };
    } catch (err) {
      return reply.code(502).send({
        error: `deconstruction failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  // Save the user's in-progress edits to the draft task table without committing.
  app.post("/api/projects/:id/plan/save-draft", async (req, reply) => {
    const { id } = req.params as RouteParams;
    if (!repo.getProject(db, id)) return reply.code(404).send({ error: "project not found" });
    const body = req.body as { prdMarkdown?: string; tasks?: DraftTask[] };
    repo.savePlanningSession(db, id, {
      prd: body.prdMarkdown,
      draftTasks: body.tasks ?? null,
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
        "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM costs WHERE project_id = ? AND task_id IS NULL",
      ).get(id) as { total: number }
    ).total;
    return { ...session, planCostUsd };
  });

  // Commit the (user-edited) draft tasks into real Task rows.
  app.post("/api/projects/:id/plan/commit", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const body = req.body as { prdMarkdown?: string; tasks?: DraftTask[] };
    if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
      return reply.code(400).send({ error: "tasks required" });
    }

    repo.updateProject(db, id, { status: "planning" });
    const settings = repo.getSettings(db) ?? defaultSettings();
    const created = materializeTasks(db, id, body.tasks, settings);
    repo.updateProject(db, id, { status: "planned" });
    // Clear the draft table (tasks are now real); keep the conversation for history.
    repo.savePlanningSession(db, id, { prd: null, draftTasks: null });

    broadcast({ type: "project.updated", payload: repo.getProject(db, id)! });
    for (const t of created) broadcast({ type: "task.updated", payload: t });

    return {
      project: repo.getProject(db, id)!,
      tasks: repo.getTasks(db, id),
      prdMarkdown: body.prdMarkdown ?? `# ${project.name}\n`,
    };
  });

  app.post("/api/projects/:id/start", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    repo.updateProject(db, id, { status: "running" });
    const running = repo.getProject(db, id)!;
    broadcast({ type: "project.updated", payload: running });

    // Run the whole DAG autonomously in the background.
    await engine.start(running);
    return { project: running };
  });

  app.post("/api/projects/:id/pause", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    await engine.pause(project);
    repo.updateProject(db, id, { status: "paused" });
    broadcast({ type: "project.updated", payload: repo.getProject(db, id)! });
    return { project: repo.getProject(db, id)! };
  });

  // ── Tasks ──
  app.get("/api/projects/:id/tasks", async (req) => {
    const { id } = req.params as RouteParams;
    return { tasks: repo.getTasks(db, id) };
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

    // A task that's actively executing already captured its model/scope for
    // this run (the fallback chain and worktree are built from them at
    // dispatch time) — changing them now wouldn't be picked up until the next
    // attempt at best, and would be confusing mid-flight. Reassignment is only
    // meaningful while the task is still waiting to be dispatched.
    if (
      existing.status === "in_progress" &&
      (body.assignedModel || body.scopePaths)
    ) {
      return reply.code(409).send({
        error: "task is in_progress — pause it or wait for this attempt to finish before reassigning model/scope",
      });
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

    // dispatchOne spins up its own Orchestrator instance with empty
    // activeTaskIds/modelActiveCount, sharing none of the autonomous run's
    // in-flight state. Running both at once would let a manually-dispatched
    // task bypass scope-overlap serialization and per-model concurrency caps
    // the autonomous loop is enforcing — pause it first.
    if (engine.isRunning(task.projectId)) {
      return reply.code(409).send({
        error: "project is running autonomously — pause it before dispatching a task manually",
      });
    }

    const settings = repo.getSettings(db);
    if (!settings) return reply.code(500).send({ error: "settings not found" });

    // Budget check
    const budgetMsg = checkBudget(db, task.projectId, task.assignedModel, settings);
    if (budgetMsg) {
      return reply.code(403).send({ error: `budget cap: ${budgetMsg}` });
    }

    // Don't persist a run row here — the engine creates the authoritative one
    // (id `run-<taskId>-<attempt>`) via SchedulerDeps.events.onRunUpdated as
    // soon as it starts the author, and that's what gets cost/status updates.
    // A pre-created row here would just be a second, never-updated orphan.
    const now = new Date().toISOString();
    const placeholderRun: import("@orc/types").Run = {
      id: `run-${task.id}-${task.attempts + 1}`,
      taskId: task.id,
      model: task.assignedModel,
      attempt: task.attempts + 1,
      status: "running",
      startedAt: now,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    };

    repo.updateTask(db, id, {
      status: "in_progress",
      attempts: task.attempts + 1,
    });

    const updatedTask = repo.getTask(db, id)!;
    broadcast({ type: "task.updated", payload: updatedTask });

    // Execute this single task through the engine in the background.
    const project = repo.getProject(db, task.projectId)!;
    void engine.dispatchOne(project, task.id);

    return { run: placeholderRun, task: updatedTask };
  });

  app.post("/api/tasks/:id/stop", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const task = repo.getTask(db, id);
    if (!task) return reply.code(404).send({ error: "task not found" });

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

    repo.updateTask(db, id, { status: "blocked" });
    const updatedTask = repo.getTask(db, id)!;
    broadcast({ type: "task.updated", payload: updatedTask });

    return { task: updatedTask };
  });

  // Revert a task's merged PR (one-click rollback).
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
      await engine.rollback(project, task.prNumber);
    } catch (err) {
      return reply.code(502).send({
        error: `rollback failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    repo.updateTask(db, id, { status: "blocked" });
    repo.createAuditEntry(db, {
      projectId: project.id,
      taskId: id,
      kind: "rollback",
      actor: "human",
      summary: `Reverted PR #${task.prNumber} for "${task.title}"`,
      detail: { prNumber: task.prNumber },
    });
    const updated = repo.getTask(db, id)!;
    broadcast({ type: "task.updated", payload: updated });
    return { task: updated };
  });

  // Retry a failed/blocked task from scratch (resets attempts, re-dispatches).
  app.post("/api/tasks/:id/retry", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const task = repo.getTask(db, id);
    if (!task) return reply.code(404).send({ error: "task not found" });

    const retryable = ["failed", "changes_requested", "blocked"];
    if (!retryable.includes(task.status)) {
      return reply
        .code(409)
        .send({ error: `task is ${task.status}; only ${retryable.join("/")} can be retried` });
    }

    // Same reasoning as /dispatch: a manual retry spins up an independent
    // Orchestrator that shares no in-flight state with an active autonomous
    // run on this project.
    if (engine.isRunning(task.projectId)) {
      return reply.code(409).send({
        error: "project is running autonomously — pause it before retrying a task manually",
      });
    }

    const settings = repo.getSettings(db);
    if (!settings) return reply.code(500).send({ error: "settings not found" });

    const budgetMsg = checkBudget(db, task.projectId, task.assignedModel, settings);
    if (budgetMsg) return reply.code(403).send({ error: `budget cap: ${budgetMsg}` });

    // Fresh attempt counter, then dispatch one run through the engine. As with
    // /dispatch, the engine creates the authoritative run row itself — don't
    // pre-create one here (was leaving a permanently-"running" $0 orphan row).
    // Also clear prNumber/branch/worktreePath: a prior failed attempt may
    // have already pushed to and opened a PR on `orc/<taskId>`. Without this,
    // the new attempt's worktree (freshly branched off origin/<default>)
    // can't push to that same branch name — its remote ref has diverged —
    // and the push is rejected as non-fast-forward, failing every retry
    // regardless of which model runs it.
    repo.updateTask(
      db,
      id,
      {
        status: "in_progress",
        attempts: 1,
        prNumber: null,
        branch: null,
        worktreePath: null,
      } as Record<string, unknown> as Parameters<typeof repo.updateTask>[2],
    );
    const now = new Date().toISOString();
    const placeholderRun: import("@orc/types").Run = {
      id: `run-${id}-1`,
      taskId: id,
      model: task.assignedModel,
      attempt: 1,
      status: "running",
      startedAt: now,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
    const updatedTask = repo.getTask(db, id)!;
    repo.createAuditEntry(db, {
      projectId: task.projectId,
      taskId: id,
      kind: "retry",
      actor: "human",
      summary: `Retried "${task.title}"`,
    });
    broadcast({ type: "task.updated", payload: updatedTask });

    const project = repo.getProject(db, task.projectId)!;
    void engine.dispatchOne(project, id);
    return { run: placeholderRun, task: updatedTask };
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

  app.get("/api/runs/:id/logs", async (req) => {
    const { id } = req.params as RouteParams;
    return { logs: repo.getLogs(db, id) };
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
    return { settings };
  });

  app.put("/api/settings", async (req, reply) => {
    const body = req.body as { settings?: Partial<import("@orc/types").Settings> };
    if (!body.settings) return reply.code(400).send({ error: "settings body required" });

    const current = repo.getSettings(db) ?? defaultSettings();
    const merged: import("@orc/types").Settings = {
      ...current,
      ...body.settings,
      routing: body.settings.routing ?? current.routing,
      models: body.settings.models ?? current.models,
      riskyChangeRules: body.settings.riskyChangeRules ?? current.riskyChangeRules,
    };

    // The same model can't author AND validate a difficulty tier — the
    // validator throws "self-review forbidden" the moment a task of that
    // difficulty (with no role override) reaches review, permanently failing
    // it. Catch this at save time instead of letting it crash tasks later.
    const collisions = (["easy", "medium", "hard"] as const).filter(
      (d) =>
        merged.routing.byDifficulty[d] === merged.routing.validatorByDifficulty[d],
    );
    if (collisions.length > 0) {
      return reply.code(400).send({
        error:
          `byDifficulty and validatorByDifficulty assign the same model for: ${collisions.join(", ")}. ` +
          `Choose a different validator for ${collisions.length === 1 ? "that tier" : "those tiers"}.`,
      });
    }

    const saved = repo.upsertSettings(db, merged);
    configureTelegram(); // apply enable/disable/token/chatId changes live
    return { settings: saved };
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

    const notification = resolveNotification(id, body.choice);
    if (!notification) return reply.code(404).send({ error: "notification not found" });

    return { notification };
  });

  // ── Audit log ──
  app.get("/api/projects/:id/audit", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    return { entries: repo.getAuditLog(db, id) };
  });

  // ── Setup / health check ──
  app.get("/api/setup", async () => {
    return runSetupChecks();
  });

  // Live-test every enabled model with a trivial prompt (costs a little).
  app.post("/api/setup/test-models", async () => {
    const settings = repo.getSettings(db) ?? defaultSettings();
    return testModels(settings, ENV.opencodeBaseUrl);
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

  // Survive stray async errors instead of letting an unattended run die. A
  // single rejected promise or thrown callback deep in a background task
  // pipeline should be logged, not take the whole server (and every other
  // in-flight project) down with it. Orphan recovery handles anything that
  // was genuinely mid-flight on the next start.
  process.on("unhandledRejection", (reason) => {
    app.log.error(
      `unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`,
    );
  });
  process.on("uncaughtException", (err) => {
    app.log.error(`uncaughtException: ${err.stack ?? err.message}`);
  });

  await app.listen({ port: ENV.port, host: "0.0.0.0" });
  app.log.info(`hoopedorc server up on :${ENV.port} (mock=${ENV.mock})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
