import type { FastifyInstance } from "fastify";
import type { Db } from "./db/index";
import { RoutingEvaluationError } from "./routing-evaluation-policy";
import { RoutingEvaluationStore } from "./routing-evaluation-store";

export function registerRoutingEvaluationRoutes(app: FastifyInstance, db: Db) {
  const store = new RoutingEvaluationStore(db);
  app.get("/api/routing/evaluations", () => Promise.resolve({ evaluations: store.list() }));
  app.get<{ Params: { id: string } }>("/api/routing/evaluations/:id", (req, reply) => {
    try { return reply.send({ evaluation: store.get(req.params.id) }); }
    catch (error) { if (!(error instanceof RoutingEvaluationError)) throw error; return reply.code(error.status).send({ error: error.message }); }
  });
  app.post("/api/routing/evaluations", { bodyLimit: 550_000 }, (req, reply) => {
    try { return reply.send({ evaluation: store.evaluate(req.body) }); }
    catch (error) { if (!(error instanceof RoutingEvaluationError)) throw error; return reply.code(error.status).send({ error: error.message }); }
  });
}
