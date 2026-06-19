import type { Project, Settings, Task } from "@orc/types";
import { defaultSettings } from "./config";

/** Seed data for `npm run mock` so the web app is developable with no models. */
export function seed(): {
  projects: Project[];
  tasks: Task[];
  settings: Settings;
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
      difficulty: "easy",
      dependsOn: ["t2", "t3"],
      scopePaths: ["docs/**"],
    }),
  ];

  return { projects, tasks, settings: defaultSettings() };
}
