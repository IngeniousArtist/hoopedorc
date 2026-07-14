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

export type PlanningCommitStage = "busy" | "repository" | "archive" | "database";

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
  prdMarkdown?: string;
  tasks: DraftTask[];
  agentsMd?: string;
}

interface PlanningGitPersistence {
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
  project: Project;
  tasks: Task[];
  /** Only the new batch; used for task.updated broadcasts without replaying history. */
  createdTasks: Task[];
  prdMarkdown: string;
  agentsMd?: string;
}

const activePlanningCommits = new Set<string>();

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
export async function commitPlanningDraft(
  db: Db,
  project: Project,
  input: PlanningCommitInput,
  settings: Settings,
  plannerModel: string,
  mock: boolean,
  warn: (message: string) => void,
  deps: PlanningCommitDeps,
): Promise<PlanningCommitResult> {
  if (activePlanningCommits.has(project.id)) {
    throw new PlanningCommitError("busy", "another planning commit is already in progress");
  }
  activePlanningCommits.add(project.id);
  try {
    const prdMarkdown = input.prdMarkdown?.trim()
      ? input.prdMarkdown
      : (project.prd ?? `# ${project.name}\n`);

    // This transaction completes before the first await, so every concurrent
    // Start path immediately sees `planning` and the exact edited draft is
    // recoverable even when repository persistence fails.
    try {
      db.transaction(() => {
        repo.updateProject(db, project.id, { status: "planning" });
        repo.savePlanningSession(db, project.id, {
          prd: prdMarkdown,
          draftTasks: input.tasks,
          agentsMd: input.agentsMd,
        });
      })();
    } catch (err) {
      throw new PlanningCommitError(
        "database",
        "could not save the retryable planning draft",
        err,
      );
    }

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
    try {
      db.transaction(() => {
        created = materializeTasks(db, project, input.tasks, settings);
        repo.updateProject(db, project.id, { status: "planned", prd: prdMarkdown });
        repo.savePlanningSession(db, project.id, {
          messages: [],
          prd: null,
          draftTasks: null,
          agentsMd: null,
          sessionFile: null,
        });
      })();
    } catch (err) {
      throw new PlanningCommitError(
        "database",
        "planning files were pushed but task finalization failed; the draft was kept for retry",
        err,
      );
    }

    return {
      project: repo.getProject(db, project.id)!,
      tasks: repo.getTasks(db, project.id),
      createdTasks: created,
      prdMarkdown,
      agentsMd: input.agentsMd,
    };
  } finally {
    activePlanningCommits.delete(project.id);
  }
}
