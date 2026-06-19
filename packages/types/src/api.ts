// REST contract. Request/response DTOs + the canonical route manifest.
// The server implements these; the web app calls them. Keep them in sync here.

import type {
  CostRecord,
  LogEvent,
  ModelId,
  Notification,
  Project,
  Run,
  Settings,
  Task,
  TaskStatus,
} from "./domain";

export interface CreateProjectRequest {
  name: string;
  /** Provide an existing repo, OR set createRepo to scaffold a fresh one. */
  repoUrl?: string;
  createRepo?: boolean;
  defaultBranch?: string; // default "main"
  budgetUsd?: number;
}
export interface CreateProjectResponse {
  project: Project;
}

export interface ListProjectsResponse {
  projects: Project[];
}
export interface GetProjectResponse {
  project: Project | null;
}

export interface PlanProjectRequest {
  /** Free-text goal/feature description handed to the planner (Claude). */
  goal: string;
  /** If true, return the plan for review and do NOT auto-start. */
  requireApproval?: boolean;
}
export interface PlanProjectResponse {
  project: Project;
  tasks: Task[];
  prdMarkdown: string;
}

export interface ListTasksResponse {
  tasks: Task[];
}
export interface GetTaskResponse {
  task: Task | null;
}

export interface UpdateTaskRequest {
  status?: TaskStatus;
  assignedModel?: ModelId;
  acceptanceCriteria?: string[];
  scopePaths?: string[];
}
export interface UpdateTaskResponse {
  task: Task;
}

export interface DispatchTaskResponse {
  run: Run;
  task: Task;
}

export interface ListRunsResponse {
  runs: Run[];
}
export interface RunLogsResponse {
  logs: LogEvent[];
}

export interface CostsResponse {
  totalUsd: number;
  byModel: Record<string, number>;
  records: CostRecord[];
}

export interface GetSettingsResponse {
  settings: Settings;
}
export interface UpdateSettingsRequest {
  settings: Partial<Settings>;
}
export interface UpdateSettingsResponse {
  settings: Settings;
}

export interface ListNotificationsResponse {
  notifications: Notification[];
}
export interface RespondNotificationRequest {
  choice: string;
}

export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}

/**
 * Canonical route manifest — single source of truth for HTTP paths.
 * The server registers exactly these; the web client builds URLs from them.
 */
export const ROUTES = {
  health: "GET /api/health",
  createProject: "POST /api/projects",
  listProjects: "GET /api/projects",
  getProject: "GET /api/projects/:id",
  planProject: "POST /api/projects/:id/plan",
  startProject: "POST /api/projects/:id/start",
  pauseProject: "POST /api/projects/:id/pause",
  listTasks: "GET /api/projects/:id/tasks",
  getTask: "GET /api/tasks/:id",
  updateTask: "PATCH /api/tasks/:id",
  dispatchTask: "POST /api/tasks/:id/dispatch",
  stopTask: "POST /api/tasks/:id/stop",
  listTaskRuns: "GET /api/tasks/:id/runs",
  runLogs: "GET /api/runs/:id/logs",
  costs: "GET /api/projects/:id/costs",
  getSettings: "GET /api/settings",
  updateSettings: "PUT /api/settings",
  listNotifications: "GET /api/notifications",
  respondNotification: "POST /api/notifications/:id/respond",
} as const;

export type RouteKey = keyof typeof ROUTES;
