import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitOperationError, type RepositoryFileWrite } from "@orc/engine";
import type { DraftTask, Project } from "@orc/types";
import { defaultSettings } from "./config.js";
import { initDb, type Db } from "./db/index.js";
import * as repo from "./db/repo.js";
import {
  commitPlanningDraft,
  planningCommitInProgress,
  PlanningCommitError,
  planningPersistenceError,
} from "./planning-commit.js";

function fixture(): { db: Db; project: Project; draft: DraftTask } {
  const db = initDb(":memory:");
  const project = repo.createProject(db, {
    id: "p1",
    name: "Durable plan",
    repoUrl: "https://github.com/example/durable-plan",
    defaultBranch: "main",
    localPath: mkdtempSync(join(tmpdir(), "hoopedorc-planning-commit-")),
    status: "created",
  });
  repo.savePlanningSession(db, project.id, {
    messages: [{ role: "user", content: "build it" }],
    prd: "# Old draft",
    draftTasks: [],
    agentsMd: "# Old agents",
    sessionFile: "2026-07-14-1200.md",
  });
  const draft: DraftTask = {
    title: "Durable task",
    description: "Persist this task only after Git",
    difficulty: "medium",
    acceptanceCriteria: ["durable"],
    dependsOn: [],
    scopePaths: ["**/*"],
    assignedModel: "deepseek-flash",
  };
  return { db, project, draft };
}

test("B39: a delayed repository commit immediately blocks Start and finalizes only after push", async () => {
  const { db, project, draft } = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  let files: RepositoryFileWrite[] = [];
  const running = commitPlanningDraft(
    db,
    project,
    { prdMarkdown: "# Edited PRD", tasks: [draft], agentsMd: "# Edited agents" },
    defaultSettings(),
    "planner",
    true,
    () => {},
    {
      git: {
        async commitFiles(_project, pendingFiles) {
          started = true;
          files = pendingFiles;
          await gate;
        },
      },
      recordArchive: () => ({ ok: true }),
    },
  );

  assert.equal(started, true);
  assert.equal(planningCommitInProgress(project.id), true);
  const pending = repo.getProject(db, project.id)!;
  assert.equal(pending.status, "planning");
  assert.match(planningPersistenceError(pending) ?? "", /not durable yet/i);
  assert.equal(repo.getTasks(db, project.id).length, 0);
  assert.equal(repo.getPlanningSession(db, project.id).prd, "# Edited PRD");
  assert.deepEqual(files.map((file) => file.path), ["docs/PRD.md", "AGENTS.md", "CLAUDE.md"]);

  release();
  const committed = await running;
  assert.equal(planningCommitInProgress(project.id), false);
  assert.equal(committed.project.status, "planned");
  assert.equal(committed.tasks.length, 1);
  assert.equal(planningPersistenceError(committed.project), null);
  const cleared = repo.getPlanningSession(db, project.id);
  assert.deepEqual(cleared.messages, []);
  assert.equal(cleared.prd, undefined);
  assert.equal(cleared.draftTasks, undefined);
  assert.equal(cleared.agentsMd, undefined);
  assert.equal(cleared.sessionFile, undefined);
});

test("B39: repository failure keeps the exact draft and retry creates tasks once", async () => {
  const { db, project, draft } = fixture();
  let attempts = 0;
  const deps = {
    git: {
      async commitFiles() {
        attempts += 1;
        if (attempts === 1) {
          throw new GitOperationError("push", "simulated remote failure");
        }
      },
    },
    recordArchive: () => ({ ok: true } as const),
  };
  const input = {
    prdMarkdown: "# Retryable PRD",
    tasks: [draft],
    agentsMd: "# Retryable agents",
  };

  await assert.rejects(
    commitPlanningDraft(
      db,
      project,
      input,
      defaultSettings(),
      "planner",
      true,
      () => {},
      deps,
    ),
    (err: unknown) =>
      err instanceof PlanningCommitError &&
      err.stage === "repository" &&
      /draft was kept for retry/i.test(err.message),
  );
  assert.equal(repo.getProject(db, project.id)?.status, "planning");
  assert.equal(repo.getTasks(db, project.id).length, 0);
  assert.deepEqual(repo.getPlanningSession(db, project.id).draftTasks, [draft]);
  assert.equal(repo.getPlanningSession(db, project.id).agentsMd, "# Retryable agents");

  const retried = await commitPlanningDraft(
    db,
    repo.getProject(db, project.id)!,
    input,
    defaultSettings(),
    "planner",
    true,
    () => {},
    deps,
  );
  assert.equal(attempts, 2);
  assert.equal(retried.tasks.length, 1);
  assert.equal(repo.getTasks(db, project.id).length, 1, "retry must not duplicate tasks");
  const cleared = repo.getPlanningSession(db, project.id);
  assert.deepEqual(cleared.messages, []);
  assert.equal(cleared.prd, undefined);
  assert.equal(cleared.draftTasks, undefined);
  assert.equal(cleared.agentsMd, undefined);
  assert.equal(cleared.sessionFile, undefined);
});

test("B39: archive failure after Git success remains a visible, retryable partial commit", async () => {
  const { db, project, draft } = fixture();
  let archiveAttempts = 0;
  const deps = {
    git: { async commitFiles() {} },
    recordArchive: () => {
      archiveAttempts += 1;
      return archiveAttempts === 1
        ? { ok: false as const, error: "archive disk full" }
        : { ok: true as const };
    },
  };
  const input = { prdMarkdown: "# Archived PRD", tasks: [draft] };

  await assert.rejects(
    commitPlanningDraft(
      db,
      project,
      input,
      defaultSettings(),
      "planner",
      true,
      () => {},
      deps,
    ),
    (err: unknown) =>
      err instanceof PlanningCommitError && err.stage === "archive" && /disk full/.test(err.message),
  );
  assert.equal(repo.getTasks(db, project.id).length, 0);
  assert.equal(repo.getPlanningSession(db, project.id).prd, "# Archived PRD");

  const retried = await commitPlanningDraft(
    db,
    repo.getProject(db, project.id)!,
    input,
    defaultSettings(),
    "planner",
    true,
    () => {},
    deps,
  );
  assert.equal(retried.tasks.length, 1);
  assert.equal(archiveAttempts, 2);
});
