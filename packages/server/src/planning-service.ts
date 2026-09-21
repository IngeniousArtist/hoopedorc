import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepositoryDescription } from "@orc/engine";
import type {
  PlanChatMessage,
  Project,
  RepositoryInspection,
  VerifiedFigmaReference,
} from "@orc/types";
import {
  runPlanner,
  runPlannerChat,
  runPlannerDeconstruct,
  type PlannerInvocationSink,
  type PlannerModel,
  type PlanOutput,
} from "./planner";
import { classifyRepository } from "./repository-inspection";

/**
 * VW01: the planning routes talk to one `PlanningService` chosen at the
 * server's composition boundary. Production wraps the real planner CLIs;
 * `MOCK=1` substitutes a deterministic implementation (`mock-planner.ts`)
 * that never spawns a CLI, contacts an MCP, or touches a repository. The
 * routes keep owning contract validation, revision guards, persistence,
 * plan-session archives, and response envelopes, so both services see the
 * same request handling.
 *
 * VW03: every planner call is preceded by `inspect`, which either yields the
 * repository facts the prompt is built on (existing codebase vs. empty
 * repository, branch, commit, stack) or fails with `RepositoryUnavailableError`.
 * There is no silent fallback to a temporary directory any more: the routes
 * report the failure and the operator retries.
 */
export interface PlanningOperationContext {
  project: Project;
  plannerModel: PlannerModel;
  /** The inspection the routes obtained from `inspect` for this call. */
  repository: RepositoryInspection;
  signal?: AbortSignal;
  onInvocation?: PlannerInvocationSink;
  onWarn?: (message: string) => void;
}

export interface PlanningChatInput extends PlanningOperationContext {
  messages: PlanChatMessage[];
  priorContext?: string;
  attachmentNames: string[];
}

export interface PlanningChatResult {
  reply: string;
  costUsd: number;
}

export interface PlanningDeconstructInput extends PlanningChatInput {
  cachedVerifiedFigmaReferences?: VerifiedFigmaReference[];
  onVerifiedFigmaReferences?: (references: VerifiedFigmaReference[]) => void;
  figmaVerification: "live" | "attachments";
}

export interface PlanningDeconstructResult {
  output: PlanOutput;
  costUsd: number;
  verifiedFigmaReferences?: VerifiedFigmaReference[];
}

export interface PlanningGoalInput extends PlanningOperationContext {
  goal: string;
}

export type PlanningServiceKind = "production" | "mock";

export interface PlanningService {
  readonly kind: PlanningServiceKind;
  /** Observe the repository a planner call would run against. */
  inspect(project: Project, signal?: AbortSignal): Promise<RepositoryInspection>;
  /** One conversational planning turn (`POST /plan/chat`). */
  chat(input: PlanningChatInput): Promise<PlanningChatResult>;
  /** Deconstruct an agreed conversation into a draft DAG (`POST /plan/deconstruct`). */
  deconstruct(input: PlanningDeconstructInput): Promise<PlanningDeconstructResult>;
  /** Legacy single-shot goal → PRD + DAG (`POST /plan`). */
  planGoal(input: PlanningGoalInput): Promise<PlanOutput>;
}

/** The Git capabilities production planning needs: a readable clone and its description. */
export interface PlanningRepositoryAccess {
  ensureClone(project: Project, signal?: AbortSignal): Promise<void>;
  describeRepository(
    project: Project,
    options?: { maxFiles?: number },
    signal?: AbortSignal,
  ): Promise<RepositoryDescription>;
}

/** The real CLI-backed planner functions; injectable so tests can prove the
 *  production wiring without a paid model call. */
export interface ProductionPlannerRunners {
  chat: typeof runPlannerChat;
  deconstruct: typeof runPlannerDeconstruct;
  plan: typeof runPlanner;
}

export interface ProductionPlanningOptions {
  git: PlanningRepositoryAccess;
  runners?: ProductionPlannerRunners;
  /** Reads the root package.json; injectable for tests. */
  readPackageJson?: (localPath: string) => Promise<unknown>;
  now?: () => Date;
}

const MAX_ERROR_DETAIL_CHARS = 300;

/** Bound and redact a Git/OS failure so it is safe to show in the UI. */
export function describeRepositoryFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = raw.split("\n").find((line) => line.trim().length > 0) ?? "unknown error";
  const redacted = firstLine.replace(/(\w+:\/\/)[^/@\s]+@/gu, "$1***@");
  return redacted.length > MAX_ERROR_DETAIL_CHARS
    ? `${redacted.slice(0, MAX_ERROR_DETAIL_CHARS - 1)}…`
    : redacted;
}

/**
 * The project's repository could not be cloned or read. Routes answer `503`
 * with `code: "REPOSITORY_UNAVAILABLE"`; the draft, transcript, and
 * attachments are untouched and the same request can simply be retried.
 */
export class RepositoryUnavailableError extends Error {
  override name = "RepositoryUnavailableError";
  readonly code = "REPOSITORY_UNAVAILABLE" as const;

  constructor(
    readonly projectId: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(
      `the project repository could not be reached or read (${detail}); ` +
        "planning did not run — fix access to the repository and retry",
      options,
    );
  }
}

async function readRootPackageJson(localPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(localPath, "package.json"), "utf8")) as unknown;
  } catch {
    // Missing or unparseable: not a Node manifest we can describe.
    return undefined;
  }
}

export function productionPlanningService(
  options: ProductionPlanningOptions,
): PlanningService {
  const runners: ProductionPlannerRunners = options.runners ?? {
    chat: runPlannerChat,
    deconstruct: runPlannerDeconstruct,
    plan: runPlanner,
  };
  const readPackageJson = options.readPackageJson ?? readRootPackageJson;
  const now = options.now ?? (() => new Date());

  return {
    kind: "production",
    async inspect(project, signal) {
      let description: RepositoryDescription;
      try {
        await options.git.ensureClone(project, signal);
        description = await options.git.describeRepository(project, undefined, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new RepositoryUnavailableError(project.id, describeRepositoryFailure(err), {
          cause: err,
        });
      }
      const packageJson = await readPackageJson(project.localPath);
      return classifyRepository(
        { ...description, packageJson, prdPath: project.prdPath },
        now().toISOString(),
      );
    },
    chat(input) {
      return runners.chat(
        input.messages,
        input.project.name,
        input.project.localPath,
        input.plannerModel,
        input.priorContext,
        input.attachmentNames,
        input.signal,
        input.onInvocation,
        input.repository,
      );
    },
    deconstruct(input) {
      return runners.deconstruct(
        input.messages,
        input.project.name,
        input.project.localPath,
        input.plannerModel,
        input.priorContext,
        input.attachmentNames,
        input.onWarn,
        input.signal,
        input.onInvocation,
        input.cachedVerifiedFigmaReferences,
        input.onVerifiedFigmaReferences,
        input.figmaVerification,
        input.repository,
      );
    },
    planGoal(input) {
      return runners.plan(
        input.goal,
        input.project.name,
        input.project.localPath,
        input.plannerModel,
        input.onWarn,
        input.signal,
        input.onInvocation,
        input.repository,
      );
    },
  };
}

/**
 * The composition decision, kept as one pure function so a test can prove
 * which side `env.mock` selects without booting either implementation.
 */
export function selectPlanningService(
  mock: boolean,
  factories: {
    production: () => PlanningService;
    mock: () => PlanningService;
  },
): PlanningService {
  return mock ? factories.mock() : factories.production();
}
