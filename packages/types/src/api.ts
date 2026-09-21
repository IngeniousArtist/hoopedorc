// REST contract. Request/response DTOs + the canonical route manifest.
// The server implements these; the web app calls them. Keep them in sync here.

import type {
  AuditEntry,
  CostRecord,
  Difficulty,
  LogEvent,
  MergeDecision,
  ModelId,
  Notification,
  PlanningOperationState,
  Project,
  ProjectConfig,
  PreviewProfile,
  Role,
  RollbackJob,
  Run,
  RunnerKind,
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
  /**
   * Optional explicit local clone directory. If omitted, the server picks one
   * under Settings.defaultProjectsDir (or ENV.reposDir) named from a slug of
   * `name`, deduped on collision.
   */
  localPath?: string;
  /** Per-project gate/retry/merge-policy overrides (F9). */
  config?: ProjectConfig;
}
/** F24: also shows the running instance's version, read once at boot from
 *  the root package.json — surfaced on SetupView so "what's actually
 *  deployed on that remote box" isn't a guessing game over SSH. */
export interface HealthResponse {
  ok: boolean;
  mock: boolean;
  version: string;
  state: "starting" | "running" | "shutting_down" | "stopped";
  shutdownReason?: string;
  /** Actionable dependency failures; never contains credentials or raw env. */
  degraded: string[];
  dependencies: {
    docker: {
      available: boolean;
      required: boolean;
      detail: string;
    };
    telegram: {
      enabled: boolean;
      running: boolean;
      state: "disabled" | "starting" | "healthy" | "degraded" | "stopped";
      lastSuccessAt?: string;
      lastError?: string;
      lastErrorAt?: string;
    };
  };
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

/** VW08: server-owned IDs, never client-supplied filesystem roots. */
export interface WorkspaceSummary {
  id: string;
  projectId: string;
  taskId?: string;
  title: string;
  worker?: string;
  taskStatus?: TaskStatus;
  state: "available" | "unavailable";
  reason?: string;
  branch?: string;
  headSha?: string;
  baseSha?: string;
  dirty?: boolean;
  changedFiles?: number;
}
export interface WorkspaceFileEntry { path: string; changed: boolean; untracked: boolean }
export interface ListWorkspacesResponse { workspaces: WorkspaceSummary[] }
export interface WorkspaceFilesResponse {
  workspace: WorkspaceSummary;
  files: WorkspaceFileEntry[];
  truncated: boolean;
  observedAt: string;
}
export interface WorkspaceFileResponse {
  workspace: WorkspaceSummary;
  path: string;
  content: string;
  contentSha: string;
  observedAt: string;
}
export interface WorkspaceDiffResponse {
  workspace: WorkspaceSummary;
  path: string;
  diff: string;
  observedAt: string;
}

export type PreviewState = "starting" | "ready" | "stopping" | "stopped" | "failed" | "interrupted";
export interface WorkspacePreview {
  id: string;
  projectId: string;
  taskId: string;
  state: PreviewState;
  profile: PreviewProfile;
  headSha?: string;
  dirty: boolean;
  isolation: "host";
  publicOrigin: string;
  detail: string;
  logs: string;
  startedAt: string;
  updatedAt: string;
}
export interface WorkspacePreviewResponse {
  preview: WorkspacePreview | null;
  profile: PreviewProfile | null;
  projectUpdatedAt: string;
  available: boolean;
  reason?: string;
}
export interface SetPreviewProfileRequest { profile: PreviewProfile | null; projectUpdatedAt: string }
export interface StartWorkspacePreviewRequest { projectUpdatedAt: string }
export interface PreviewLaunchResponse { url: string; expiresAt: string }

export interface BrowserReviewStep {
  action: "clickText" | "fillLabel" | "expectText";
  target: string;
  value?: string;
}
export interface CaptureReviewRequest {
  requestId: string;
  taskUpdatedAt: string;
  previewId: string;
  path: string;
  viewport: { width: number; height: number };
  steps: BrowserReviewStep[];
}
export interface UploadReviewEvidenceRequest {
  requestId: string;
  taskUpdatedAt: string;
  kind: "screenshot" | "trace" | "text";
  name: string;
  description: string;
  contentBase64: string;
}
export interface ReviewArtifact {
  id: string;
  kind: "screenshot" | "trace" | "text";
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  expiresAt: string;
  available: boolean;
}
export interface ReviewEvidence {
  id: string;
  projectId: string;
  taskId: string;
  runId?: string;
  attempt: number;
  runGeneration: number;
  headSha?: string;
  dirty: boolean;
  previewId?: string;
  previewProfile?: PreviewProfile;
  environment: string;
  testedPath?: string;
  testedUrl?: string;
  viewport?: { width: number; height: number };
  steps?: BrowserReviewStep[];
  source: "browser" | "upload";
  state: "running" | "passed" | "failed" | "cancelled" | "interrupted" | "supplied";
  detail: string;
  startedAt: string;
  endedAt?: string;
  freshness: "current" | "stale" | "unverified" | "unavailable";
  freshnessReason?: string;
  artifacts: ReviewArtifact[];
}
export interface TaskReviewResponse {
  /** Environment preference; legacy projects default to web. */
  output?: import("./environment").EnvironmentProfile["output"];
  task: Task;
  runs: Run[];
  decisions: MergeDecision[];
  evidence: ReviewEvidence[];
  evidenceTruncated: boolean;
  workspace: WorkspaceSummary;
  preview: WorkspacePreview | null;
  browser: { available: boolean; reason?: string };
}
export interface ReviewEvidenceResponse { evidence: ReviewEvidence }

export type ReferenceKind = "rules" | "design" | "tokens" | "component" | "framework" | "figma" | "screenshot" | "skill" | "reference";
export interface ReferenceSource {
  type: "text" | "url" | "repository" | "attachment" | "legacy-task";
  locator: string;
  /** Observed hash/commit or an explicitly operator-supplied version. */
  revision?: string;
}
export interface ReferenceInput {
  title: string;
  kind: ReferenceKind;
  source: ReferenceSource;
  applicability: string;
  conflictGroup: string;
  content: string;
  archived: boolean;
}
export interface LibraryReference extends ReferenceInput {
  id: string;
  projectId: string;
  revision: number;
  contentSha: string;
  createdAt: string;
  provenance: "operator" | "legacy-import";
}
export interface LibraryEntry extends Omit<LibraryReference, "content"> {
  contentBytes: number;
  referencedByTasks: { id: string; title: string; revisions: number[] }[];
  conflictsWith: string[];
}
export interface LibraryResponse { entries: LibraryEntry[] }
export interface LibraryDetailResponse { reference: LibraryReference; versions: LibraryReference[] }
export interface SaveLibraryReferenceRequest { requestId: string; expectedRevision: number; reference: ReferenceInput }
export interface SaveLibraryReferenceResponse { reference: LibraryReference }
export interface LibrarySelection { id: string; revision: number }
export interface LibraryHandoffRequest { references: LibrarySelection[] }
export interface LibraryHandoffResponse { markdown: string }
export interface ImportLibraryResponse { imported: number; unchanged: number; issues: string[] }

export interface DeleteProjectResponse {
  ok: true;
}

export interface UpdateProjectRequest {
  name?: string;
  /** number to set, null to clear the cap. */
  budgetUsd?: number | null;
  defaultBranch?: string;
  /** Object to set, null to clear (F9). Omit to leave unchanged. */
  config?: ProjectConfig | null;
}
export interface UpdateProjectResponse {
  project: Project;
}

/**
 * F3's two pause modes. `drain: true` ("Pause — finish current tasks") lets
 * already-dispatched tasks run to completion and just stops picking up new
 * ready work; omitted/false ("Stop now") is the original hard-stop behavior
 * — abort every active task immediately and requeue it to backlog.
 */
export interface PauseProjectRequest {
  drain?: boolean;
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
  /** VW07: draft a separate proposal while execution continues. */
  proposal?: boolean;
  /** O3: immutable server-issued id for this editable planning revision. */
  revisionId: string;
  messages: PlanChatMessage[];
  /** VW06: compare-and-swap version; optional for older synchronous clients. */
  sessionVersion?: number;
  /** Client UUID: repeating the exact request returns the same operation. */
  operationId?: string;
  /** Return 202 PlanOperationResponse immediately instead of waiting for a result. */
  background?: boolean;
}

/**
 * VW03: what planning observed about the project's repository right before a
 * planner call. Recorded with the planning session so the Plan tab, the
 * follow-up prompts, the session archive, and the commit boundary can tell an
 * existing codebase from an empty repository and notice a moved revision.
 * `unavailable` is never persisted; it is the typed failure the routes return
 * (`503`, `code: "REPOSITORY_UNAVAILABLE"`) instead of planning elsewhere.
 */
export type RepositoryInspectionState = "existing" | "empty" | "unavailable";

export interface RepositoryInspection {
  state: RepositoryInspectionState;
  /** ISO timestamp of the inspection. */
  inspectedAt: string;
  /** Checked-out branch, when the clone was readable. */
  branch?: string;
  /** Full HEAD commit SHA, when the clone has at least one commit. */
  commit?: string;
  /** Tracked files, excluding Hoopedorc-owned planning context and seeds. */
  trackedFileCount?: number;
  /** Stacks detected from manifests, e.g. ["node", "typescript"]; empty when unknown. */
  stack: string[];
  /** `package.json` script names — Node projects only. */
  packageScripts?: string[];
  /** Secret-free reason; `unavailable` only. */
  error?: string;
}

/** `ApiError.details` for `code: "REPOSITORY_DRIFT"` on `plan/commit`. */
export interface RepositoryDriftDetails {
  plannedCommit: string;
  currentCommit: string;
}

export interface PlanChatResponse {
  sessionVersion?: number;
  /** The planner's conversational reply to the latest user turn. */
  reply: string;
  /** USD spent on this single turn (also recorded against the project). */
  costUsd: number;
  /** VW03: the inspection this turn was planned against. */
  repository?: RepositoryInspection;
}

/**
 * A proposed task before it is materialized into a real Task row. Editable in
 * the UI's task table; `dependsOn` are indices into this same array.
 */
export interface DraftTask {
  title: string;
  /**
   * Self-contained implementation handoff. F51 may include optional
   * `### Relevant references` and `### Required skills/capabilities`
   * subsections; they remain Markdown inside this existing field.
   */
  description: string;
  difficulty: Difficulty;
  role?: Role;
  acceptanceCriteria: string[];
  dependsOn: number[];
  scopePaths: string[];
  /** Suggested author model (resolved from routing); editable before commit. */
  assignedModel: ModelId;
  /**
   * B47: set only by Hoopedorc's own generated draft tasks (e.g. the visual
   * QA task) so a later deconstruction pass can recognize and safely
   * replace its own prior insertion without matching on editable title
   * text — which risks silently deleting an unrelated planner/user task
   * that happens to share the same title. The raw planner LLM output is
   * never copied through with this field set; only the generator itself
   * sets it.
   */
  generatedTaskKind?: "visual-qa";
}

export interface PlanDeconstructRequest extends PlanChatRequest {
  /**
   * Explicit screenshot fallback after a typed live-node failure. Exact node
   * URLs remain in chat history but are not promoted into task fidelity.
   */
  figmaVerification?: "live" | "attachments";
}

/**
 * F52: one exact Figma selection that the routed deconstructor actually
 * opened through its configured runner. This is small planning-session
 * scratch, not a raw Figma payload or durable global capability cache.
 */
export interface VerifiedFigmaReference {
  canonicalUrl: string;
  fileKey: string;
  nodeId: string;
  name: string;
  fileName?: string;
  width?: number;
  height?: number;
  verifiedModel: ModelId;
  verifiedRunner: RunnerKind;
  verifiedAt: string;
}

export type FigmaCapabilityIssueCode =
  | "figma_invalid_node"
  | "figma_reference_limit"
  | "figma_mcp_missing"
  | "figma_auth_required"
  | "figma_access_denied"
  | "figma_node_not_found"
  | "figma_timeout"
  | "figma_malformed_response"
  | "figma_unavailable";

/** Actionable, secret-free failure returned in ApiError.details by F52. */
export interface FigmaCapabilityIssue {
  stage: "deconstruction" | "author_preflight" | "author";
  code: FigmaCapabilityIssueCode;
  model: ModelId;
  runner: RunnerKind;
  message: string;
  actions: string[];
  canonicalUrl?: string;
  nodeId?: string;
}

export interface FigmaVerificationFailureDetails {
  issue: FigmaCapabilityIssue;
  /** Completed probe cost, if the runner reported one before refusing. */
  costUsd: number;
}

export interface PlanDeconstructResponse {
  sessionVersion?: number;
  prdMarkdown: string;
  tasks: DraftTask[];
  costUsd: number;
  /** F38: generated project-context file for coding agents (Codex/opencode
   *  read it natively; Claude via a committed one-line CLAUDE.md import).
   *  Operator-editable in PlanView before commit, same as prdMarkdown. */
  agentsMd?: string;
  /** Present only when exact Figma selection URLs were supplied and verified. */
  verifiedFigmaReferences?: VerifiedFigmaReference[];
  /** VW03: the inspection this deconstruction was planned against. */
  repository?: RepositoryInspection;
}

export interface PlanCommitRequest {
  sessionVersion?: number;
  /** O3: idempotency key returned by PlanningSessionResponse. */
  revisionId: string;
  prdMarkdown: string;
  tasks: DraftTask[];
  agentsMd?: string;
  /**
   * VW03: the repository moved since the draft was planned and the operator
   * has seen the `REPOSITORY_DRIFT` disclosure. Without it, a drifted commit
   * is refused with `409` so stale evidence is never applied silently.
   */
  acknowledgeRepositoryDrift?: boolean;
}
export interface PlanCommitResponse {
  /** The committed/replayed revision. */
  revisionId: string;
  project: Project;
  tasks: Task[];
  prdMarkdown: string;
  agentsMd?: string;
}

/** Persisted planning state for a project — fetched on Plan page load. */
export interface PlanningSessionResponse {
  /** VW06: changes whenever transcript/brief/task draft changes. */
  sessionVersion?: number;
  /** Most recent operation for this revision; null when none has started. */
  operation?: PlanningOperation | null;
  /** O3: server-issued id reused by every write/retry for this revision. */
  revisionId: string;
  messages: PlanChatMessage[];
  prd?: string;
  draftTasks?: DraftTask[];
  planCostUsd: number;
  agentsMd?: string;
  verifiedFigmaReferences?: VerifiedFigmaReference[];
  /** VW03: generated draft's inspection; latest chat inspection when no draft exists. */
  repository?: RepositoryInspection;
}

/**
 * One archived plan-session markdown file (F28's `context/plan-sessions/`
 * archive) — the read-only history the Plan tab shows after a plan is
 * committed (the live session row is cleared then).
 */
export interface PlanSessionArchive {
  /** On-disk filename, e.g. "2026-07-12-0930.md". */
  name: string;
  /** Human-readable session start, e.g. "2026-07-12 09:30". */
  startedLabel: string;
  /** Full rendered markdown: transcript + deconstructed plan + commit marker. */
  markdown: string;
}
export interface ListPlanSessionArchivesResponse {
  sessions: PlanSessionArchive[];
}

export interface SaveDraftRequest {
  sessionVersion?: number;
  /** O3: immutable server-issued id for this editable planning revision. */
  revisionId: string;
  prdMarkdown: string;
  tasks: DraftTask[];
  agentsMd?: string;
}
export interface SaveDraftResponse {
  ok: true;
  sessionVersion?: number;
}

/** Durable status: polling is authoritative even when WebSocket updates are missed. */
export interface PlanningOperation {
  id: string;
  projectId: string;
  revisionId: string;
  kind: "chat" | "deconstruct";
  state: PlanningOperationState;
  input: PlanDeconstructRequest;
  retryOf?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  result?: PlanChatResponse | PlanDeconstructResponse;
  error?: { message: string; status: number; code?: string; details?: unknown };
  invocationIds: string[];
}

export interface PlanOperationResponse { operation: PlanningOperation }

export interface PlanChangeTask extends DraftTask {
  /** Explicit operator selection; only never-started pending work is editable. */
  existingTaskId?: string;
  /** Dependencies on retained board tasks, in addition to draft indices. */
  existingDependsOn: string[];
}
export interface ReviewPlanChangesRequest {
  revisionId: string;
  sessionVersion: number;
  taskGeneration: number;
  prdMarkdown: string;
  agentsMd?: string;
  tasks: PlanChangeTask[];
}
export interface PlanChangeReview {
  id: string;
  projectId: string;
  state: "reviewed" | "applying" | "applied";
  createdAt: string;
  input: ReviewPlanChangesRequest;
  previousPrd: string;
  /** Stable IDs are reserved during review, not regenerated on apply/retry. */
  changes: { before?: Task; after: Task }[];
  retainedTasks: Task[];
}
export interface PlanChangeContextResponse {
  revisionId: string;
  sessionVersion: number;
  taskGeneration: number;
  tasks: Task[];
  executionActive: boolean;
  latestReview: PlanChangeReview | null;
}
export interface PlanChangeReviewResponse { review: PlanChangeReview }
export interface ApplyPlanChangesRequest { reviewId: string }

/**
 * F27: a file uploaded from PlanView as planning context — stored at
 * `context/attachments/<name>` in the project's clone, where the planner
 * reads it with its own file tools. `name` is the sanitized, on-disk
 * filename (not necessarily identical to what the user picked — see
 * CONTRACT.md).
 */
export interface PlanAttachment {
  name: string;
  size: number;
  mtime: string;
}
export interface ListPlanAttachmentsResponse {
  attachments: PlanAttachment[];
}

export interface ListTasksResponse {
  tasks: Task[];
}
export interface GetTaskResponse {
  task: Task | null;
}

/**
 * Materialize a single new task on a project (F3 — "add a task while
 * running"). Unlike DraftTask.dependsOn (indices into a batch being planned),
 * `dependsOn` here references real, already-existing task ids in this
 * project, since exactly one task is being added.
 */
export interface AddTaskRequest {
  title: string;
  description?: string;
  difficulty?: Difficulty;
  role?: Role;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  scopePaths?: string[];
  /** Defaults to routing's pick for the given difficulty/role if omitted. */
  assignedModel?: ModelId;
}
export interface AddTaskResponse {
  task: Task;
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

/**
 * No `run` field: dispatch creates a durable priority request on the task. A
 * run may not exist yet because dependencies, scope, budget, or capacity can
 * still hold it. The engine emits the authoritative run event when authoring
 * genuinely begins.
 */
export interface DispatchTaskResponse {
  task: Task;
}

export interface RetryTaskResponse {
  task: Task;
}

export interface StopTaskResponse {
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
/** GET /api/tasks/:id/logs — every log for a task across all its runs,
 *  newest-capped at `limit` (default 1000). Optional `?after=<ISO ts>` for
 *  incremental polling. */
export interface TaskLogsResponse {
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
  rollback: RollbackJob;
}

export interface TaskRollbackResponse {
  rollback: RollbackJob | null;
}

/** Every validator verdict recorded for a task, newest first — the Review
 *  tab's source of "latest GateResult" (decisions[0].gate) and history. */
export interface TaskDecisionsResponse {
  decisions: MergeDecision[];
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

export type SelfUpdateState =
  | "idle"
  | "queued"
  | "checking"
  | "pulling"
  | "installing"
  | "building"
  | "restarting"
  | "succeeded"
  | "failed";

/** F50: deployment capability plus the current/last guarded self-update. */
export interface SelfUpdateStatusResponse {
  /** Whether this deployment has the exact systemd boundary needed by F50. */
  available: boolean;
  /** Stable deployment limitation (mock/non-Linux/unit mismatch/no sudo). */
  unavailableReason?: string;
  /** Temporary refusal (active project, dirty tree, non-main, in progress). */
  blockedReason?: string;
  state: SelfUpdateState;
  message: string;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  branch?: string;
  fromCommit?: string;
  toCommit?: string;
  updateUnit: string;
}

export interface StartSelfUpdateResponse {
  status: SelfUpdateStatusResponse;
}

/** Result of running a trivial prompt through one model (costs a little). */
export interface ModelTestResult {
  id: ModelId;
  displayName: string;
  /** Correlates the displayed/persisted check to B40's invocation ledger. */
  invocationId?: string;
  /** Attempt-stable setting used by this health invocation. */
  effort: string;
  ok: boolean;
  costUsd: number;
  ms: number;
  reply?: string;
  error?: string;
}
export interface TestModelsResponse {
  results: ModelTestResult[];
  totalCostUsd: number;
}

/** Per-model observability for the multi-subscription audience (F6). */
export interface ModelHealthEntry {
  id: ModelId;
  displayName: string;
  enabled: boolean;
  effort: string;
  /** Most recent "Test models" result for this model, if it's ever been run. */
  lastCheck?: {
    ok: boolean;
    ts: string;
    ms: number;
    costUsd: number;
    reply?: string;
    error?: string;
  };
  /** From every terminal model invocation, across all stages and projects. */
  totalRuns: number;
  failedRuns: number;
  medianDurationMs: number | null;
  /** ISO timestamp; present only while a rate-limit cooldown is active. */
  coolingDownUntil?: string;
  /**
   * F35: current usage within this model's configured subscription quota
   * window (`ModelConfig.quota`), alongside its configured limits — lets the
   * operator see "how much of my window is used" before hitting F16's
   * invisible enforcement wall. Absent when the model has no quota configured.
   */
  windowUsage?: {
    runs: number;
    costUsd: number;
    windowHours: number;
    maxRuns?: number;
    maxCostUsd?: number;
  };
}
export interface ModelHealthResponse {
  models: ModelHealthEntry[];
}

/** Every model id `opencode models` reports as installed/authenticated. */
export interface ModelRosterResponse {
  models: string[];
}

export type ModelCatalogEntryKind = "alias" | "model";

export interface ModelCatalogEntry {
  slug: string;
  displayName: string;
  description?: string;
  provider?: string;
  kind: ModelCatalogEntryKind;
  reasoningEfforts?: string[];
}

export interface RunnerModelCatalog {
  runner: RunnerKind;
  label: string;
  source: string;
  models: ModelCatalogEntry[];
  error?: string;
}

export interface ModelCatalogResponse {
  generatedAt: string;
  catalogs: RunnerModelCatalog[];
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
export interface RespondNotificationResponse {
  notification: Notification;
  /** `queued` is durable but awaits a recovering task/rollback owner. */
  delivery: "applied" | "queued";
}

/** F23: the "Stop all" panic button — one confirmed tap aborts every
 *  currently-running project (autonomous loop and any in-flight manual
 *  dispatch alike). */
export interface StopAllResponse {
  /** Ids of projects that were actually running (and so got stopped). */
  projectIds: string[];
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
  resources: "GET /api/resources",
  executionStatus: "GET /api/execution",
  verifyExecutionProfile: "POST /api/execution/profiles/:profileId/verify",
  stopExecutionWorker: "POST /api/execution/workers/:workerId/stop",
  recoverResource: "POST /api/resources/:reservationId/recover",
  projectActivation: "GET /api/projects/:id/activation",
  saveProjectActivation: "PUT /api/projects/:id/activation",
  health: "GET /api/health",
  createProject: "POST /api/projects",
  listProjects: "GET /api/projects",
  getProject: "GET /api/projects/:id",
  listWorkspaces: "GET /api/projects/:id/workspaces",
  workspaceFiles: "GET /api/projects/:id/workspaces/:workspaceId/files",
  workspaceFile: "GET /api/projects/:id/workspaces/:workspaceId/file",
  workspaceDiff: "GET /api/projects/:id/workspaces/:workspaceId/diff",
  workspacePreview: "GET /api/projects/:id/workspaces/:workspaceId/preview",
  startWorkspacePreview: "POST /api/projects/:id/workspaces/:workspaceId/preview/start",
  stopWorkspacePreview: "POST /api/projects/:id/workspaces/:workspaceId/preview/stop",
  openWorkspacePreview: "POST /api/projects/:id/workspaces/:workspaceId/preview/open",
  setPreviewProfile: "PUT /api/projects/:id/preview-profile",
  taskReview: "GET /api/projects/:id/tasks/:taskId/review",
  captureReview: "POST /api/projects/:id/tasks/:taskId/review/capture",
  uploadReviewEvidence: "POST /api/projects/:id/tasks/:taskId/review/evidence",
  cancelReviewCapture: "POST /api/projects/:id/tasks/:taskId/review/evidence/:evidenceId/cancel",
  reviewArtifact: "GET /api/projects/:id/tasks/:taskId/review/artifacts/:artifactId",
  projectLibrary: "GET /api/projects/:id/library",
  libraryReference: "GET /api/projects/:id/library/:referenceId",
  saveLibraryReference: "PUT /api/projects/:id/library/:referenceId",
  importProjectLibrary: "POST /api/projects/:id/library/import",
  libraryHandoff: "POST /api/projects/:id/library/handoff",
  updateProject: "PATCH /api/projects/:id",
  deleteProject: "DELETE /api/projects/:id",
  planProject: "POST /api/projects/:id/plan",
  planChat: "POST /api/projects/:id/plan/chat",
  planDeconstruct: "POST /api/projects/:id/plan/deconstruct",
  planOperation: "GET /api/projects/:id/plan/operations/:operationId",
  planOperationRetry: "POST /api/projects/:id/plan/operations/:operationId/retry",
  planOperationCancel: "POST /api/projects/:id/plan/operations/:operationId/cancel",
  planChangeContext: "GET /api/projects/:id/plan/changes",
  reviewPlanChanges: "POST /api/projects/:id/plan/changes/review",
  applyPlanChanges: "POST /api/projects/:id/plan/changes/apply",
  planCommit: "POST /api/projects/:id/plan/commit",
  planSession: "GET /api/projects/:id/plan/session",
  planSessionArchives: "GET /api/projects/:id/plan/sessions",
  planSaveDraft: "POST /api/projects/:id/plan/save-draft",
  listPlanAttachments: "GET /api/projects/:id/plan/attachments",
  uploadPlanAttachment: "POST /api/projects/:id/plan/attachments",
  deletePlanAttachment: "DELETE /api/projects/:id/plan/attachments/:name",
  startProject: "POST /api/projects/:id/start",
  pauseProject: "POST /api/projects/:id/pause",
  listTasks: "GET /api/projects/:id/tasks",
  addTask: "POST /api/projects/:id/tasks",
  getTask: "GET /api/tasks/:id",
  updateTask: "PATCH /api/tasks/:id",
  dispatchTask: "POST /api/tasks/:id/dispatch",
  retryTask: "POST /api/tasks/:id/retry",
  taskDiff: "GET /api/tasks/:id/diff",
  stopTask: "POST /api/tasks/:id/stop",
  listTaskRuns: "GET /api/tasks/:id/runs",
  runLogs: "GET /api/runs/:id/logs",
  taskLogs: "GET /api/tasks/:id/logs",
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
  taskRollback: "GET /api/tasks/:id/rollback",
  taskDecisions: "GET /api/tasks/:id/decisions",
  setupHealth: "GET /api/setup",
  selfUpdateStatus: "GET /api/setup/self-update",
  startSelfUpdate: "POST /api/setup/self-update",
  setupModels: "GET /api/setup/models",
  modelCatalog: "GET /api/setup/model-catalog",
  modelHealth: "GET /api/setup/model-health",
  testModels: "POST /api/setup/test-models",
  stopAll: "POST /api/engine/stop-all",
} as const;

export type RouteKey = keyof typeof ROUTES;
