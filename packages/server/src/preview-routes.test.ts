import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import type { WorkspacePreviewResponse } from "@orc/types";
import { defaultSettings } from "./config";
import { initDb } from "./db/index";
import * as repo from "./db/repo";
import { registerPreviewRoutes } from "./preview-routes";
import { PreviewManager } from "./previews";

test("VW09: preview routes enforce project ownership, reviewed configuration and mock-safe lifecycle", async () => {
  const db = initDb(":memory:"); const app = Fastify(); repo.upsertSettings(db, defaultSettings());
  for (const id of ["p", "other"]) {
    repo.createProject(db, { id, name: id, repoUrl: "unused", localPath: `/never-run/${id}`, defaultBranch: "main", status: "paused" });
    repo.createTask(db, { id: `${id}-task`, projectId: id, title: id, description: "", difficulty: "easy", assignedModel: "codex", status: "in_review", acceptanceCriteria: [], dependsOn: [], scopePaths: [], attempts: 0, maxAttempts: 3 });
  }
  const manager = new PreviewManager(db, [{ port: 4318, origin: "http://127.0.0.1:4318" }], true);
  let broadcast = 0; registerPreviewRoutes(app, db, manager, true, () => { broadcast++; });
  const url = "/api/projects/p/workspaces/p-task/preview";
  try {
    assert.equal((await app.inject("/api/projects/p/workspaces/primary/preview")).json<WorkspacePreviewResponse>().available, false);
    assert.equal((await app.inject("/api/projects/p/workspaces/other-task/preview")).statusCode, 404);
    const initial = (await app.inject(url)).json<WorkspacePreviewResponse>();
    const profile = { command: "never-execute-this-command", args: [], readinessPath: "/", startupTimeoutSeconds: 5 };
    assert.equal((await app.inject({ method: "PUT", url: "/api/projects/p/preview-profile", payload: { profile, projectUpdatedAt: "stale" } })).statusCode, 409);
    const saved = await app.inject({ method: "PUT", url: "/api/projects/p/preview-profile", payload: { profile, projectUpdatedAt: initial.projectUpdatedAt } });
    assert.equal(saved.statusCode, 200); assert.equal(broadcast, 1);
    const projectUpdatedAt = saved.json<WorkspacePreviewResponse>().projectUpdatedAt;
    assert.equal((await app.inject({ method: "POST", url: `${url}/start`, payload: { projectUpdatedAt, url: "http://169.254.169.254" } })).statusCode, 400);
    const start = () => app.inject({ method: "POST", url: `${url}/start`, payload: { projectUpdatedAt } });
    const first = await start(); assert.equal(first.statusCode, 202);
    assert.equal((await start()).json<WorkspacePreviewResponse>().preview?.id, first.json<WorkspacePreviewResponse>().preview?.id);
    assert.equal(manager.hasActivity("p"), true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await app.inject({ method: "POST", url: `${url}/open` })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: `${url}/stop` })).json<WorkspacePreviewResponse>().preview?.state, "stopped");
    assert.equal((await app.inject({ method: "POST", url: `${url}/open` })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: `${url}/stop` })).statusCode, 200);
  } finally { await manager.close(); await app.close(); db.close(); }
});
