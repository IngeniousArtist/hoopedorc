import assert from "node:assert/strict";
import { test } from "node:test";
import type { DraftTask, VerifiedFigmaReference } from "@orc/types";
import { defaultSettings } from "./config";
import { ensureDocsTask } from "./docs-task";
import {
  ensureVisualQaTask,
  VISUAL_QA_TASK_TITLE,
} from "./visual-qa-task";

const desktop: VerifiedFigmaReference = {
  canonicalUrl:
    "https://www.figma.com/design/File123/Login?node-id=10-20",
  fileKey: "File123",
  nodeId: "10:20",
  name: "Login desktop",
  width: 1440,
  height: 900,
  verifiedModel: "claude",
  verifiedRunner: "claude-code",
  verifiedAt: "2026-07-23T12:00:00.000Z",
};

const mobile: VerifiedFigmaReference = {
  canonicalUrl:
    "https://www.figma.com/design/File123/Login?node-id=30-40",
  fileKey: "File123",
  nodeId: "30:40",
  name: "Login mobile error state",
  width: 390,
  height: 844,
  verifiedModel: "claude",
  verifiedRunner: "claude-code",
  verifiedAt: "2026-07-23T12:00:00.000Z",
};

const docs: DraftTask = {
  title: "Project documentation",
  description: "Document the completed project.",
  difficulty: "easy",
  role: "docs",
  acceptanceCriteria: ["README exists."],
  dependsOn: [],
  scopePaths: ["README.md", "docs/**"],
  assignedModel: "grok",
};

function implementationTasks(): DraftTask[] {
  return [
    {
      title: "Scaffold app",
      description: "Create the application and its real startup scripts.",
      difficulty: "easy",
      acceptanceCriteria: ["The app starts."],
      dependsOn: [],
      scopePaths: ["apps/web/**"],
      assignedModel: "deepseek-flash",
    },
    {
      title: "Build desktop login",
      description:
        `Implement ${desktop.canonicalUrl} at /login using the signed-out fixture.`,
      difficulty: "medium",
      role: "frontend",
      acceptanceCriteria: ["The signed-out desktop state works."],
      dependsOn: [0],
      scopePaths: ["apps/web/**"],
      assignedModel: "glm",
    },
    docs,
    {
      title: "Build mobile login error",
      description:
        `Implement ${mobile.canonicalUrl} at /login with the invalid-password fixture.`,
      difficulty: "medium",
      role: "frontend",
      acceptanceCriteria: ["The mobile error state works."],
      // A malformed planner ordering can put the standing docs task before a
      // later implementation task. F53 moves docs last and must not preserve
      // that dependency as a docs<->implementation cycle.
      dependsOn: [0, 2],
      scopePaths: ["apps/web/**"],
      assignedModel: "glm",
    },
  ];
}

test("F53: verified nodes insert one visual task after implementation and before docs", () => {
  const settings = defaultSettings();
  const withVisual = ensureVisualQaTask(
    implementationTasks(),
    [desktop, mobile],
    settings,
  );
  const output = ensureDocsTask(withVisual, docs);

  assert.deepEqual(
    output.map((task) => task.title),
    [
      "Scaffold app",
      "Build desktop login",
      "Build mobile login error",
      VISUAL_QA_TASK_TITLE,
      "Project documentation",
    ],
  );
  const visual = output[3]!;
  assert.equal(visual.role, "frontend");
  assert.equal(
    visual.assignedModel,
    settings.routing.byRole.frontend,
    "the default verified model is also the hard-task validator",
  );
  assert.deepEqual(visual.dependsOn, [0, 1, 2]);
  assert.deepEqual(output[2]!.dependsOn, [0]);
  assert.deepEqual(output[4]!.dependsOn, [0, 1, 2, 3]);
  assert.deepEqual(visual.scopePaths, ["apps/web/**"]);
  assert.match(visual.description, /Login desktop/);
  assert.match(visual.description, /1440×900 desktop-sized source/);
  assert.match(visual.description, /signed-out fixture/);
  assert.match(visual.description, /Login mobile error state/);
  assert.match(visual.description, /390×844 mobile-sized source/);
  assert.match(visual.description, /invalid-password fixture/);
  assert.equal(
    visual.acceptanceCriteria.filter((criterion) =>
      criterion.includes(desktop.canonicalUrl),
    ).length,
    1,
  );
  assert.equal(
    visual.acceptanceCriteria.filter((criterion) =>
      criterion.includes(mobile.canonicalUrl),
    ).length,
    1,
  );
  assert.equal(
    visual.acceptanceCriteria.some((criterion) =>
      /Do not claim mobile Figma fidelity/.test(criterion),
    ),
    false,
  );
});

test("F53: a desktop-only source never becomes a mobile fidelity claim", () => {
  const output = ensureVisualQaTask(
    implementationTasks().filter(
      (task) => task.title !== "Build mobile login error",
    ),
    [desktop],
    defaultSettings(),
  );
  const visual = output.find((task) => task.title === VISUAL_QA_TASK_TITLE)!;

  assert.ok(
    visual.acceptanceCriteria.some((criterion) =>
      /Do not claim mobile Figma fidelity/.test(criterion),
    ),
  );
  assert.ok(
    visual.acceptanceCriteria.some((criterion) =>
      /Each fidelity claim is limited/.test(criterion),
    ),
  );
});

test("F53: insertion is idempotent and no verified nodes remove the reserved task", () => {
  const settings = defaultSettings();
  const once = ensureVisualQaTask(
    implementationTasks(),
    [desktop],
    settings,
  );
  const twice = ensureVisualQaTask(once, [desktop], settings);

  assert.equal(
    twice.filter((task) => task.title === VISUAL_QA_TASK_TITLE).length,
    1,
  );
  assert.deepEqual(
    twice.find((task) => task.title === VISUAL_QA_TASK_TITLE)!.dependsOn,
    [0, 1, 2],
  );

  const withoutFigma = ensureVisualQaTask(twice, [], settings);
  assert.equal(
    withoutFigma.some((task) => task.title === VISUAL_QA_TASK_TITLE),
    false,
  );
  assert.ok(
    withoutFigma.every((task) =>
      task.dependsOn.every((dependency) => dependency < withoutFigma.length),
    ),
  );
});

test("F53: a disabled verifier model falls back to normal frontend routing", () => {
  const settings = defaultSettings();
  settings.models = settings.models.map((model) =>
    model.id === desktop.verifiedModel ? { ...model, enabled: false } : model,
  );
  const output = ensureVisualQaTask(
    implementationTasks(),
    [desktop],
    settings,
  );

  assert.equal(
    output.find((task) => task.title === VISUAL_QA_TASK_TITLE)!.assignedModel,
    settings.routing.byRole.frontend,
  );
});

test("F53: an enabled verified model is preferred when validation remains independent", () => {
  const settings = defaultSettings();
  settings.routing.validatorByDifficulty.hard = "deepseek-pro";
  const output = ensureVisualQaTask(
    implementationTasks(),
    [desktop],
    settings,
  );

  assert.equal(
    output.find((task) => task.title === VISUAL_QA_TASK_TITLE)!.assignedModel,
    desktop.verifiedModel,
  );
});
