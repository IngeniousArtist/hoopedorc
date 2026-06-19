import "dotenv/config";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { ServerEvent } from "@orc/types";
import { WS_PATH } from "@orc/types";
import { ENV, defaultSettings } from "./config";
import { seed } from "./mock";

// Round 0 server. In MOCK mode it serves seed data + a synthetic log stream so
// the web app (GLM) can be built immediately. Real endpoints are stubbed with
// 501 for deepseek-flash to implement (persistence) and the Round 2 wiring to
// the engine (deepseek-pro).  OWNER: deepseek-flash.

const NOT_IMPLEMENTED = {
  statusCode: 501,
  error: "Not Implemented",
  message: "stub — see docs/specs/deepseek-flash-server-adapters.md",
};

async function main() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const data = {
    ...(ENV.mock
      ? seed()
      : { projects: [], tasks: [], settings: defaultSettings() }),
  };

  // ---- read endpoints (work in mock mode) ----
  app.get("/api/health", async () => ({ ok: true, mock: ENV.mock }));

  app.get("/api/projects", async () => ({ projects: data.projects }));

  app.get("/api/projects/:id", async (req) => {
    const { id } = req.params as { id: string };
    return { project: data.projects.find((p) => p.id === id) ?? null };
  });

  app.get("/api/projects/:id/tasks", async (req) => {
    const { id } = req.params as { id: string };
    return { tasks: data.tasks.filter((t) => t.projectId === id) };
  });

  app.get("/api/settings", async () => ({ settings: data.settings }));

  // ---- write / action endpoints (to implement) ----
  for (const route of [
    "/api/projects",
    "/api/projects/:id/plan",
    "/api/projects/:id/start",
    "/api/projects/:id/pause",
    "/api/tasks/:id/dispatch",
    "/api/tasks/:id/stop",
    "/api/notifications/:id/respond",
  ]) {
    app.post(route, async (_req, reply) => reply.code(501).send(NOT_IMPLEMENTED));
  }
  app.patch("/api/tasks/:id", async (_req, reply) =>
    reply.code(501).send(NOT_IMPLEMENTED),
  );
  app.put("/api/settings", async (_req, reply) =>
    reply.code(501).send(NOT_IMPLEMENTED),
  );

  // ---- realtime (WebSocket) ----
  app.get(WS_PATH, { websocket: true }, (socket) => {
    const send = (e: ServerEvent) => socket.send(JSON.stringify(e));
    if (data.projects[0]) send({ type: "project.updated", payload: data.projects[0] });

    if (ENV.mock) {
      const task = data.tasks[0];
      const timer = setInterval(() => {
        if (!task) return;
        send({
          type: "log",
          payload: {
            id: crypto.randomUUID(),
            runId: "run-mock",
            taskId: task.id,
            ts: new Date().toISOString(),
            level: "info",
            source: "agent",
            message: `mock log @ ${new Date().toLocaleTimeString()}`,
          },
        });
      }, 2000);
      socket.on("close", () => clearInterval(timer));
    }
  });

  await app.listen({ port: ENV.port, host: "0.0.0.0" });
  app.log.info(`hoopedorc server up on :${ENV.port} (mock=${ENV.mock})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
