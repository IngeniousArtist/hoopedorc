import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureDocsTask } from "./docs-task";

interface Draft {
  title: string;
  role?: "docs" | "frontend";
  dependsOn: number[];
}

const docsDraft: Draft = { title: "Project documentation", role: "docs", dependsOn: [] };

test("appends a docs task depending on every other task when none exists", () => {
  const tasks: Draft[] = [
    { title: "scaffold", dependsOn: [] },
    { title: "feature", dependsOn: [0] },
  ];
  const out = ensureDocsTask(tasks, docsDraft);
  assert.equal(out.length, 3);
  assert.deepEqual(out[2]!.dependsOn, [0, 1]);
  assert.equal(out[2]!.role, "docs");
});

test("a planner-authored docs task with no deps is forced to run last", () => {
  // The planner is told not to create its own docs task, but when it does
  // anyway it tends to give it no dependencies — which made it run
  // concurrently with the scaffold and fail its gates (the original bug).
  const tasks: Draft[] = [
    { title: "scaffold", dependsOn: [] },
    { title: "write the docs", role: "docs", dependsOn: [] },
    { title: "feature", dependsOn: [0] },
  ];
  const out = ensureDocsTask(tasks, docsDraft);
  assert.equal(out.length, 3, "no duplicate docs task added");
  assert.deepEqual(out[1]!.dependsOn, [0, 2], "docs deps extended to all non-docs tasks");
  assert.deepEqual(out[0]!.dependsOn, [], "non-docs tasks untouched");
  assert.deepEqual(out[2]!.dependsOn, [0]);
});

test("a docs task never depends on another docs task or itself", () => {
  const tasks: Draft[] = [
    { title: "api docs", role: "docs", dependsOn: [] },
    { title: "scaffold", dependsOn: [] },
    { title: "readme", role: "docs", dependsOn: [] },
  ];
  const out = ensureDocsTask(tasks, docsDraft);
  assert.deepEqual(out[0]!.dependsOn, [1]);
  assert.deepEqual(out[2]!.dependsOn, [1]);
});
