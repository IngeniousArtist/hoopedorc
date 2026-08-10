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

function fixture(): {
  db: Db;
  project: Project;
  draft: DraftTask;
  revisionId: string;
} {
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
    verifiedFigmaReferences: [
      {
        canonicalUrl:
          "https://www.figma.com/design/File123/Login?node-id=10-20",
        fileKey: "File123",
        nodeId: "10:20",
        name: "Login desktop",
        verifiedModel: "codex",
        verifiedRunner: "codex",
        verifiedAt: "2026-07-23T12:00:00.000Z",
      },
    ],
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
  return {
    db,
    project,
    draft,
    revisionId: repo.ensurePlanningRevision(db, project.id),
  };
}

test("B39: a delayed repository commit immediately blocks Start and finalizes only after push", async () => {
  const { db, project, draft, revisionId } = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  let files: RepositoryFileWrite[] = [];
  const running = commitPlanningDraft(
    db,
    project,
    {
      revisionId,
      prdMarkdown: "# Edited PRD",
      tasks: [draft],
      agentsMd: "# Edited agents",
    },
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
  assert.equal(cleared.verifiedFigmaReferences, undefined);
  assert.equal(cleared.sessionFile, undefined);
});

test("B39: repository failure keeps the exact draft and retry creates tasks once", async () => {
  const { db, project, draft, revisionId } = fixture();
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
    revisionId,
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
  assert.equal(
    repo.getPlanningSession(db, project.id).verifiedFigmaReferences?.[0]?.nodeId,
    "10:20",
  );

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
  assert.equal(cleared.verifiedFigmaReferences, undefined);
  assert.equal(cleared.sessionFile, undefined);
});

test("B39: archive failure after Git success remains a visible, retryable partial commit", async () => {
  const { db, project, draft, revisionId } = fixture();
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
  const input = { revisionId, prdMarkdown: "# Archived PRD", tasks: [draft] };

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

test("O3: successful receipt survives restart and replays original task ids without effects", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "hoopedorc-o3-restart-")), "orc.db");
  let db = initDb(path);
  const project = repo.createProject(db, {
    id: "restart-project",
    name: "Restart receipt",
    repoUrl: "https://github.com/example/restart-receipt",
    defaultBranch: "main",
    localPath: mkdtempSync(join(tmpdir(), "hoopedorc-o3-repo-")),
    status: "created",
  });
  const revisionId = repo.ensurePlanningRevision(db, project.id);
  const draft: DraftTask = {
    title: "Only once",
    description: "A lost response must not duplicate this",
    difficulty: "medium",
    acceptanceCriteria: ["one id"],
    dependsOn: [],
    scopePaths: ["**/*"],
    assignedModel: "deepseek-flash",
  };
  const input = { revisionId, prdMarkdown: "# Restart", tasks: [draft] };
  let gitCalls = 0;
  let archiveCalls = 0;
  const deps = {
    git: {
      commitFiles() {
        gitCalls += 1;
        return Promise.resolve();
      },
    },
    recordArchive: () => {
      archiveCalls += 1;
      return { ok: true as const };
    },
  };

  const first = await commitPlanningDraft(
    db,
    project,
    input,
    defaultSettings(),
    "planner",
    true,
    () => {},
    deps,
  );
  const createdIds = first.createdTasks.map((task) => task.id);
  assert.equal(createdIds.length, 1);
  db.close();

  db = initDb(path);
  const replayed = await commitPlanningDraft(
    db,
    repo.getProject(db, project.id)!,
    input,
    defaultSettings(),
    "planner",
    true,
    () => {},
    deps,
  );
  assert.deepEqual(replayed.tasks.map((task) => task.id), createdIds);
  assert.deepEqual(replayed.createdTasks, [], "replay must emit no task broadcasts");
  assert.equal(repo.getTasks(db, project.id).length, 1);
  assert.equal(gitCalls, 1);
  assert.equal(archiveCalls, 1);
  db.close();
});

test("O3: concurrent matching submissions share one owner and one replayable result", async () => {
  const { db, project, draft, revisionId } = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let gitCalls = 0;
  let archiveCalls = 0;
  const deps = {
    git: {
      async commitFiles() {
        gitCalls += 1;
        await gate;
      },
    },
    recordArchive: () => {
      archiveCalls += 1;
      return { ok: true as const };
    },
  };
  const input = { revisionId, prdMarkdown: "# Concurrent", tasks: [draft] };

  const owner = commitPlanningDraft(
    db,
    project,
    input,
    defaultSettings(),
    "planner",
    true,
    () => {},
    deps,
  );
  const follower = commitPlanningDraft(
    db,
    project,
    input,
    defaultSettings(),
    "planner",
    true,
    () => {},
    deps,
  );
  release();
  const [owned, replayed] = await Promise.all([owner, follower]);

  assert.equal(gitCalls, 1);
  assert.equal(archiveCalls, 1);
  assert.equal(owned.createdTasks.length, 1);
  assert.deepEqual(replayed.createdTasks, []);
  assert.deepEqual(
    replayed.tasks.map((task) => task.id),
    owned.tasks.map((task) => task.id),
  );
});

test("O3: changed content is refused but a new revision may reuse identical content", async () => {
  const { db, project, draft, revisionId } = fixture();
  let gitCalls = 0;
  const deps = {
    git: {
      commitFiles() {
        gitCalls += 1;
        return Promise.resolve();
      },
    },
    recordArchive: () => ({ ok: true as const }),
  };
  const input = { revisionId, prdMarkdown: "# Same content", tasks: [draft] };
  await commitPlanningDraft(
    db,
    project,
    input,
    defaultSettings(),
    "planner",
    true,
    () => {},
    deps,
  );

  await assert.rejects(
    commitPlanningDraft(
      db,
      repo.getProject(db, project.id)!,
      {
        ...input,
        tasks: [{ ...draft, description: "changed after receipt reservation" }],
      },
      defaultSettings(),
      "planner",
      true,
      () => {},
      deps,
    ),
    (err: unknown) =>
      err instanceof PlanningCommitError &&
      err.stage === "revision" &&
      /changed content/i.test(err.message),
  );
  assert.equal(gitCalls, 1);
  assert.equal(repo.getTasks(db, project.id).length, 1);

  const nextRevision = repo.ensurePlanningRevision(db, project.id);
  assert.notEqual(nextRevision, revisionId);
  const second = await commitPlanningDraft(
    db,
    repo.getProject(db, project.id)!,
    { ...input, revisionId: nextRevision },
    defaultSettings(),
    "planner",
    true,
    () => {},
    deps,
  );
  assert.equal(second.createdTasks.length, 1);
  assert.equal(repo.getTasks(db, project.id).length, 2);
  assert.equal(gitCalls, 2);
});

test("O3: failure before Git rolls back reservation and remains retryable", async () => {
  const { db, project, draft, revisionId } = fixture();
  let gitCalls = 0;
  const deps = {
    git: {
      commitFiles() {
        gitCalls += 1;
        return Promise.resolve();
      },
    },
    recordArchive: () => ({ ok: true as const }),
  };
  db.exec(`
    CREATE TRIGGER fail_o3_reservation
    BEFORE INSERT ON planning_commits
    BEGIN
      SELECT RAISE(ABORT, 'reservation unavailable');
    END
  `);

  await assert.rejects(
    commitPlanningDraft(
      db,
      project,
      { revisionId, prdMarkdown: "# Pre-Git", tasks: [draft] },
      defaultSettings(),
      "planner",
      true,
      () => {},
      deps,
    ),
    (err: unknown) =>
      err instanceof PlanningCommitError &&
      err.stage === "database" &&
      /reservation unavailable/i.test(err.message),
  );
  assert.equal(gitCalls, 0);
  assert.equal(repo.getTasks(db, project.id).length, 0);
  assert.equal(repo.getPlanningCommitReceipt(db, project.id, revisionId), undefined);

  db.exec("DROP TRIGGER fail_o3_reservation");
  const retried = await commitPlanningDraft(
    db,
    repo.getProject(db, project.id)!,
    { revisionId, prdMarkdown: "# Pre-Git", tasks: [draft] },
    defaultSettings(),
    "planner",
    true,
    () => {},
    deps,
  );
  assert.equal(retried.createdTasks.length, 1);
  assert.equal(gitCalls, 1);
});

test("O3: finalization failure rolls back tasks and keeps the pending receipt retryable", async () => {
  const { db, project, draft, revisionId } = fixture();
  let gitCalls = 0;
  let archiveCalls = 0;
  const deps = {
    git: {
      commitFiles() {
        gitCalls += 1;
        return Promise.resolve();
      },
    },
    recordArchive: () => {
      archiveCalls += 1;
      return { ok: true as const };
    },
  };
  db.exec(`
    CREATE TRIGGER fail_o3_finalization
    BEFORE UPDATE OF state ON planning_commits
    WHEN NEW.state = 'successful'
    BEGIN
      SELECT RAISE(ABORT, 'finalization unavailable');
    END
  `);
  const input = { revisionId, prdMarkdown: "# Finalize", tasks: [draft] };

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
      err.stage === "database" &&
      /finalization unavailable/i.test(err.message),
  );
  assert.equal(repo.getTasks(db, project.id).length, 0);
  assert.equal(repo.getProject(db, project.id)?.status, "planning");
  assert.equal(repo.getPlanningSession(db, project.id).revisionId, revisionId);
  assert.equal(
    repo.getPlanningCommitReceipt(db, project.id, revisionId)?.state,
    "pending",
  );

  db.exec("DROP TRIGGER fail_o3_finalization");
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
  assert.equal(retried.createdTasks.length, 1);
  assert.equal(repo.getTasks(db, project.id).length, 1);
  assert.equal(gitCalls, 2);
  assert.equal(archiveCalls, 2);
});
