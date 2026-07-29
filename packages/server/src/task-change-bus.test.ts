import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskChangeBus } from "./task-change-bus.js";

test("O35: a notification immediately before wait is observed without sleeping", async () => {
  const bus = new TaskChangeBus();
  const before = bus.currentVersion("project");
  bus.notify("project");

  assert.equal(
    await bus.waitForChange("project", before, 1_000),
    "change",
  );
  assert.equal(bus.currentVersion("project"), before + 1);
});

test("O35: a notification after waiter registration resolves every current waiter", async () => {
  const bus = new TaskChangeBus();
  const before = bus.currentVersion("project");
  const first = bus.waitForChange("project", before, 1_000);
  const second = bus.waitForChange("project", before, 1_000);

  bus.notify("project");

  assert.deepEqual(await Promise.all([first, second]), ["change", "change"]);
});

test("O35: multiple writes collapse to the latest version and deadlines still fire", async () => {
  const bus = new TaskChangeBus();
  const waiting = bus.waitForChange("project", 0, 1_000);
  bus.notify("project");
  bus.notify("project");
  bus.notify("project");

  assert.equal(await waiting, "change");
  assert.equal(bus.currentVersion("project"), 3);
  assert.equal(
    await bus.waitForChange("project", 3, 5),
    "deadline",
  );
});
