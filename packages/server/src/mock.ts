import type { Notification, Project, Settings, Task } from "@orc/types";
import { defaultSettings } from "./config";

/** Seed data for `npm run mock` so the web app is developable with no models. */
export function seed(): {
  projects: Project[];
  tasks: Task[];
  settings: Settings;
  notifications: Notification[];
} {
  const now = new Date().toISOString();

  const projects: Project[] = [
    {
      id: "proj-hoopedorc",
      name: "Hoopedorc Orchestrator",
      repoUrl: "https://github.com/you/hoopedorc",
      defaultBranch: "main",
      localPath: ".",
      status: "running",
      prdPath: "docs/PRD.md",
      createdAt: now,
      updatedAt: now,
    },
  ];

  const mk = (id: string, p: Partial<Task>): Task => ({
    id,
    projectId: "proj-hoopedorc",
    title: "",
    description: "",
    difficulty: "medium",
    status: "backlog",
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash",
    scopePaths: [],
    attempts: 0,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
    ...p,
  });

  const tasks: Task[] = [
    mk("t1", {
      title: "Kanban board UI",
      description: "DAG-aware board with live logs",
      status: "in_progress",
      assignedModel: "glm",
      role: "frontend",
      difficulty: "medium",
      scopePaths: ["apps/web/**"],
    }),
    mk("t2", {
      title: "Orchestrator engine",
      description: "Scheduler, worktrees, gates, validator, merge",
      status: "ready",
      assignedModel: "deepseek-pro",
      difficulty: "hard",
      scopePaths: ["packages/engine/**"],
    }),
    mk("t3", {
      title: "Server + adapters",
      description: "REST/WS API, SQLite, Claude + OpenCode runners",
      status: "in_review",
      assignedModel: "deepseek-flash",
      difficulty: "medium",
      scopePaths: ["packages/server/**", "packages/adapters/**"],
    }),
    mk("t4", {
      title: "Project docs",
      description: "README + architecture docs",
      status: "backlog",
      assignedModel: "nex",
      role: "docs",
      difficulty: "easy",
      dependsOn: ["t2", "t3"],
      scopePaths: ["docs/**"],
    }),
  ];

  // F22: one pending approval with context (PR link + validator reasons —
  // the same shape the web UI now renders a "View PR" link + reasons list
  // for) and one plain, already-responded notification with no context, so
  // `npm run mock` demonstrates both the new rendering and the unchanged
  // pre-F22 rendering side by side.
  const notifications: Notification[] = [
    {
      id: "notif-1",
      projectId: "proj-hoopedorc",
      taskId: "t3",
      severity: "action_required",
      title: "Approval needed: Server + adapters",
      message: "Touches packages/server/package.json (new dependency) — flagged as risky.",
      requiresApproval: true,
      options: ["approve", "reject"],
      createdAt: now,
      context: {
        prUrl: "https://github.com/you/hoopedorc/pull/42",
        reasons: [
          "Adds a new npm dependency (better-sqlite3 upgrade)",
          "Touches packages/server/package.json, outside the task's declared scope",
        ],
      },
    },
    {
      id: "notif-2",
      projectId: "proj-hoopedorc",
      taskId: "t1",
      severity: "info",
      title: "Kanban board UI merged",
      message: "PR #41 auto-merged — gates passed, validator approved (confidence 0.91).",
      requiresApproval: false,
      createdAt: now,
    },
  ];

  return { projects, tasks, settings: defaultSettings(), notifications };
}
