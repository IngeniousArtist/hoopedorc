import { TASK_STATUSES, type Task } from "@orc/types";
import { describe, expect, it } from "vitest";
import { taskFixture } from "../test/fixtures";
import {
  BOARD_GROUPS,
  allowedActions,
  cardActivity,
  defaultListGroup,
  groupCounts,
  groupForStatus,
  tasksInGroup,
} from "./boardGroups";

function task(id: string, overrides: Partial<Task>): Task {
  return { ...taskFixture, id, prNumber: undefined, statusReason: undefined, ...overrides };
}

describe("VW04 board groups", () => {
  it("maps every task status to exactly one of the five groups", () => {
    const covered = new Set<string>();
    for (const group of BOARD_GROUPS) {
      for (const status of group.statuses) {
        expect(covered.has(status)).toBe(false);
        covered.add(status);
        expect(groupForStatus(status)).toBe(group.key);
      }
    }
    expect([...covered].sort()).toEqual([...TASK_STATUSES].sort());
    expect(BOARD_GROUPS.map((group) => group.key)).toEqual([
      "planned",
      "working",
      "review",
      "done",
      "attention",
    ]);
    expect(BOARD_GROUPS.filter((group) => group.dropAction).map((group) => group.key)).toEqual([
      "planned",
    ]);
  });

  it("counts, filters, and picks the phone list's opening group by urgency", () => {
    const tasks = [
      task("a", { status: "backlog" }),
      task("b", { status: "ready" }),
      task("c", { status: "in_progress" }),
      task("d", { status: "changes_requested" }),
      task("e", { status: "in_review" }),
      task("f", { status: "done" }),
      task("g", { status: "failed" }),
    ];
    expect(groupCounts(tasks)).toEqual({ planned: 2, working: 2, review: 1, done: 1, attention: 1 });
    expect(tasksInGroup(tasks, "working").map((t) => t.id)).toEqual(["c", "d"]);
    expect(defaultListGroup(tasks)).toBe("attention");
    expect(defaultListGroup(tasks.filter((t) => t.status !== "failed"))).toBe("working");
    expect(defaultListGroup([task("x", { status: "done" })])).toBe("done");
    expect(defaultListGroup([])).toBe("planned");
  });

  it("describes the current state truthfully, including blockers and exact reasons", () => {
    const dependency = task("dep", { status: "in_progress", title: "Schema" });
    const doneDependency = task("dep-done", { status: "done", title: "Auth" });
    const waiting = task("w", { status: "backlog", dependsOn: ["dep", "dep-done", "missing"] });
    const activity = cardActivity(waiting, [dependency, doneDependency]);
    expect(activity).toMatchObject({ line: "Waiting on 1 task", tone: "waiting", reviewAvailable: false });
    expect(activity.blockedBy.map((t) => t.id)).toEqual(["dep"]);

    expect(cardActivity(task("q", { status: "backlog" }), []).line).toBe(
      "Queued — the scheduler picks it up next",
    );
    expect(cardActivity(task("r", { status: "ready" }), [])).toMatchObject({
      line: "Ready to run",
      tone: "ready",
    });
    expect(
      cardActivity(task("rq", { status: "ready", dispatchRequestedAt: "2026-09-21T10:00:00Z" }), []).line,
    ).toBe("Run next — waiting for scheduler capacity");
    expect(cardActivity(task("p", { status: "in_progress" }), [])).toMatchObject({
      line: "Working",
      tone: "active",
    });
    expect(cardActivity(task("cr", { status: "changes_requested", prNumber: 7 }), [])).toMatchObject({
      line: "Repairing after review feedback · PR #7",
      tone: "active",
      reviewAvailable: true,
    });
    expect(cardActivity(task("v", { status: "in_review", prNumber: 9 }), [])).toMatchObject({
      line: "In review · PR #9",
      tone: "review",
      reviewAvailable: true,
    });
    expect(cardActivity(task("d", { status: "done", prNumber: 4 }), [])).toMatchObject({
      line: "Merged · PR #4",
      tone: "done",
      reviewAvailable: true,
    });
    expect(cardActivity(task("b", { status: "blocked", statusReason: "Stopped by user" }), [])).toMatchObject(
      { line: "Blocked: Stopped by user", tone: "attention" },
    );
    expect(cardActivity(task("b2", { status: "blocked" }), []).line).toBe(
      "Blocked — stopped or waiting for a decision",
    );
    expect(
      cardActivity(task("f", { status: "failed", statusReason: "Gates kept failing: tests" }), []),
    ).toMatchObject({ line: "Failed: Gates kept failing: tests", tone: "attention" });
  });

  it("offers only the actions the server rules allow for each status", () => {
    const actions = Object.fromEntries(
      TASK_STATUSES.map((status) => [status, allowedActions(task(status, { status }))]),
    );
    expect(actions.backlog).toEqual({ runNext: true, defer: false, stop: false, retry: false });
    expect(actions.ready).toEqual({ runNext: false, defer: true, stop: false, retry: false });
    expect(actions.in_progress).toEqual({ runNext: false, defer: false, stop: true, retry: false });
    expect(actions.in_review).toEqual({ runNext: false, defer: false, stop: true, retry: false });
    expect(actions.changes_requested).toEqual({ runNext: false, defer: false, stop: false, retry: true });
    expect(actions.blocked).toEqual({ runNext: false, defer: false, stop: false, retry: true });
    expect(actions.failed).toEqual({ runNext: false, defer: false, stop: false, retry: true });
    expect(actions.done).toEqual({ runNext: false, defer: false, stop: false, retry: false });
  });
});
