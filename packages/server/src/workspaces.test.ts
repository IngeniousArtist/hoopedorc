import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import type { ListWorkspacesResponse, WorkspaceFilesResponse, WorkspaceFileResponse } from "@orc/types";
import { initDb } from "./db/index";
import * as repo from "./db/repo";
import { registerWorkspaceRoutes } from "./workspaces";

test("VW08: workspace routes bind file reads to project ownership and mock content", async () => {
  const db = initDb(":memory:"); const app = Fastify();
  repo.createProject(db, { id: "p", name: "Project", localPath: "/never-read-host-files", repoUrl: "unused", defaultBranch: "main", status: "paused" });
  repo.createProject(db, { id: "other", name: "Other", localPath: "/never-read-host-files-2", repoUrl: "unused", defaultBranch: "main", status: "paused" });
  repo.createTask(db, { id: "foreign", projectId: "other", title: "Other", description: "", difficulty: "easy", assignedModel: "codex", status: "ready", acceptanceCriteria: [], dependsOn: [], scopePaths: [], attempts: 0, maxAttempts: 3 });
  registerWorkspaceRoutes(app, db, true);
  try {
    assert.equal((await app.inject("/api/projects/p/workspaces")).json<ListWorkspacesResponse>().workspaces[0]!.state, "available");
    const url = "/api/projects/p/workspaces/primary";
    assert.equal((await app.inject(`${url}/files`)).json<WorkspaceFilesResponse>().files.length, 2);
    const file = await app.inject(`${url}/file?path=src%2FApp.tsx`);
    const content = file.json<WorkspaceFileResponse>();
    assert.equal(file.statusCode, 200); assert.match(content.content, /Hello/); assert.equal(content.contentSha.length, 64);
    assert.equal((await app.inject(`${url}/diff?path=src%2FApp.tsx`)).statusCode, 200);
    assert.equal((await app.inject(`${url}/file`)).statusCode, 400);
    assert.equal((await app.inject(`${url}/file?path=..%2Fsecret`)).statusCode, 404);
    assert.equal((await app.inject("/api/projects/p/workspaces/foreign/files")).statusCode, 404);
    assert.equal((await app.inject("/api/projects/missing/workspaces")).statusCode, 404);
  } finally { await app.close(); db.close(); }
});
