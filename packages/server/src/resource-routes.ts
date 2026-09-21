import type { FastifyInstance } from "fastify";
import { ResourceUnavailableError, type RecoverResourceRequest } from "@orc/types";
import type { ResourceManager } from "./resources";

export function registerResourceRoutes(app: FastifyInstance, resources: ResourceManager, stopInvocation?: (id: string) => Promise<void>) {
  app.get("/api/resources", () => Promise.resolve(resources.response()));
  app.post("/api/resources/:reservationId/recover", async (req, reply) => {
    const { reservationId } = req.params as { reservationId: string };
    try {
      const request = req.body as RecoverResourceRequest;
      const pending = resources.response().unresolved.find((item) => item.id === reservationId);
      if (pending) {
        if (!request || request.confirmWorkerStopped !== true || request.expectedUpdatedAt !== pending.updatedAt || typeof request.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(request.requestId) || Object.keys(request).some((key) => !["requestId", "expectedUpdatedAt", "confirmWorkerStopped"].includes(key))) throw new ResourceUnavailableError("Confirm the stopped worker using the current reservation version and UUID request ID.", false);
        await stopInvocation?.(reservationId);
      } return { reservation: resources.recover(reservationId, req.body as RecoverResourceRequest) }; }
    catch (error) { return reply.code(error instanceof ResourceUnavailableError ? 409 : 500).send({ error: error instanceof ResourceUnavailableError ? error.message : "Resource recovery could not be persisted. Capacity remains protected." }); }
  });
}
