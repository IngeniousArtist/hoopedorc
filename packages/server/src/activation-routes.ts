import type { FastifyInstance } from "fastify";
import type { Db } from "./db/index";
import * as repo from "./db/repo";
import { LibraryError } from "./library";
import { ActivationStore, parseActivationSave } from "./activation-store";

export function registerActivationRoutes(app: FastifyInstance, db: Db) {
  const store = new ActivationStore(db);
  for (const method of ["get", "put"] as const) app[method]("/api/projects/:id/activation", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!repo.getProject(db, id)) return reply.code(404).send({ error: "Project not found." });
    try { return method === "get" ? store.response(id) : { revision: store.save(id, parseActivationSave(req.body)) }; }
    catch (error) { return reply.code(error instanceof LibraryError ? error.status : 500).send({ error: error instanceof LibraryError ? error.message : "Activation could not be saved or loaded. Existing revisions are preserved.", code: "ACTIVATION_REFUSED" }); }
  });
}
