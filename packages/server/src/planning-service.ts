import { tmpdir } from "node:os";
import type { PlanChatMessage, Project, VerifiedFigmaReference } from "@orc/types";
import {
  runPlanner,
  runPlannerChat,
  runPlannerDeconstruct,
  type PlannerInvocationSink,
  type PlannerModel,
  type PlanOutput,
} from "./planner";

/**
 * VW01: the planning routes talk to one `PlanningService` chosen at the
 * server's composition boundary. Production wraps the real planner CLIs;
 * `MOCK=1` substitutes a deterministic implementation (`mock-planner.ts`)
 * that never spawns a CLI, contacts an MCP, or touches a repository. The
 * routes keep owning contract validation, revision guards, persistence,
 * plan-session archives, and response envelopes, so both services see the
 * same request handling.
 */
export interface PlanningOperationContext {
  project: Project;
  plannerModel: PlannerModel;
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
  /** One conversational planning turn (`POST /plan/chat`). */
  chat(input: PlanningChatInput): Promise<PlanningChatResult>;
  /** Deconstruct an agreed conversation into a draft DAG (`POST /plan/deconstruct`). */
  deconstruct(input: PlanningDeconstructInput): Promise<PlanningDeconstructResult>;
  /** Legacy single-shot goal → PRD + DAG (`POST /plan`). */
  planGoal(input: PlanningGoalInput): Promise<PlanOutput>;
}

/** The only Git capability production planning needs: a readable clone. */
export interface PlanningRepositoryAccess {
  ensureClone(project: Project): Promise<void>;
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
  /** Working directory when the clone cannot be reached (default: tmpdir). */
  fallbackCwd?: () => string;
}

/**
 * Resolve the working directory for a production planning call. Clones the
 * project's repo on first use (it already exists on GitHub by the time
 * planning runs — see createGithubRepo at project creation) so the planner
 * CLI runs inside the real codebase and can read existing files with its
 * built-in tools instead of planning blind in an empty tmp dir. Falls back
 * to `fallbackCwd()` so planning never hard-fails if the clone can't be
 * reached (e.g. offline). VW03 owns making that fallback visible instead of
 * silent; this module only moves the existing behavior behind the boundary.
 */
export async function resolvePlannerCwd(
  project: Project,
  git: PlanningRepositoryAccess,
  fallbackCwd: () => string = tmpdir,
): Promise<string> {
  try {
    await git.ensureClone(project);
    return project.localPath;
  } catch {
    return fallbackCwd();
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
  const cwdFor = (project: Project) =>
    resolvePlannerCwd(project, options.git, options.fallbackCwd);

  return {
    kind: "production",
    async chat(input) {
      const cwd = await cwdFor(input.project);
      return runners.chat(
        input.messages,
        input.project.name,
        cwd,
        input.plannerModel,
        input.priorContext,
        input.attachmentNames,
        input.signal,
        input.onInvocation,
      );
    },
    async deconstruct(input) {
      const cwd = await cwdFor(input.project);
      return runners.deconstruct(
        input.messages,
        input.project.name,
        cwd,
        input.plannerModel,
        input.priorContext,
        input.attachmentNames,
        input.onWarn,
        input.signal,
        input.onInvocation,
        input.cachedVerifiedFigmaReferences,
        input.onVerifiedFigmaReferences,
        input.figmaVerification,
      );
    },
    async planGoal(input) {
      const cwd = await cwdFor(input.project);
      return runners.plan(
        input.goal,
        input.project.name,
        cwd,
        input.plannerModel,
        input.onWarn,
        input.signal,
        input.onInvocation,
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
