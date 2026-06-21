// REST contract. Request/response DTOs + the canonical route manifest.
// The server implements these; the web app calls them. Keep them in sync here.

import type {
  AuditEntry,
  CostRecord,
  Difficulty,
  LogEvent,
  ModelId,
  Notification,
  Project,
  Role,
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
  /** Optional repo name when createRepo is set; defaults to a slug of `name`. */
  repoName?: string;
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

/** One turn in the planning conversation (Sonnet drives these). */
export interface PlanChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PlanChatRequest {
  messages: PlanChatMessage[];
}
export interface PlanChatResponse {
  /** The planner's conversational reply to the latest user turn. */
  reply: string;
  /** USD spent on this single turn (also recorded against the project). */
  costUsd: number;
}

/**
 * A proposed task before it is materialized into a real Task row. Editable in
 * the UI's task table; `dependsOn` are indices into this same array.
 */
export interface DraftTask {
  title: string;
  description: string;
  difficulty: Difficulty;
  role?: Role;
  acceptanceCriteria: string[];
  dependsOn: number[];
  scopePaths: string[];
  /** Suggested author model (resolved from routing); editable before commit. */
  assignedModel: ModelId;
}

export interface PlanDeconstructRequest {
  messages: PlanChatMessage[];
}
export interface PlanDeconstructResponse {
  prdMarkdown: string;
  tasks: DraftTask[];
  costUsd: number;
}

export interface PlanCommitRequest {
  prdMarkdown: string;
  tasks: DraftTask[];
}
export interface PlanCommitResponse {
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

export interface RetryTaskResponse {
  run: Run;
  task: Task;
}

export interface TaskDiffResponse {
  prNumber?: number;
  diff: string;
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

export interface ModelCostBreakdown {
  model: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  runs: number;
}
export interface DailyCost {
  date: string; // YYYY-MM-DD
  costUsd: number;
}
export interface TaskCostBreakdown {
  taskId: string;
  title: string;
  costUsd: number;
}

export interface CostAnalyticsResponse {
  totalUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  byModel: ModelCostBreakdown[];
  daily: DailyCost[];
  byTask: TaskCostBreakdown[];
  /** Project hard cap, if set. */
  budgetUsd?: number;
  /** Burn-rate projection. */
  completedTasks: number;
  avgCostPerCompletedTask: number;
  remainingBudgetUsd?: number;
  /** Estimated #tasks before the project budget is hit, at the current rate. */
  tasksUntilCap?: number;
}

/** Pre-run cost estimate for one not-yet-done task. */
export interface TaskEstimate {
  taskId: string;
  title: string;
  model: ModelId;
  validatorModel: ModelId;
  /** One author + one validator run. */
  expectedUsd: number;
  /** Author + validator run for every allowed attempt (worst case). */
  highUsd: number;
  /** True only if both models have historical runs to average from. */
  hasHistory: boolean;
}
export interface EstimateResponse {
  tasks: TaskEstimate[];
  totalExpectedUsd: number;
  totalHighUsd: number;
  /** "high" if every involved model has run history, else "low". */
  confidence: "high" | "low";
  note: string;
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

export interface AuditLogResponse {
  entries: AuditEntry[];
}

export interface RollbackTaskResponse {
  task: Task;
}

/** One setup/health probe (gh / claude / opencode auth). */
export interface SetupCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export interface SetupHealthResponse {
  checks: SetupCheck[];
  allOk: boolean;
}

/** Send a one-off Telegram test message. Uses saved config unless overridden. */
export interface TelegramTestRequest {
  token?: string;
  chatId?: string;
}
export interface TelegramTestResponse {
  ok: boolean;
  error?: string;
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
  planChat: "POST /api/projects/:id/plan/chat",
  planDeconstruct: "POST /api/projects/:id/plan/deconstruct",
  planCommit: "POST /api/projects/:id/plan/commit",
  startProject: "POST /api/projects/:id/start",
  pauseProject: "POST /api/projects/:id/pause",
  listTasks: "GET /api/projects/:id/tasks",
  getTask: "GET /api/tasks/:id",
  updateTask: "PATCH /api/tasks/:id",
  dispatchTask: "POST /api/tasks/:id/dispatch",
  retryTask: "POST /api/tasks/:id/retry",
  taskDiff: "GET /api/tasks/:id/diff",
  stopTask: "POST /api/tasks/:id/stop",
  listTaskRuns: "GET /api/tasks/:id/runs",
  runLogs: "GET /api/runs/:id/logs",
  costs: "GET /api/projects/:id/costs",
  costAnalytics: "GET /api/projects/:id/analytics",
  estimatePlan: "GET /api/projects/:id/estimate",
  getSettings: "GET /api/settings",
  updateSettings: "PUT /api/settings",
  telegramTest: "POST /api/telegram/test",
  listNotifications: "GET /api/notifications",
  respondNotification: "POST /api/notifications/:id/respond",
  auditLog: "GET /api/projects/:id/audit",
  rollbackTask: "POST /api/tasks/:id/rollback",
  setupHealth: "GET /api/setup",
} as const;

export type RouteKey = keyof typeof ROUTES;
