import type { FastifyInstance } from "fastify";
import { ResourceUnavailableError, type RecoverResourceRequest } from "@orc/types";
import type { ResourceManager } from "./resources";

export function registerResourceRoutes(app: FastifyInstance, resources: ResourceManager) {
  app.get("/api/resources", () => Promise.resolve(resources.response()));
  app.post("/api/resources/:reservationId/recover", async (req, reply) => {
    const { reservationId } = req.params as { reservationId: string };
    try { return { reservation: resources.recover(reservationId, req.body as RecoverResourceRequest) }; }
    catch (error) { return reply.code(error instanceof ResourceUnavailableError ? 409 : 500).send({ error: error instanceof ResourceUnavailableError ? error.message : "Resource recovery could not be persisted. Capacity remains protected." }); }
  });
}
