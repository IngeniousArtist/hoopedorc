import {
  pickAssignedModel,
  type DraftTask,
  type Settings,
  type VerifiedFigmaReference,
} from "@orc/types";

export const VISUAL_QA_TASK_TITLE = "Visual fidelity QA";

function isVisualQaTask(task: Pick<DraftTask, "title">): boolean {
  return (
    task.title.trim().toLowerCase() === VISUAL_QA_TASK_TITLE.toLowerCase()
  );
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

function viewportLabel(reference: VerifiedFigmaReference): string {
  if (!reference.width || !reference.height) {
    return "dimensions unavailable — record the source viewport before capture";
  }
  const kind =
    reference.width <= 768
      ? "mobile-sized source"
      : reference.width >= 1024
        ? "desktop-sized source"
        : "supplied source";
  return `${reference.width}×${reference.height} ${kind}`;
}

function mobileReference(reference: VerifiedFigmaReference): boolean {
  return (
    (reference.width !== undefined && reference.width <= 768) ||
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
  const paths = sources.flatMap((task) => task.scopePaths);
  return paths.length > 0 ? [...new Set(paths)] : ["**/*"];
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
      ...(references.some(mobileReference)
        ? []
        : [
            "Do not claim mobile Figma fidelity: no distinct verified mobile-sized screen was supplied.",
          ]),
      "Run the repository gates and relevant browser tests after repairs; leave the task ready for the existing independent validator and merge policy.",
    ],
    dependsOn: [],
    scopePaths: visualQaScopes(tasks, references),
    assignedModel: visualQaModel(settings, references),
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
    .filter(({ task }) => !isVisualQaTask(task));
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
