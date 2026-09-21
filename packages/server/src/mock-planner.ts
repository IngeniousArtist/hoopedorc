import type {
  FigmaCapabilityIssueCode,
  PlanChatMessage,
  Project,
  RepositoryInspection,
  VerifiedFigmaReference,
} from "@orc/types";
import {
  extractFigmaReferences,
  normalizeVerifiedFigmaReferences,
  type FigmaNodeReferenceInput,
} from "./figma-references";
import {
  ensureVerifiedFigmaTaskHandoff,
  FigmaVerificationError,
  makeFigmaIssue,
  type PlannerModel,
  type PlanOutput,
} from "./planner";
import type {
  PlanningChatInput,
  PlanningChatResult,
  PlanningDeconstructInput,
  PlanningDeconstructResult,
  PlanningGoalInput,
  PlanningService,
} from "./planning-service";

/**
 * VW01: deterministic planning for `MOCK=1`. Every operation is computed from
 * the request alone — no CLI spawn, no MCP, no Git, no clock-dependent text
 * except the `verifiedAt` stamp the shared contract requires. The routes keep
 * their real validation, revision guards, persistence, and error envelopes;
 * this module only replaces the model behind them.
 *
 * Bounded guarantee: the mock flag isolates *planning* (chat, deconstruct,
 * legacy single-shot plan, and Figma verification). It says nothing about
 * setup checks, model tests, or other operations, which keep their own
 * documented behavior.
 *
 * Fixtures (all deterministic, all reachable from the Plan tab):
 * - A user message containing `[MOCK_PLANNER_FAIL]` makes chat, deconstruct,
 *   and the legacy plan call fail with `MockPlannerUnavailableError`, which
 *   the routes report through their existing 502 envelope.
 * - A Figma selection whose file key is `MOCKFAIL-<issue_code>` fails live
 *   verification with that typed capability issue (unknown codes become
 *   `figma_unavailable`); every other exact node verifies with fixed
 *   1440×900 metadata. The explicit attachment fallback behaves as in
 *   production: no verification, no fidelity claims.
 */
export const MOCK_PLANNER_FAILURE_TOKEN = "[MOCK_PLANNER_FAIL]";
export const MOCK_FIGMA_FAILURE_FILE_KEY_PREFIX = "MOCKFAIL-";
export const MOCK_PLANNER_REPLY_PREFIX =
  "Mock planner (no model, CLI, MCP, or repository was used).";
export const MOCK_FIGMA_FRAME_WIDTH = 1440;
export const MOCK_FIGMA_FRAME_HEIGHT = 900;
/** VW03: the fixed inspection mock planning reports; no Git is consulted. */
export const MOCK_REPOSITORY_COMMIT = "0000000000000000000000000000000000000000";
export const MOCK_REPOSITORY_STACK = ["node", "typescript"] as const;
export const MOCK_REPOSITORY_SCRIPTS = ["build", "lint", "test", "typecheck"] as const;

export function mockRepositoryInspection(
  project: Project,
  inspectedAt: string,
): RepositoryInspection {
  return {
    state: "existing",
    inspectedAt,
    branch: project.defaultBranch,
    commit: MOCK_REPOSITORY_COMMIT,
    trackedFileCount: 42,
    stack: [...MOCK_REPOSITORY_STACK],
    packageScripts: [...MOCK_REPOSITORY_SCRIPTS],
  };
}

const PLAN_COMPLETE_TOKEN = "[PLAN_COMPLETE]";
const MAX_BRIEF_CHARS = 160;
/** URLs make poor task titles, and a pasted Figma URL inside a description
 *  would make the shared handoff helper believe the task already cites the
 *  frame; verified references are attached by that helper instead. */
const URL_IN_BRIEF = /\bhttps?:\/\/[^\s<>"']+/giu;
const URL_PLACEHOLDER = "the referenced design";

const FIGMA_ISSUE_CODES: ReadonlySet<string> = new Set<FigmaCapabilityIssueCode>([
  "figma_invalid_node",
  "figma_reference_limit",
  "figma_mcp_missing",
  "figma_auth_required",
  "figma_access_denied",
  "figma_node_not_found",
  "figma_timeout",
  "figma_malformed_response",
  "figma_unavailable",
]);

export type MockPlannerOperation = "chat" | "deconstruct" | "plan";

/** Explicit, labeled failure — never a fall-through to real execution. */
export class MockPlannerUnavailableError extends Error {
  override name = "MockPlannerUnavailableError";

  constructor(readonly operation: MockPlannerOperation) {
    super(
      `mock planner ${operation} failure fixture requested with ${MOCK_PLANNER_FAILURE_TOKEN}; ` +
        "no real planner was invoked",
    );
  }
}

export interface MockPlanningOptions {
  /** Clock for `verifiedAt` stamps; injectable so tests stay byte-stable. */
  now?: () => Date;
}

function summarizeBrief(text: string): string {
  const line =
    text
      .replaceAll(MOCK_PLANNER_FAILURE_TOKEN, "")
      .replace(URL_IN_BRIEF, URL_PLACEHOLDER)
      .split("\n")
      .map((candidate) => candidate.replace(/\s+/gu, " ").trim())
      .find((candidate) => candidate.length > 0) ?? "";
  return line.length > MAX_BRIEF_CHARS
    ? `${line.slice(0, MAX_BRIEF_CHARS - 1)}…`
    : line;
}

function firstUserBrief(messages: PlanChatMessage[]): string {
  const first = messages.find((message) => message.role === "user");
  return summarizeBrief(first?.content ?? "");
}

function latestUserBrief(messages: PlanChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return summarizeBrief(message.content);
  }
  return "";
}

function failureRequested(messages: PlanChatMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      message.content.includes(MOCK_PLANNER_FAILURE_TOKEN),
  );
}

function failureCodeFor(node: FigmaNodeReferenceInput): FigmaCapabilityIssueCode | null {
  if (!node.fileKey.startsWith(MOCK_FIGMA_FAILURE_FILE_KEY_PREFIX)) return null;
  const requested = node.fileKey.slice(MOCK_FIGMA_FAILURE_FILE_KEY_PREFIX.length);
  return FIGMA_ISSUE_CODES.has(requested)
    ? (requested as FigmaCapabilityIssueCode)
    : "figma_unavailable";
}

/**
 * Deterministic stand-in for `verifyFigmaReferences`: the same fail-closed
 * normalization as production, fed fixed metadata instead of MCP output.
 */
export function mockVerifyFigmaReferences(
  requested: FigmaNodeReferenceInput[],
  plannerModel: PlannerModel,
  verifiedAt: string,
): VerifiedFigmaReference[] {
  for (const node of requested) {
    const code = failureCodeFor(node);
    if (code) {
      throw new FigmaVerificationError(makeFigmaIssue(code, plannerModel, node));
    }
  }
  const raw = requested.map((node, index) => ({
    index,
    nodeId: node.nodeId,
    name: `Mock frame ${node.nodeId}`,
    fileName: `Mock file ${node.fileKey}`,
    width: MOCK_FIGMA_FRAME_WIDTH,
    height: MOCK_FIGMA_FRAME_HEIGHT,
  }));
  const normalized = normalizeVerifiedFigmaReferences(
    requested,
    raw,
    plannerModel.id ?? plannerModel.model ?? "mock",
    plannerModel.runner,
    verifiedAt,
  );
  if (!normalized) {
    throw new FigmaVerificationError(
      makeFigmaIssue("figma_malformed_response", plannerModel, requested[0]),
    );
  }
  return normalized;
}

function reusableCachedReferences(
  requested: FigmaNodeReferenceInput[],
  plannerModel: PlannerModel,
  cached?: VerifiedFigmaReference[],
): VerifiedFigmaReference[] | null {
  if (!cached || cached.length !== requested.length) return null;
  const expectedModel = plannerModel.id ?? plannerModel.model ?? "mock";
  const matches = requested.every((node, index) => {
    const reference = cached[index];
    return (
      reference !== undefined &&
      reference.canonicalUrl === node.canonicalUrl &&
      reference.nodeId === node.nodeId &&
      reference.verifiedModel === expectedModel &&
      reference.verifiedRunner === plannerModel.runner
    );
  });
  return matches ? cached : null;
}

/** The deterministic PRD, guidance, and two-task DAG for one brief. */
export function buildMockPlanOutput(
  brief: string,
  projectName: string,
  options: { frontend?: boolean } = {},
): PlanOutput {
  const subject = brief || `the next change for ${projectName}`;
  const implement: PlanOutput["tasks"][number] = {
    title: `Implement: ${subject}`,
    description:
      `Implement the brief: ${subject}. Follow the project's existing conventions and keep ` +
      "the change scoped to what the brief requires. Generated by the mock planner.",
    difficulty: "medium",
    acceptanceCriteria: [
      `The change "${subject}" is implemented as described.`,
      "Existing repository checks continue to pass.",
    ],
    dependsOn: [],
    scopePaths: ["**/*"],
  };
  if (options.frontend) implement.role = "frontend";
  return {
    prdMarkdown: [
      `# PRD: ${projectName}`,
      "",
      MOCK_PLANNER_REPLY_PREFIX,
      "",
      "## Goal",
      subject,
      "",
      "## Acceptance",
      "- The change described in the brief is implemented.",
      "- Regression coverage exists for the change.",
      "",
    ].join("\n"),
    agentsMd: [
      "# AGENTS.md",
      "",
      MOCK_PLANNER_REPLY_PREFIX,
      "",
      `This guidance was generated by Hoopedorc's mock planner for "${projectName}".`,
      "Replace it with the project's real conventions before relying on it.",
      "",
    ].join("\n"),
    tasks: [
      implement,
      {
        title: `Add regression coverage: ${subject}`,
        description:
          `Add tests that fail before and pass after "${subject}" is implemented. ` +
          "Generated by the mock planner.",
        difficulty: "easy",
        acceptanceCriteria: [
          "New tests cover the implemented behavior.",
          "The test suite passes.",
        ],
        dependsOn: [0],
        scopePaths: ["**/*"],
      },
    ],
  };
}

export function buildMockChatReply(input: PlanningChatInput): string {
  const brief = latestUserBrief(input.messages);
  if (!brief) {
    return [
      MOCK_PLANNER_REPLY_PREFIX,
      "",
      "Describe what to build and I will propose a small dependency-ordered task list.",
    ].join("\n");
  }
  const intake = extractFigmaReferences(input.messages);
  const lines = [
    MOCK_PLANNER_REPLY_PREFIX,
    "",
    `Brief: ${brief}`,
    "",
    "Proposed tasks:",
    `1. Implement: ${brief}`,
    `2. Add regression coverage: ${brief}`,
  ];
  if (input.attachmentNames.length > 0) {
    lines.push("", `Attached context files: ${input.attachmentNames.join(", ")}`);
  }
  if (input.priorContext) {
    lines.push(
      "",
      "Prior project context was supplied; this is planned as a follow-up iteration.",
    );
  }
  lines.push(
    "",
    `Repository: ${input.repository.branch ?? "unknown branch"} @ ${(input.repository.commit ?? "unknown").slice(0, 7)} — ` +
      (input.repository.state === "empty"
        ? "empty repository; the first task will scaffold it."
        : `existing codebase (${input.repository.stack.join(", ") || "stack not detected"}).`),
  );
  if (intake.nodes.length > 0) {
    lines.push(
      "",
      `Figma selections noted: ${intake.nodes.length}. Deconstruction verifies them with ` +
        "the mock verifier; no Figma MCP is contacted.",
    );
  }
  if (intake.invalidNodeCount > 0) {
    lines.push(
      "",
      "At least one Figma link has an invalid node-id; deconstruction will reject it.",
    );
  }
  lines.push("", PLAN_COMPLETE_TOKEN);
  return lines.join("\n");
}

function settle<T>(work: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      resolve(work());
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function mockChat(input: PlanningChatInput): PlanningChatResult {
  if (failureRequested(input.messages)) {
    throw new MockPlannerUnavailableError("chat");
  }
  return { reply: buildMockChatReply(input), costUsd: 0 };
}

function mockDeconstruct(
  input: PlanningDeconstructInput,
  now: () => Date,
): PlanningDeconstructResult {
  if (failureRequested(input.messages)) {
    throw new MockPlannerUnavailableError("deconstruct");
  }
  const intake = extractFigmaReferences(input.messages);
  const useAttachmentFallback =
    input.figmaVerification === "attachments" &&
    (intake.nodes.length > 0 || intake.invalidNodeCount > 0);
  if (!useAttachmentFallback && intake.overLimit) {
    throw new FigmaVerificationError(
      makeFigmaIssue("figma_reference_limit", input.plannerModel),
    );
  }
  if (!useAttachmentFallback && intake.invalidNodeCount > 0) {
    throw new FigmaVerificationError(
      makeFigmaIssue("figma_invalid_node", input.plannerModel),
    );
  }

  let verifiedFigmaReferences: VerifiedFigmaReference[] | undefined;
  if (intake.nodes.length > 0 && !useAttachmentFallback) {
    const cached = reusableCachedReferences(
      intake.nodes,
      input.plannerModel,
      input.cachedVerifiedFigmaReferences,
    );
    if (cached) {
      verifiedFigmaReferences = cached;
    } else {
      verifiedFigmaReferences = mockVerifyFigmaReferences(
        intake.nodes,
        input.plannerModel,
        now().toISOString(),
      );
      input.onVerifiedFigmaReferences?.(verifiedFigmaReferences);
    }
  }

  const output = buildMockPlanOutput(
    firstUserBrief(input.messages),
    input.project.name,
    { frontend: intake.nodes.length > 0 },
  );
  return {
    output: verifiedFigmaReferences
      ? ensureVerifiedFigmaTaskHandoff(output, verifiedFigmaReferences)
      : output,
    costUsd: 0,
    verifiedFigmaReferences,
  };
}

function mockPlanGoal(input: PlanningGoalInput): PlanOutput {
  if (input.goal.includes(MOCK_PLANNER_FAILURE_TOKEN)) {
    throw new MockPlannerUnavailableError("plan");
  }
  return buildMockPlanOutput(summarizeBrief(input.goal), input.project.name);
}

export function mockPlanningService(
  options: MockPlanningOptions = {},
): PlanningService {
  const now = options.now ?? (() => new Date());
  return {
    kind: "mock",
    inspect(project) {
      return Promise.resolve(mockRepositoryInspection(project, now().toISOString()));
    },
    chat(input) {
      return settle(() => mockChat(input));
    },
    deconstruct(input) {
      return settle(() => mockDeconstruct(input, now));
    },
    planGoal(input) {
      return settle(() => mockPlanGoal(input));
    },
  };
}
