import type { FastifyInstance } from "fastify";
import type { Project, SetPreviewProfileRequest, WorkspacePreviewResponse } from "@orc/types";
import type { Db } from "./db/index";
import * as repo from "./db/repo";
import { pendingPlanChange } from "./plan-changes";
import { parsePreviewProfile } from "./preview-policy";
import { PreviewError, type PreviewManager } from "./previews";

export function registerPreviewRoutes(app: FastifyInstance, db: Db, previews: PreviewManager, mock: boolean, onProjectUpdate?: (project: Project) => void): void {
  function context(projectId: string, workspaceId: string): WorkspacePreviewResponse {
    const project = repo.getProject(db, projectId);
    if (!project) throw new PreviewError("Project not found.", 404);
    const task = workspaceId === "primary" ? null : repo.getTask(db, workspaceId);
    if (workspaceId !== "primary" && (!task || task.projectId !== projectId)) throw new PreviewError("Workspace not found for this project.", 404);
    const reason = !task ? "Choose a task workspace to preview. The primary clone remains read-only."
      : repo.getSettings(db)?.sandboxGates === "required" ? "Sandboxing is required. Native host previews are unavailable."
      : !mock && (!task.worktreePath || !task.branch) ? "This task has no previewable workspace yet. Start it through the board first." : undefined;
    return { preview: task ? previews.latest(projectId, task.id) : null, profile: project.config?.preview ?? null,
      projectUpdatedAt: project.updatedAt, available: !reason, reason };
  }
  app.put("/api/projects/:id/preview-profile", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "Project not found." });
    const body = req.body as SetPreviewProfileRequest | undefined;
    if (!body || typeof body.projectUpdatedAt !== "string") return reply.code(400).send({ error: "A versioned preview profile is required." });
    if (body.projectUpdatedAt !== project.updatedAt || pendingPlanChange(db, id)) return reply.code(409).send({ error: "Project settings changed or a plan application is pending. Refresh and review the preview profile before saving." });
    const parsed = body.profile === null ? null : parsePreviewProfile(body.profile);
    if (parsed && "error" in parsed) return reply.code(400).send({ error: parsed.error });
    const updated = repo.updateProject(db, id, { config: { ...project.config, preview: parsed?.value } });
    if (updated) onProjectUpdate?.(updated);
    return context(id, "primary");
  });
  app.get("/api/projects/:id/workspaces/:workspaceId/preview", async (req, reply) => {
    const { id, workspaceId } = req.params as { id: string; workspaceId: string };
    try { return context(id, workspaceId); }
    catch (error) { return reply.code(error instanceof PreviewError ? error.status : 500).send({ error: error instanceof Error ? error.message : "Preview unavailable." }); }
  });
  for (const action of ["start", "stop", "open"] as const) {
    app.post(`/api/projects/:id/workspaces/:workspaceId/preview/${action}`, async (req, reply) => {
      const { id, workspaceId } = req.params as { id: string; workspaceId: string };
      try {
        const current = context(id, workspaceId);
        if (workspaceId === "primary") throw new PreviewError(current.reason ?? "Choose a task workspace.");
        if (action === "start") {
          if (!current.available) throw new PreviewError(current.reason ?? "Preview is unavailable.");
          const body = req.body as Record<string, unknown> | undefined;
          if (!body || typeof body.projectUpdatedAt !== "string" || Object.keys(body).some((key) => key !== "projectUpdatedAt")) throw new PreviewError("Preview launch accepts only the reviewed project version, never commands or URLs.", 400);
          if (body.projectUpdatedAt !== current.projectUpdatedAt || pendingPlanChange(db, id)) throw new PreviewError("Project settings changed or a plan application is pending. Refresh and review before starting.");
          if (!current.profile) throw new PreviewError("Configure and save a preview command first.", 400);
          previews.start(repo.getProject(db, id)!, repo.getTask(db, workspaceId)!, current.profile);
          return reply.code(202).send(context(id, workspaceId));
        }
        if (action === "stop") { await previews.stop(id, workspaceId); return context(id, workspaceId); }
        const origin = typeof req.headers.origin === "string" ? req.headers.origin : `${req.protocol}://${req.headers.host}`;
        return previews.open(id, workspaceId, origin);
      } catch (error) {
        return reply.code(error instanceof PreviewError ? error.status : 409).send({ error: error instanceof Error ? error.message : "Preview operation failed.", code: "PREVIEW_REFUSED" });
      }
    });
  }
}
