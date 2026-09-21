import type { FastifyInstance } from "fastify";
import type { Db } from "./db/index";
import * as repo from "./db/repo";
import { LibraryError, LibraryStore, parseLibrarySave, parseLibrarySelection } from "./library";
import { importProjectLibrary } from "./library-import";

export function registerLibraryRoutes(app: FastifyInstance, db: Db, mock: boolean): void {
  const store = new LibraryStore(db);
  const owner = (id: string) => { const project = repo.getProject(db, id); if (!project) throw new LibraryError("Project not found.", 404); return project; };
  const failure = (error: unknown) => ({ error: error instanceof LibraryError ? error.message : "Library could not be saved or read. Existing sources and drafts are preserved.", code: "LIBRARY_REFUSED" });
  app.get("/api/projects/:id/library", async (req, reply) => {
    const { id } = req.params as { id: string };
    try { owner(id); return { entries: store.list(id) }; } catch (error) { return reply.code(error instanceof LibraryError ? error.status : 500).send(failure(error)); }
  });
  app.get("/api/projects/:id/library/:referenceId", async (req, reply) => {
    const { id, referenceId } = req.params as { id: string; referenceId: string };
    try { owner(id); return store.detail(id, referenceId); } catch (error) { return reply.code(error instanceof LibraryError ? error.status : 500).send(failure(error)); }
  });
  app.put("/api/projects/:id/library/:referenceId", async (req, reply) => {
    const { id, referenceId } = req.params as { id: string; referenceId: string };
    try { owner(id); return { reference: store.save(id, referenceId, parseLibrarySave(req.body)) }; } catch (error) { return reply.code(error instanceof LibraryError ? error.status : 500).send(failure(error)); }
  });
  app.post("/api/projects/:id/library/import", async (req, reply) => {
    const { id } = req.params as { id: string };
    try { return await importProjectLibrary(db, owner(id), mock); } catch (error) { return reply.code(error instanceof LibraryError ? error.status : 500).send(failure(error)); }
  });
  app.post("/api/projects/:id/library/handoff", async (req, reply) => {
    const { id } = req.params as { id: string };
    try { owner(id); return { markdown: store.handoff(id, parseLibrarySelection(req.body)) }; } catch (error) { return reply.code(error instanceof LibraryError ? error.status : 500).send(failure(error)); }
  });
}
