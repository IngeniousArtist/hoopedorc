import {
  pickAssignedModel,
  type DraftTask,
  type Settings,
  type VerifiedFigmaReference,
} from "@orc/types";

export const VISUAL_QA_TASK_TITLE = "Visual fidelity QA";

/**
 * B47: ownership is the typed `generatedTaskKind` marker, never the
 * (user-editable, LLM-proposable) title text — a planner/user task that
 * happens to share this exact title is a different task and must survive a
 * fresh deconstruction pass untouched.
 */
function isGeneratedVisualQaTask(
  task: Pick<DraftTask, "generatedTaskKind">,
): boolean {
  return task.generatedTaskKind === "visual-qa";
}

function containsReference(
  task: DraftTask,
  reference: VerifiedFigmaReference,
): boolean {
  return (
    task.description.includes(reference.canonicalUrl) ||
    task.acceptanceCriteria.some((criterion) =>
      criterion.includes(reference.canonicalUrl),
    )
  );
}

function compact(value: string, max = 600): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function implementationContext(
  tasks: DraftTask[],
  reference: VerifiedFigmaReference,
): { labels: string; detail: string } {
  const matching = tasks.filter(
    (task) => task.role !== "docs" && containsReference(task, reference),
  );
  const sources =
    matching.length > 0
      ? matching
      : tasks.filter((task) => task.role === "frontend");
  if (sources.length === 0) {
    return {
      labels: "the completed implementation",
      detail:
        "Inspect the real app and PRD to determine and record the exact route, auth/data state, interaction state, and fixture before capturing.",
    };
  }

  return {
    labels: sources
      .slice(0, 3)
      .map((task) => `"${task.title}"`)
      .join(", "),
    detail: sources
      .slice(0, 2)
      .map((task) =>
        compact(
          [
            task.description,
            ...task.acceptanceCriteria.filter(
              (criterion) => !criterion.includes(reference.canonicalUrl),
            ),
          ].join(" "),
        ),
      )
      .join(" | "),
  };
}

type ViewportClass = "phone" | "tablet" | "desktop" | "unknown";

// B47: mirrors AGENTS.md's own responsive verification widths (360/390
// phone, 768 tablet, 1280/1440 desktop) — 768 must classify as tablet, never
// as proof of phone fidelity.
const PHONE_MAX_WIDTH = 599;
const TABLET_MAX_WIDTH = 1023;

function classifyViewport(reference: VerifiedFigmaReference): ViewportClass {
  if (!reference.width) return "unknown";
  if (reference.width <= PHONE_MAX_WIDTH) return "phone";
  if (reference.width <= TABLET_MAX_WIDTH) return "tablet";
  return "desktop";
}

function viewportLabel(reference: VerifiedFigmaReference): string {
  if (!reference.width || !reference.height) {
    return "dimensions unavailable — record the source viewport before capture";
  }
  const kind = classifyViewport(reference);
  const kindLabel =
    kind === "phone"
      ? "phone-sized source"
      : kind === "tablet"
        ? "tablet-sized source"
        : "desktop-sized source";
  return `${reference.width}×${reference.height} ${kindLabel}`;
}

function phoneReference(reference: VerifiedFigmaReference): boolean {
  return (
    classifyViewport(reference) === "phone" ||
    /\b(?:mobile|phone|iphone|android)\b/iu.test(reference.name)
  );
}

function visualQaModel(
  settings: Settings,
  references: VerifiedFigmaReference[],
) {
  const validator = settings.routing.validatorByDifficulty.hard;
  const verified = references
    .map((reference) => reference.verifiedModel)
    .find((modelId) =>
      settings.models.some(
        (model) =>
          model.id === modelId &&
          model.enabled &&
          model.id !== validator,
      ),
    );
  return (
    verified ??
    pickAssignedModel(settings.routing, "hard", "frontend")
  );
}

// B47: the task's own acceptance criteria require it to add/update
// real-browser coverage (Playwright/e2e specs, fixtures) and to actually
// start the app (startup/build scripts, framework config) — paths that sit
// outside whatever implementation task(s) it references. Included
// unconditionally alongside the matched implementation scope rather than
// only as a last-resort fallback, since the task always needs these
// regardless of match quality, and kept far narrower than "**/*".
const VISUAL_QA_SUPPORT_GLOBS = [
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/e2e/**",
  "**/tests/**",
  "**/test/**",
  "**/fixtures/**",
  "**/playwright.config.*",
  "**/vitest.config.*",
  "**/jest.config.*",
  "package.json",
];

function visualQaScopes(
  tasks: DraftTask[],
  references: VerifiedFigmaReference[],
): string[] {
  const matched = tasks.filter(
    (task) =>
      task.role !== "docs" &&
      references.some((reference) => containsReference(task, reference)),
  );
  const sources =
    matched.length > 0
      ? matched
      : tasks.filter((task) => task.role === "frontend");
  const implementationPaths = sources.flatMap((task) => task.scopePaths);
  return [...new Set([...implementationPaths, ...VISUAL_QA_SUPPORT_GLOBS])];
}

function buildVisualQaTask(
  tasks: DraftTask[],
  references: VerifiedFigmaReference[],
  settings: Settings,
): DraftTask {
  const screenMatrix = references
    .map((reference) => {
      const context = implementationContext(tasks, reference);
      return (
        `- **${reference.name}** — ${reference.canonicalUrl}\n` +
        `  - Source viewport: ${viewportLabel(reference)}\n` +
        `  - Implementation handoff: ${context.labels}\n` +
        `  - Route/state/fixture context: ${context.detail}`
      );
    })
    .join("\n");

  const referenceList = references
    .map((reference) => `${reference.name} — ${reference.canonicalUrl}`)
    .join("\n- ");

  const perScreenCriteria = references.map((reference) => {
    const context = implementationContext(tasks, reference);
    const viewport =
      reference.width && reference.height
        ? `at ${reference.width}×${reference.height}`
        : "at the source viewport recorded before capture";
    return (
      `${reference.name}: start the real app, reproduce the route/auth/data/interaction state ` +
      `from ${context.labels}, capture it ${viewport}, compare it with ` +
      `${reference.canonicalUrl}, and repair material layout, typography, spacing, color, ` +
      `component, and state differences.`
    );
  });

  return {
    title: VISUAL_QA_TASK_TITLE,
    description:
      "Run a real-browser visual-fidelity pass after implementation is complete. Use the " +
      "repository's actual scripts to start the app, inspect the implemented route and state " +
      "for every verified screen below, capture at the supplied source viewport, compare " +
      "against the exact Figma node, and repair material differences before running the normal " +
      "project gates. Do not stop at a written critique: make the smallest reusable frontend " +
      "fixes and add or update browser coverage for the exercised routes/states. If the app " +
      "cannot start or browser automation is unavailable, stop and report the exact failing " +
      "command/error; never claim that a comparison ran.\n\n" +
      `### Screen/state matrix\n${screenMatrix}\n\n` +
      `### Relevant references\n- ${referenceList}\n\n` +
      "### Required skills/capabilities\n" +
      "- Figma MCP/tool access — reopen every exact node instead of relying on URL text\n" +
      "- Real browser automation or the repository's Playwright/browser tooling — exercise " +
      "the running application, not a static approximation\n" +
      "- Screenshot comparison and frontend repair — capture evidence, compare material " +
      "differences, implement fixes, and rerun the affected checks",
    difficulty: "hard",
    role: "frontend",
    acceptanceCriteria: [
      ...perScreenCriteria,
      "Use only real startup/build/test commands present in the repository; record an actionable failure instead of inventing a command or claiming an unavailable browser ran.",
      "Each fidelity claim is limited to its listed verified node and source viewport; responsive behavior may be tested separately but is not presented as Figma fidelity without a matching verified frame.",
      ...(references.some(phoneReference)
        ? []
        : [
            "Do not claim phone Figma fidelity: no distinct verified phone-sized screen was supplied (a tablet-sized reference does not prove phone fidelity).",
          ]),
      "Run the repository gates and relevant browser tests after repairs; leave the task ready for the existing independent validator and merge policy.",
    ],
    dependsOn: [],
    scopePaths: visualQaScopes(tasks, references),
    assignedModel: visualQaModel(settings, references),
    generatedTaskKind: "visual-qa",
  };
}

/**
 * F53: reserve one deterministic visible draft task for real-browser Figma
 * comparison. This runs only while assembling a fresh deconstruction response;
 * save-draft and commit intentionally do not call it, so removing the task in
 * Plan review remains an explicit opt-out.
 */
export function ensureVisualQaTask(
  tasks: DraftTask[],
  references: VerifiedFigmaReference[],
  settings: Settings,
): DraftTask[] {
  const retained = tasks
    .map((task, oldIndex) => ({ task, oldIndex }))
    .filter(({ task }) => !isGeneratedVisualQaTask(task));
  const insert = references.length > 0;
  const ordered = insert
    ? [
        ...retained.filter(({ task }) => task.role !== "docs"),
        ...retained.filter(({ task }) => task.role === "docs"),
      ]
    : retained;
  const firstDocsIndex = ordered.findIndex(
    ({ task }) => task.role === "docs",
  );
  const insertionIndex =
    insert && firstDocsIndex !== -1 ? firstDocsIndex : ordered.length;

  const oldToNew = new Map<number, number>();
  ordered.forEach(({ oldIndex }, index) => {
    oldToNew.set(
      oldIndex,
      insert && index >= insertionIndex ? index + 1 : index,
    );
  });
  const remapped = ordered.map(({ task }) => ({
    ...task,
    dependsOn: task.dependsOn
      .filter(
        (dependency) =>
          !insert ||
          task.role === "docs" ||
          tasks[dependency]?.role !== "docs",
      )
      .map((dependency) => oldToNew.get(dependency))
      .filter((dependency): dependency is number => dependency !== undefined),
  }));

  if (!insert) return remapped;

  const visualTask = buildVisualQaTask(
    ordered.map(({ task }) => task),
    references,
    settings,
  );
  visualTask.dependsOn = remapped.flatMap((task, index) =>
    task.role === "docs"
      ? []
      : [index >= insertionIndex ? index + 1 : index],
  );

  return [
    ...remapped.slice(0, insertionIndex),
    visualTask,
    ...remapped.slice(insertionIndex),
  ];
}
