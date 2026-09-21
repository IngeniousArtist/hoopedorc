import type { FastifyInstance } from "fastify";
import { ResourceUnavailableError } from "@orc/types";
import type { ExecutionService } from "./execution";
import * as repo from "./db/repo";

export function registerExecutionRoutes(app: FastifyInstance, execution: ExecutionService, mock: boolean) {
  app.get("/api/execution", () => Promise.resolve(execution.response()));
  app.post("/api/execution/profiles/:profileId/verify", async (req, reply) => {
    if (mock) return reply.code(409).send({ error: "Worker verification is unavailable in mock mode. No Docker commands were run." });
    const { profileId } = req.params as { profileId: string };
    const profile = repo.getSettings(execution.db)?.executionProfiles?.find((item) => item.id === profileId);
    if (!profile) return reply.code(404).send({ error: "Execution profile not found. Save settings first." });
    return execution.verify(profile);
  });
  app.post("/api/execution/workers/:workerId/stop", async (req, reply) => {
    if (mock) return reply.code(409).send({ error: "Worker recovery is unavailable in mock mode." });
    const { workerId } = req.params as { workerId: string };
    try { await execution.stop(workerId); return execution.response(); }
    catch (error) { return reply.code(409).send({ error: error instanceof ResourceUnavailableError ? error.message : "Worker cleanup failed. Refresh execution status before retrying." }); }
  });
}
