import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { GitServiceImpl, WorkspaceInspectionError } from "@orc/engine";
import type { WorkspaceSummary, Project, Task } from "@orc/types";
import type { Db } from "./db/index";
import * as repo from "./db/repo";

const MOCK_FILES: Record<string, string> = {
  "README.md": "# Workspace demo\n\nThis is deterministic mock content.\n",
  "src/App.tsx": "export function App() {\n  return <main>Hello from your workspace</main>;\n}\n",
};

function identity(project: Project, task?: Task): WorkspaceSummary {
  return { id: task?.id ?? "primary", projectId: project.id, taskId: task?.id,
    title: task?.title ?? "Primary clone", worker: task?.assignedModel,
    taskStatus: task?.status, state: "available", branch: task?.branch };
}

export function registerWorkspaceRoutes(app: FastifyInstance, db: Db, mock: boolean): void {
  const git = new GitServiceImpl();
  const inspect = async (project: Project, task?: Task, file?: { path: string; diff?: boolean }) => {
    if (mock) {
      if (file && !Object.hasOwn(MOCK_FILES, file.path)) throw new WorkspaceInspectionError("File not found in mock workspace.", 404);
      const content = file ? MOCK_FILES[file.path]! : "";
      return { branch: task ? task.branch ?? `orc/${task.id}` : project.defaultBranch, headSha: "d".repeat(40), baseSha: "c".repeat(40),
        dirty: !!task, changedFiles: task ? 1 : 0, truncated: false,
        files: Object.keys(MOCK_FILES).map((path) => ({ path, changed: !!task && path.startsWith("src/"), untracked: false })),
        contents: file && !file.diff ? { content, contentSha: createHash("sha256").update(content).digest("hex") } : undefined,
        diff: file?.diff ? "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-Hello\n+Hello from your workspace\n" : undefined };
    }
    return git.inspectWorkspace(project, task, file);
  };
  const summary = async (project: Project, task?: Task): Promise<WorkspaceSummary> => {
    try {
      const facts = await inspect(project, task);
      return { ...identity(project, task), branch: facts.branch, headSha: facts.headSha, baseSha: facts.baseSha,
        dirty: facts.dirty, changedFiles: facts.changedFiles };
    } catch (error) {
      return { ...identity(project, task), state: "unavailable", reason: error instanceof WorkspaceInspectionError
        ? error.message : "Workspace is missing or cannot be safely inspected. Check its repository and access permissions; files are preserved." };
    }
  };
  app.get("/api/projects/:id/workspaces", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = repo.getProject(db, id);
    if (!project) return reply.code(404).send({ error: "Project not found." });
    const tasks = repo.getTasks(db, id).filter((task) => task.worktreePath || task.branch || mock);
    const workspaces = [await summary(project)];
    // Bound concurrent subprocesses while retaining every recorded workspace.
    for (let index = 0; index < tasks.length; index += 4) {
      workspaces.push(...await Promise.all(tasks.slice(index, index + 4).map((task) => summary(project, task))));
    }
    return { workspaces };
  });
  for (const kind of ["files", "file", "diff"] as const) {
    app.get(`/api/projects/:id/workspaces/:workspaceId/${kind}`, async (req, reply) => {
      const { id, workspaceId } = req.params as { id: string; workspaceId: string };
      const project = repo.getProject(db, id);
      const task = workspaceId === "primary" ? undefined : repo.getTask(db, workspaceId) ?? undefined;
      if (!project || (workspaceId !== "primary" && (!task || task.projectId !== id))) {
        return reply.code(404).send({ error: "Workspace not found for this project." });
      }
      const { path } = req.query as { path?: unknown };
      if (kind !== "files" && (typeof path !== "string" || path.length > 4096 || !path)) {
        return reply.code(400).send({ error: "A repository-relative file path is required." });
      }
      try {
        const result = await inspect(project, task, kind === "files" ? undefined : { path: path as string, diff: kind === "diff" });
        // A project/task may be deleted or reassigned while Git is awaiting I/O.
        const current = repo.getProject(db, id);
        const currentTask = task ? repo.getTask(db, task.id) : undefined;
        if (!current || current.localPath !== project.localPath || (task && (!currentTask || currentTask.projectId !== id || currentTask.worktreePath !== task.worktreePath || currentTask.branch !== task.branch))) {
          throw new WorkspaceInspectionError("Workspace ownership changed. Refresh the inventory.");
        }
        const workspace = { ...identity(project, task), branch: result.branch, headSha: result.headSha,
          baseSha: result.baseSha, dirty: result.dirty, changedFiles: result.changedFiles };
        const observedAt = new Date().toISOString();
        if (kind === "files") return { workspace, files: result.files, truncated: result.truncated, observedAt };
        if (kind === "diff") return { workspace, path, diff: result.diff, observedAt };
        return { workspace, path, ...result.contents, observedAt };
      } catch (error) {
        return reply.code(error instanceof WorkspaceInspectionError ? error.status : 409).send({
          error: error instanceof WorkspaceInspectionError ? error.message : "Workspace or file unavailable, changed, or exceeded an inspection limit. Refresh and check repository access.",
          code: "WORKSPACE_INSPECTION_REFUSED",
        });
      }
    });
  }
}
