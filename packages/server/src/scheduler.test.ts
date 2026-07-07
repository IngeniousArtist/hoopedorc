import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectSchedule } from "@orc/types";
import { isScheduleDue } from "./scheduler.js";

const HOUR_MS = 60 * 60 * 1000;

test("isScheduleDue: undefined schedule is never due", () => {
  assert.equal(isScheduleDue(undefined, undefined, new Date()), false);
});

test("isScheduleDue: disabled schedule is never due", () => {
  const schedule: ProjectSchedule = {
    enabled: false,
    mode: "interval",
    intervalHours: 1,
  };
  assert.equal(isScheduleDue(schedule, undefined, new Date()), false);
});

// ── interval mode ──

test("isScheduleDue: interval — under the window is not due", () => {
  const now = new Date("2026-01-15T12:00:00.000Z");
  const schedule: ProjectSchedule = {
    enabled: true,
    mode: "interval",
    intervalHours: 6,
  };
  const lastRunAt = new Date(now.getTime() - 5 * HOUR_MS).toISOString();
  assert.equal(isScheduleDue(schedule, lastRunAt, now), false);
});

test("isScheduleDue: interval — exactly at the window is due", () => {
  const now = new Date("2026-01-15T12:00:00.000Z");
  const schedule: ProjectSchedule = {
    enabled: true,
    mode: "interval",
    intervalHours: 6,
  };
  const lastRunAt = new Date(now.getTime() - 6 * HOUR_MS).toISOString();
  assert.equal(isScheduleDue(schedule, lastRunAt, now), true);
});

test("isScheduleDue: interval — over the window is due", () => {
  const now = new Date("2026-01-15T12:00:00.000Z");
  const schedule: ProjectSchedule = {
    enabled: true,
    mode: "interval",
    intervalHours: 6,
  };
  const lastRunAt = new Date(now.getTime() - 7 * HOUR_MS).toISOString();
  assert.equal(isScheduleDue(schedule, lastRunAt, now), true);
});

test("isScheduleDue: interval — never run yet is due immediately", () => {
  const now = new Date("2026-01-15T12:00:00.000Z");
  const schedule: ProjectSchedule = {
    enabled: true,
    mode: "interval",
    intervalHours: 6,
  };
  assert.equal(isScheduleDue(schedule, undefined, now), true);
});

test("isScheduleDue: interval — zero/invalid intervalHours is never due", () => {
  const now = new Date("2026-01-15T12:00:00.000Z");
  const schedule: ProjectSchedule = {
    enabled: true,
    mode: "interval",
    intervalHours: 0,
  };
  assert.equal(isScheduleDue(schedule, undefined, now), false);
});

// ── daily mode ──
// All fixed via local Date components (year, month, day, hour, minute,
// second) so the comparison against isScheduleDue's own local setHours()
// call is timezone-independent regardless of the box running the test.

test("isScheduleDue: daily — within the grace window, never run yet, is due", () => {
  const now = new Date(2026, 0, 15, 3, 15, 30); // 30s past 03:15
  const schedule: ProjectSchedule = {
    enabled: true,
    mode: "daily",
    hour: 3,
    minute: 15,
  };
  assert.equal(isScheduleDue(schedule, undefined, now), true);
});

test("isScheduleDue: daily — before the scheduled minute is not due", () => {
  const now = new Date(2026, 0, 15, 3, 10, 0); // before 03:15
  const schedule: ProjectSchedule = {
    enabled: true,
    mode: "daily",
    hour: 3,
    minute: 15,
  };
  assert.equal(isScheduleDue(schedule, undefined, now), false);
});

test("isScheduleDue: daily — well past the scheduled hour (outside the grace window) is not due", () => {
  const now = new Date(2026, 0, 15, 14, 0, 0); // scheduled for 03:15, now 14:00
  const schedule: ProjectSchedule = {
    enabled: true,
    mode: "daily",
    hour: 3,
    minute: 15,
  };
  assert.equal(isScheduleDue(schedule, undefined, now), false);
});

test("isScheduleDue: daily — already fired today is not due again", () => {
  const now = new Date(2026, 0, 15, 3, 15, 30);
  const schedule: ProjectSchedule = {
    enabled: true,
    mode: "daily",
    hour: 3,
    minute: 15,
  };
  const lastRunAt = new Date(2026, 0, 15, 3, 16, 0).toISOString(); // earlier today
  assert.equal(isScheduleDue(schedule, lastRunAt, now), false);
});

test("isScheduleDue: daily — fired yesterday is due again today", () => {
  const now = new Date(2026, 0, 15, 3, 15, 30);
  const schedule: ProjectSchedule = {
    enabled: true,
    mode: "daily",
    hour: 3,
    minute: 15,
  };
  const lastRunAt = new Date(2026, 0, 14, 3, 15, 20).toISOString(); // yesterday
  assert.equal(isScheduleDue(schedule, lastRunAt, now), true);
});

test("isScheduleDue: daily — missing hour/minute config is never due", () => {
  const now = new Date(2026, 0, 15, 3, 15, 30);
  const schedule: ProjectSchedule = {
    enabled: true,
    mode: "daily",
  };
  assert.equal(isScheduleDue(schedule, undefined, now), false);
});
