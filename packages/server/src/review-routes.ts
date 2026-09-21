import type { FastifyInstance } from "fastify";
import type { Db } from "./db/index";
import * as repo from "./db/repo";
import { parseCaptureRequest, parseUploadRequest, ReviewError } from "./review-policy";
import type { ReviewManager } from "./reviews";

export function registerReviewRoutes(app: FastifyInstance, db: Db, reviews: ReviewManager): void {
  const owner = (id: string, taskId: string) => {
    const project = repo.getProject(db, id); const task = repo.getTask(db, taskId);
    if (!project || !task || task.projectId !== id) throw new ReviewError("Task not found for this project.", 404);
    return { project, task };
  };
  const failure = (error: unknown) => ({ error: error instanceof Error ? error.message : "Review unavailable.", code: "REVIEW_REFUSED" });
  app.get("/api/projects/:id/tasks/:taskId/review", async (req, reply) => {
    const { id, taskId } = req.params as { id: string; taskId: string };
    try { const { project, task } = owner(id, taskId); return await reviews.context(project, task); }
    catch (error) { return reply.code(error instanceof ReviewError ? error.status : 500).send(failure(error)); }
  });
  app.post("/api/projects/:id/tasks/:taskId/review/capture", async (req, reply) => {
    const { id, taskId } = req.params as { id: string; taskId: string };
    try {
      const { project, task } = owner(id, taskId);
      const evidence = await reviews.capture(project, task, parseCaptureRequest(req.body));
      return reply.code(evidence.state === "running" ? 202 : 200).send({ evidence });
    } catch (error) { return reply.code(error instanceof ReviewError ? error.status : 409).send(failure(error)); }
  });
  app.post("/api/projects/:id/tasks/:taskId/review/evidence", { bodyLimit: 30 * 1024 * 1024 }, async (req, reply) => {
    const { id, taskId } = req.params as { id: string; taskId: string };
    try {
      const { project, task } = owner(id, taskId); const { request, bytes } = parseUploadRequest(req.body);
      return { evidence: await reviews.upload(project, task, request, bytes) };
    } catch (error) { return reply.code(error instanceof ReviewError ? error.status : 409).send(failure(error)); }
  });
  app.post("/api/projects/:id/tasks/:taskId/review/evidence/:evidenceId/cancel", async (req, reply) => {
    const { id, taskId, evidenceId } = req.params as { id: string; taskId: string; evidenceId: string };
    try { owner(id, taskId); return { evidence: await reviews.cancel(id, taskId, evidenceId) }; }
    catch (error) { return reply.code(error instanceof ReviewError ? error.status : 409).send(failure(error)); }
  });
  app.get("/api/projects/:id/tasks/:taskId/review/artifacts/:artifactId", async (req, reply) => {
    const { id, taskId, artifactId } = req.params as { id: string; taskId: string; artifactId: string };
    try {
      owner(id, taskId); const { artifact, bytes } = reviews.store.artifact(id, taskId, artifactId);
      return reply.header("Content-Type", artifact.mime).header("Content-Disposition", `attachment; filename="${artifact.name}"`)
        .header("X-Content-Type-Options", "nosniff").header("Content-Security-Policy", "sandbox; default-src 'none'").header("Cache-Control", "no-store").send(bytes);
    } catch (error) { return reply.code(error instanceof ReviewError ? error.status : 409).send(failure(error)); }
  });
}
