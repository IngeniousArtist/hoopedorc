import crypto from "node:crypto";
import type { RepositoryFileWrite } from "@orc/engine";
import type { DraftTask, Project, Settings, Task } from "@orc/types";
import { pickAssignedModel } from "@orc/types";
import type { Db } from "./db/index.js";
import * as repo from "./db/repo.js";
import {
  recordPlanCommit,
  type PlanSessionWriteResult,
} from "./plan-sessions.js";

export type PlanningCommitStage =
  | "busy"
  | "revision"
  | "repository"
  | "archive"
  | "database";

export class PlanningCommitError extends Error {
  override name = "PlanningCommitError";

  constructor(
    readonly stage: PlanningCommitStage,
    message: string,
    readonly originalError?: unknown,
  ) {
    super(
      `${stage}: ${message}` +
        (originalError
          ? ` (${originalError instanceof Error ? originalError.message : String(originalError)})`
          : ""),
    );
  }
}

type MaterializableTask = {
  title: string;
  description: string;
  difficulty: Task["difficulty"];
  role?: Task["role"];
  acceptanceCriteria: string[];
  dependsOn: number[];
  scopePaths: string[];
  assignedModel?: Task["assignedModel"];
};

/** Shared by the legacy single-shot planner and B39's reviewed plan commit. */
export function materializeTasks(
  db: Db,
  project: Project,
  drafts: MaterializableTask[],
  settings: Settings,
): Task[] {
  const ids = drafts.map(() => crypto.randomUUID());
  return drafts.map((draft, index) =>
    repo.createTask(db, {
      id: ids[index]!,
      projectId: project.id,
      title: draft.title,
      description: draft.description,
      difficulty: draft.difficulty,
      status: draft.dependsOn.length === 0 ? "ready" : "backlog",
      dependsOn: draft.dependsOn.map((dependency) => ids[dependency]!).filter(Boolean),
      acceptanceCriteria: draft.acceptanceCriteria,
      assignedModel:
        draft.assignedModel ??
        pickAssignedModel(settings.routing, draft.difficulty, draft.role),
      role: draft.role,
      scopePaths: draft.scopePaths,
      attempts: 0,
      maxAttempts: project.config?.maxAttempts ?? 3,
    }),
  );
}

export interface PlanningCommitInput {
  revisionId: string;
  prdMarkdown?: string;
  tasks: DraftTask[];
  agentsMd?: string;
}

export interface PlanningGitPersistence {
  commitFiles(
    project: Project,
    files: RepositoryFileWrite[],
    message: string,
  ): Promise<void>;
}

export interface PlanningCommitDeps {
  git: PlanningGitPersistence;
  recordArchive?: typeof recordPlanCommit;
}

export interface PlanningCommitResult {
  revisionId: string;
  project: Project;
  tasks: Task[];
  /** Only the new batch; used for task.updated broadcasts without replaying history. */
  createdTasks: Task[];
  prdMarkdown: string;
  agentsMd?: string;
}

interface ActivePlanningCommit {
  revisionId: string;
  contentHash: string;
  promise: Promise<PlanningCommitResult>;
}

type StoredPlanningCommitResult = Omit<PlanningCommitResult, "createdTasks">;

const activePlanningCommits = new Map<string, ActivePlanningCommit>();

const REVISION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPlanningRevisionId(value: unknown): value is string {
  return typeof value === "string" && REVISION_ID_PATTERN.test(value);
}

function effectivePrd(project: Project, input: PlanningCommitInput): string {
  return input.prdMarkdown?.trim()
    ? input.prdMarkdown
    : (project.prd ?? `# ${project.name}\n`);
}

/** Versioned, property-order-independent representation of materialized input. */
export function planningContentHash(
  project: Project,
  input: PlanningCommitInput,
): string {
  const canonical = {
    version: 1,
    prdMarkdown: effectivePrd(project, input),
    tasks: input.tasks.map((task) => ({
      title: task.title,
      description: task.description,
      difficulty: task.difficulty,
      role: task.role ?? null,
      acceptanceCriteria: task.acceptanceCriteria,
      dependsOn: task.dependsOn,
      scopePaths: task.scopePaths,
      assignedModel: task.assignedModel,
      generatedTaskKind: task.generatedTaskKind ?? null,
    })),
    agentsMd: input.agentsMd ?? null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function replayStoredReceipt(
  receipt: repo.PlanningCommitReceipt,
): PlanningCommitResult {
  const stored = receipt.result as Partial<StoredPlanningCommitResult> | undefined;
  if (
    !stored ||
    stored.revisionId !== receipt.revisionId ||
    !stored.project ||
    !Array.isArray(stored.tasks) ||
    typeof stored.prdMarkdown !== "string"
  ) {
    throw new PlanningCommitError(
      "database",
      "successful planning receipt has an unreadable result",
    );
  }
  const responseIds = new Set(stored.tasks.map((task) => task.id));
  if (receipt.createdTaskIds.some((id) => !responseIds.has(id))) {
    throw new PlanningCommitError(
      "database",
      "successful planning receipt does not contain its created tasks",
    );
  }
  return {
    revisionId: stored.revisionId,
    project: stored.project,
    tasks: stored.tasks,
    createdTasks: [],
    prdMarkdown: stored.prdMarkdown,
    agentsMd: stored.agentsMd,
  };
}

function replayActiveResult(result: PlanningCommitResult): PlanningCommitResult {
  return { ...result, createdTasks: [] };
}

export function planningCommitInProgress(projectId: string): boolean {
  return activePlanningCommits.has(projectId);
}

/** A `planning` project is deliberately not startable: either persistence is
 * still in flight or a failed attempt retained its scratch for retry. */
export function planningPersistenceError(project: Project): string | null {
  return project.status === "planning"
    ? "planning artifacts are not durable yet — wait for the commit or retry it before starting"
    : null;
}

/**
 * B39's durability boundary:
 * 1. persist the exact incoming draft as retryable DB scratch and mark planning;
 * 2. await one atomic repository commit/push for PRD/AGENTS/CLAUDE;
 * 3. finalize the readable plan archive;
 * 4. create tasks, publish the PRD, clear scratch, and mark planned in one DB transaction.
 */
export function commitPlanningDraft(
  db: Db,
  project: Project,
  input: PlanningCommitInput,
  settings: Settings,
  plannerModel: string,
  mock: boolean,
  warn: (message: string) => void,
  deps: PlanningCommitDeps,
): Promise<PlanningCommitResult> {
  if (!isPlanningRevisionId(input.revisionId)) {
    return Promise.reject(
      new PlanningCommitError("revision", "a valid planning revisionId is required"),
    );
  }
  const contentHash = planningContentHash(project, input);
  const active = activePlanningCommits.get(project.id);
  if (active) {
    if (active.revisionId !== input.revisionId) {
      return Promise.reject(
        new PlanningCommitError("busy", "another planning revision is being committed"),
      );
    }
    if (active.contentHash !== contentHash) {
      return Promise.reject(
        new PlanningCommitError(
          "revision",
          "planning revisionId cannot be reused with changed content",
        ),
      );
    }
    return active.promise.then(replayActiveResult);
  }

  const promise = commitPlanningDraftOwned(
    db,
    project,
    input,
    contentHash,
    settings,
    plannerModel,
    mock,
    warn,
    deps,
  );
  activePlanningCommits.set(project.id, {
    revisionId: input.revisionId,
    contentHash,
    promise,
  });
  const clear = () => {
    if (activePlanningCommits.get(project.id)?.promise === promise) {
      activePlanningCommits.delete(project.id);
    }
  };
  void promise.then(clear, clear);
  return promise;
}

async function commitPlanningDraftOwned(
  db: Db,
  project: Project,
  input: PlanningCommitInput,
  contentHash: string,
  settings: Settings,
  plannerModel: string,
  mock: boolean,
  warn: (message: string) => void,
  deps: PlanningCommitDeps,
): Promise<PlanningCommitResult> {
  let replay: PlanningCommitResult | undefined;
  const prdMarkdown = effectivePrd(project, input);

  // This transaction completes before the first await, so every concurrent
  // Start path sees `planning`, the receipt is durable before Git, and the
  // exact edited draft is recoverable after repository/archive failure.
  try {
    db.transaction(() => {
      const receipt = repo.getPlanningCommitReceipt(
        db,
        project.id,
        input.revisionId,
      );
      if (receipt && receipt.contentHash !== contentHash) {
        throw new PlanningCommitError(
          "revision",
          "planning revisionId cannot be reused with changed content",
        );
      }
      if (receipt?.state === "successful") {
        replay = replayStoredReceipt(receipt);
        return;
      }

      const currentProject = repo.getProject(db, project.id);
      const currentRevision = repo.getPlanningSession(db, project.id).revisionId;
      if (!currentProject) {
        throw new PlanningCommitError("revision", "project no longer exists");
      }
      if (currentProject.status === "running") {
        throw new PlanningCommitError(
          "busy",
          "tasks are running — planning re-opens when the run finishes",
        );
      }
      if (currentRevision !== input.revisionId) {
        throw new PlanningCommitError(
          "revision",
          "planning revision is stale — reload the planning session",
        );
      }
      if (!receipt) {
        repo.createPendingPlanningCommit(
          db,
          project.id,
          input.revisionId,
          contentHash,
        );
      }
      repo.updateProject(db, project.id, { status: "planning" });
      if (!repo.savePlanningSessionForRevision(db, project.id, input.revisionId, {
        prd: prdMarkdown,
        draftTasks: input.tasks,
        agentsMd: input.agentsMd,
      })) {
        throw new PlanningCommitError(
          "revision",
          "planning revision is stale — reload the planning session",
        );
      }
    })();
  } catch (err) {
    if (err instanceof PlanningCommitError) throw err;
    throw new PlanningCommitError(
      "database",
      "could not save the retryable planning draft",
      err,
    );
  }
  if (replay) return replay;

  const files: RepositoryFileWrite[] = [
    {
      path: project.prdPath ?? "docs/PRD.md",
      content: prdMarkdown,
    },
  ];
  if (input.agentsMd?.trim()) {
    files.push(
      { path: "AGENTS.md", content: input.agentsMd },
      { path: "CLAUDE.md", content: "@AGENTS.md", ifMissing: true },
    );
  }

  try {
    await deps.git.commitFiles(
      project,
      files,
      "docs: persist Hoopedorc planning context",
    );
  } catch (err) {
    throw new PlanningCommitError(
      "repository",
      "planning files were not durably pushed; the draft was kept for retry",
      err,
    );
  }

  const archive: PlanSessionWriteResult = (deps.recordArchive ?? recordPlanCommit)(
    db,
    project,
    mock,
    input.tasks.length,
    plannerModel,
    warn,
  );
  if (!archive.ok) {
    throw new PlanningCommitError(
      "archive",
      `${archive.error}; the draft was kept for retry`,
    );
  }

  let created: Task[] = [];
  let storedResult: StoredPlanningCommitResult | undefined;
  try {
    db.transaction(() => {
      created = materializeTasks(db, project, input.tasks, settings);
      repo.updateProject(db, project.id, { status: "planned", prd: prdMarkdown });
      if (!repo.savePlanningSessionForRevision(db, project.id, input.revisionId, {
        messages: [],
        prd: null,
        draftTasks: null,
        agentsMd: null,
        verifiedFigmaReferences: null,
        sessionFile: null,
        revisionId: null,
      })) {
        throw new PlanningCommitError(
          "revision",
          "planning revision changed before finalization",
        );
      }
      storedResult = {
        revisionId: input.revisionId,
        project: repo.getProject(db, project.id)!,
        tasks: repo.getTasks(db, project.id),
        prdMarkdown,
        agentsMd: input.agentsMd,
      };
      if (!repo.completePlanningCommit(
        db,
        project.id,
        input.revisionId,
        contentHash,
        created.map((task) => task.id),
        storedResult,
      )) {
        throw new PlanningCommitError(
          "database",
          "planning receipt could not be finalized exactly once",
        );
      }
    })();
  } catch (err) {
    if (err instanceof PlanningCommitError && err.stage === "revision") throw err;
    throw new PlanningCommitError(
      "database",
      "planning files were pushed but task finalization failed; the draft was kept for retry",
      err,
    );
  }

  if (!storedResult) {
    throw new PlanningCommitError("database", "planning result was not finalized");
  }
  return {
    ...storedResult,
    createdTasks: created,
  };
}
