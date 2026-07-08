import assert from "node:assert/strict";
import { test } from "node:test";
import { initDb } from "./index.js";
import * as repo from "./repo.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function setup() {
  const db = initDb(":memory:");
  repo.createProject(db, {
    id: "proj-1",
    name: "P",
    repoUrl: "https://github.com/x/y",
    defaultBranch: "main",
    localPath: "/tmp/x",
    status: "running",
  });
  return db;
}

/** Creates a real notification via the public API, then backdates its
 *  created_at directly — createNotification always stamps "now", and these
 *  tests need explicit control over age. */
function seedNotification(
  db: ReturnType<typeof initDb>,
  opts: {
    id: string;
    requiresApproval: boolean;
    respondedWith?: string;
    ageMs: number;
  },
) {
  const n = repo.createNotification(db, {
    id: opts.id,
    projectId: "proj-1",
    severity: opts.requiresApproval ? "action_required" : "info",
    title: opts.id,
    message: "msg",
    requiresApproval: opts.requiresApproval,
    options: opts.requiresApproval ? ["approve", "reject"] : undefined,
  });
  const createdAt = new Date(Date.now() - opts.ageMs).toISOString();
  db.prepare("UPDATE notifications SET created_at = ?, responded_with = ? WHERE id = ?").run(
    createdAt,
    opts.respondedWith ?? null,
    n.id,
  );
}

// ── B23: pruneNotifications never deletes a pending approval ──

test("pruneNotifications: deletes old responded notifications", () => {
  const db = setup();
  seedNotification(db, { id: "old-info", requiresApproval: false, respondedWith: undefined, ageMs: 40 * DAY_MS });
  const deleted = repo.pruneNotifications(db, 30);
  assert.equal(deleted, 1);
  assert.equal(repo.getNotification(db, "old-info"), null);
});

test("pruneNotifications: never deletes an old pending approval", () => {
  const db = setup();
  seedNotification(db, {
    id: "old-pending",
    requiresApproval: true,
    respondedWith: undefined,
    ageMs: 90 * DAY_MS,
  });
  const deleted = repo.pruneNotifications(db, 30);
  assert.equal(deleted, 0);
  assert.notEqual(repo.getNotification(db, "old-pending"), null);
});

test("pruneNotifications: a resolved-but-old approval is fair game (only unresponded ones are exempt)", () => {
  const db = setup();
  seedNotification(db, {
    id: "old-resolved-approval",
    requiresApproval: true,
    respondedWith: "approve",
    ageMs: 90 * DAY_MS,
  });
  const deleted = repo.pruneNotifications(db, 30);
  assert.equal(deleted, 1);
  assert.equal(repo.getNotification(db, "old-resolved-approval"), null);
});

test("pruneNotifications: recent notifications survive regardless of type", () => {
  const db = setup();
  seedNotification(db, { id: "recent", requiresApproval: false, ageMs: DAY_MS });
  const deleted = repo.pruneNotifications(db, 30);
  assert.equal(deleted, 0);
  assert.notEqual(repo.getNotification(db, "recent"), null);
});

// ── B26: getNotifications' LIMIT must not drop a pending approval ──

test("getNotifications: an old pending approval survives past 250 newer responded notifications (default limit)", () => {
  const db = setup();
  seedNotification(db, {
    id: "pending-1",
    requiresApproval: true,
    respondedWith: undefined,
    ageMs: 40 * DAY_MS,
  });
  for (let i = 0; i < 250; i++) {
    seedNotification(db, {
      id: `n-${i}`,
      requiresApproval: false,
      respondedWith: "ack",
      ageMs: i * 1000,
    });
  }
  const result = repo.getNotifications(db, "proj-1");
  assert.equal(result.some((n) => n.id === "pending-1"), true);
  assert.equal(
    result.every(
      (n, i) => i === 0 || new Date(result[i - 1]!.createdAt) >= new Date(n.createdAt),
    ),
    true,
  );
});

test("getNotifications: the pending approval survives even with a small explicit limit", () => {
  const db = setup();
  seedNotification(db, {
    id: "pending-1",
    requiresApproval: true,
    respondedWith: undefined,
    ageMs: 40 * DAY_MS,
  });
  for (let i = 0; i < 20; i++) {
    seedNotification(db, {
      id: `n-${i}`,
      requiresApproval: false,
      respondedWith: "ack",
      ageMs: i * 1000,
    });
  }
  const result = repo.getNotifications(db, "proj-1", 5);
  assert.equal(result.some((n) => n.id === "pending-1"), true);
  assert.equal(result.length, 6); // newest 5 + the 1 pending approval
});

test("getNotifications: a fresh pending approval already within the window isn't duplicated", () => {
  const db = setup();
  seedNotification(db, {
    id: "pending-fresh",
    requiresApproval: true,
    respondedWith: undefined,
    ageMs: 0,
  });
  const result = repo.getNotifications(db, "proj-1", 5);
  assert.equal(result.filter((n) => n.id === "pending-fresh").length, 1);
});

test("getNotifications: works with no projectId (global) too", () => {
  const db = setup();
  seedNotification(db, {
    id: "pending-1",
    requiresApproval: true,
    respondedWith: undefined,
    ageMs: 40 * DAY_MS,
  });
  const result = repo.getNotifications(db);
  assert.equal(result.some((n) => n.id === "pending-1"), true);
});

// ── F38: AGENTS.md planning-session persistence ──

test("savePlanningSession/getPlanningSession: agentsMd round-trips alongside prd/draftTasks", () => {
  const db = setup();
  repo.savePlanningSession(db, "proj-1", {
    messages: [{ role: "user", content: "hi" }],
    prd: "# PRD",
    draftTasks: [],
    agentsMd: "# Project context\n\nA test project.",
  });
  const session = repo.getPlanningSession(db, "proj-1");
  assert.equal(session.prd, "# PRD");
  assert.equal(session.agentsMd, "# Project context\n\nA test project.");
});

test("savePlanningSession: agentsMd: null clears a previously saved value", () => {
  const db = setup();
  repo.savePlanningSession(db, "proj-1", { agentsMd: "# Draft" });
  assert.equal(repo.getPlanningSession(db, "proj-1").agentsMd, "# Draft");

  repo.savePlanningSession(db, "proj-1", { agentsMd: null });
  assert.equal(repo.getPlanningSession(db, "proj-1").agentsMd, undefined);
});

test("getPlanningSession: agentsMd is undefined when never set", () => {
  const db = setup();
  const session = repo.getPlanningSession(db, "proj-1");
  assert.equal(session.agentsMd, undefined);
});
