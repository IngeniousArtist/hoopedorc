import "dotenv/config";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { ServerEvent } from "@orc/types";
import { WS_PATH } from "@orc/types";
import { ENV, defaultSettings } from "./config";
import { seed } from "./mock";
import type { Db } from "./db/index";
import { initDb, openDb } from "./db/index";
import * as repo from "./db/repo";
import { WsHub } from "./ws-hub";

type RouteParams = { id: string };

function setupDb(): Db {
  if (ENV.mock) {
    const db = openDb(":memory:");
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

async function main() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const db = setupDb();
  const hub = new WsHub();

  // ensure settings exist
  if (!repo.getSettings(db)) {
    repo.upsertSettings(db, defaultSettings());
  }

  function broadcast(e: ServerEvent) {
    hub.broadcast(e);
  }

  // ── Health ──
  app.get("/api/health", async () => ({ ok: true, mock: ENV.mock }));

  // ── Projects ──
  app.post("/api/projects", async (req, reply) => {
    const body = req.body as {
      name: string;
      repoUrl?: string;
      defaultBranch?: string;
      budgetUsd?: number;
    };
    if (!body.name) {
      return reply.code(400).send({ error: "name is required" });
    }
    const project = repo.createProject(db, {
      id: crypto.randomUUID(),
      name: body.name,
      repoUrl: body.repoUrl ?? "https://github.com/placeholder/repo",
      defaultBranch: body.defaultBranch ?? "main",
      localPath: ".",
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

  app.post("/api/projects/:id/plan", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const body = req.body as { goal?: string; requireApproval?: boolean } | undefined;

    repo.updateProject(db, id, { status: "planning" });

    // Stub planner — returns a pre-generated task DAG
    const stubTasks = [
      repo.createTask(db, {
        id: crypto.randomUUID(),
        projectId: id,
        title: "Initial setup & scaffolding",
        description: body?.goal ?? "Set up the project structure",
        difficulty: "easy",
        status: "ready",
        dependsOn: [],
        acceptanceCriteria: ["Project builds", "Tests pass"],
        assignedModel: "deepseek-flash",
        scopePaths: ["**/*"],
        attempts: 0,
        maxAttempts: 3,
      }),
      repo.createTask(db, {
        id: crypto.randomUUID(),
        projectId: id,
        title: "Core implementation",
        description: "Implement the main feature logic",
        difficulty: "medium",
        status: "backlog",
        dependsOn: [],
        acceptanceCriteria: ["Feature works end-to-end"],
        assignedModel: "deepseek-flash",
        scopePaths: ["**/*"],
        attempts: 0,
        maxAttempts: 3,
      }),
    ];

    // Wire dependsOn for the second task
    repo.updateTask(db, stubTasks[1]!.id, { dependsOn: [stubTasks[0]!.id] });

    repo.updateProject(db, id, { status: "planned" });
    broadcast({ type: "project.updated", payload: repo.getProject(db, id)! });
    for (const t of stubTasks) {
      broadcast({ type: "task.updated", payload: repo.getTask(db, t.id)! });
    }

    return {
      project: repo.getProject(db, id)!,
      tasks: repo.getTasks(db, id),
      prdMarkdown: `# PRD: ${project.name}\n\n${body?.goal ?? "No goal provided."}\n`,
    };
  });

  app.post("/api/projects/:id/start", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    repo.updateProject(db, id, { status: "running" });
    broadcast({ type: "project.updated", payload: repo.getProject(db, id)! });

    // Delegate to engine (stub for now — engine wiring is deepseek-pro's job)
    return { project: repo.getProject(db, id)! };
  });

  app.post("/api/projects/:id/pause", async (req, reply) => {
    const { id } = req.params as RouteParams;
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "project not found" });

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

    const updates: Record<string, unknown> = {};
    if (body.status) updates.status = body.status;
    if (body.assignedModel) updates.assignedModel = body.assignedModel;
    if (body.acceptanceCriteria) updates.acceptanceCriteria = body.acceptanceCriteria;
    if (body.scopePaths) updates.scopePaths = body.scopePaths;

    const updated = repo.updateTask(db, id, updates as Parameters<typeof repo.updateTask>[2]);
    if (updated) broadcast({ type: "task.updated", payload: updated });
    return { task: updated };
  });

  function checkBudget(
    projectId: string,
    model: string,
    settings: import("@orc/types").Settings,
  ): string | null {
    // Project budget check
    const project = repo.getProject(db, projectId);
    if (project?.budgetUsd) {
      const { totalUsd } = repo.getCostSummary(db, projectId);
      if (totalUsd >= project.budgetUsd) {
        return `Project budget $${project.budgetUsd} exceeded ($${totalUsd} used)`;
      }
    }

    // Model monthly budget check
    const modelCfg = settings.models.find((m) => m.id === model);
    if (modelCfg?.monthlyBudgetUsd) {
      const monthly = repo.getModelMonthlyCost(db, model);
      if (monthly >= modelCfg.monthlyBudgetUsd) {
        return `Model ${model} monthly budget $${modelCfg.monthlyBudgetUsd} exceeded ($${monthly} used)`;
      }
    }

    // Global monthly budget check
    if (settings.globalMonthlyBudgetUsd) {
      const allCosts = repo.getCostSummary(db, projectId);
      if (allCosts.totalUsd >= settings.globalMonthlyBudgetUsd) {
        return `Global monthly budget $${settings.globalMonthlyBudgetUsd} exceeded`;
      }
    }

    return null;
  }

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
    const budgetMsg = checkBudget(task.projectId, task.assignedModel, settings);
    if (budgetMsg) {
      return reply.code(403).send({ error: `budget cap: ${budgetMsg}` });
    }

    const now = new Date().toISOString();
    const run = repo.createRun(db, {
      taskId: task.id,
      model: task.assignedModel,
      attempt: task.attempts + 1,
      status: "running",
      startedAt: now,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    });

    repo.updateTask(db, id, {
      status: "in_progress",
      attempts: task.attempts + 1,
    });

    const updatedTask = repo.getTask(db, id)!;
    broadcast({ type: "run.updated", payload: run });
    broadcast({ type: "task.updated", payload: updatedTask });

    return { run, task: updatedTask };
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
    const saved = repo.upsertSettings(db, merged);
    return { settings: saved };
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

    const notification = repo.respondToNotification(db, id, body.choice);
    if (!notification) return reply.code(404).send({ error: "notification not found" });

    return { notification };
  });

  // ── Realtime (WebSocket) ──
  app.get(WS_PATH, { websocket: true }, (socket) => {
    hub.add(socket);

    // welcome with current state
    const projects = repo.getProjects(db);
    for (const p of projects) {
      socket.send(JSON.stringify({ type: "project.updated", payload: p }));
    }
    for (const p of projects) {
      const tasks = repo.getTasks(db, p.id);
      for (const t of tasks) {
        socket.send(JSON.stringify({ type: "task.updated", payload: t }));
        const runs = repo.getRuns(db, t.id);
        for (const r of runs) {
          socket.send(JSON.stringify({ type: "run.updated", payload: r }));
        }
      }
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

  await app.listen({ port: ENV.port, host: "0.0.0.0" });
  app.log.info(`hoopedorc server up on :${ENV.port} (mock=${ENV.mock})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
