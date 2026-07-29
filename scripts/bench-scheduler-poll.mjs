#!/usr/bin/env node

import { cpus, freemem, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { Orchestrator } from "../packages/engine/src/orchestrator.ts";
import { defaultSettings } from "../packages/server/src/config.ts";
import { initDb } from "../packages/server/src/db/index.ts";
import * as repo from "../packages/server/src/db/repo.ts";

function positiveIntegerFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const parsed = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const durationMs = positiveIntegerFlag("--duration-ms", 3_000);
const repetitions = positiveIntegerFlag("--repetitions", 3);
const taskCount = positiveIntegerFlag("--tasks", 250);
const pickupSamples = positiveIntegerFlag("--pickup-samples", 40);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function rounded(value) {
  return Number(value.toFixed(3));
}

function taskInput(projectId, id) {
  return {
    id,
    projectId,
    title: id,
    description: "",
    difficulty: "medium",
    status: "backlog",
    dependsOn: [],
    acceptanceCriteria: [],
    assignedModel: "deepseek-flash",
    scopePaths: ["src/**"],
    attempts: 0,
    maxAttempts: 3,
  };
}

function seedProject(db, projectId, tasks) {
  const project = repo.createProject(db, {
    id: projectId,
    name: projectId,
    repoUrl: "https://example.invalid/benchmark.git",
    defaultBranch: "main",
    localPath: `/tmp/${projectId}`,
    status: "running",
  });
  const insert = db.transaction(() => {
    for (let index = 0; index < tasks; index++) {
      repo.createTask(db, taskInput(projectId, `${projectId}-task-${index}`));
    }
  });
  insert();
  return project;
}

function benchmarkTaskChanges(db, projectId, counters) {
  return {
    currentGeneration: () => {
      const startedAt = performance.now();
      const generation = repo.getTaskGeneration(db, projectId);
      counters.generationReads++;
      counters.sqliteMs += performance.now() - startedAt;
      return generation;
    },
    currentWakeVersion: () => repo.getTaskWakeVersion(db, projectId),
    waitForChange: (afterWakeVersion, deadlineMs) =>
      repo.waitForTaskChange(db, projectId, afterWakeVersion, deadlineMs),
  };
}

function benchmarkDeps(
  settings,
  getTasks,
  taskChanges,
  onPicked = () => {},
) {
  const unused = () => {
    throw new Error("benchmark hold unexpectedly dispatched work");
  };
  return {
    settings,
    getSettings: () => settings,
    opencodeBaseUrl: "",
    getTasks,
    taskChanges,
    getPendingApproval: () => ({ title: "scheduler polling benchmark hold" }),
    adapterFor: unused,
    worktrees: {},
    git: {},
    gates: {},
    validator: {},
    events: {
      onLog(event) {
        if (event.message.startsWith("Picked up new task added mid-run:")) {
          onPicked(event.taskId);
        }
      },
      onTaskUpdated() {},
      onRunUpdated() {},
      onMergeDecision() {},
      async requestApproval() {
        return "reject";
      },
    },
  };
}

function measuredTaskReader(db, projectId, counters) {
  return () => {
    const startedAt = performance.now();
    const tasks = repo.getTasks(db, projectId);
    counters.fullReads++;
    counters.sqliteMs += performance.now() - startedAt;
    return tasks;
  };
}

async function runIdleControl() {
  const startedAt = performance.now();
  const cpuStarted = process.cpuUsage();
  await delay(durationMs);
  const elapsedMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuStarted);
  return ((cpu.user + cpu.system) / 1_000 / elapsedMs) * 100;
}

async function runSteadyScenario(projectCount) {
  const db = initDb(":memory:");
  const settings = {
    ...defaultSettings(),
    holdWhileAwaitingApproval: true,
  };
  const projects = Array.from(
    { length: projectCount },
    (_, index) => seedProject(db, `project-${index}`, taskCount),
  );
  const counters = projects.map(() => ({
    fullReads: 0,
    generationReads: 0,
    sqliteMs: 0,
  }));
  const orchestrators = projects.map(
    (project, index) =>
      new Orchestrator(
        benchmarkDeps(
          settings,
          measuredTaskReader(db, project.id, counters[index]),
          benchmarkTaskChanges(db, project.id, counters[index]),
        ),
      ),
  );

  const cpuStarted = process.cpuUsage();
  const startedAt = performance.now();
  const running = orchestrators.map((orchestrator, index) =>
    orchestrator.start(
      projects[index],
      repo.getTasks(db, projects[index].id),
    ),
  );
  await delay(durationMs);
  await Promise.all(
    orchestrators.map((orchestrator, index) =>
      orchestrator.pause(projects[index]),
    ),
  );
  await Promise.all(running);
  const elapsedMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuStarted);
  const fullReads = counters.reduce(
    (sum, counter) => sum + counter.fullReads,
    0,
  );
  const generationReads = counters.reduce(
    (sum, counter) => sum + counter.generationReads,
    0,
  );
  const sqliteMs = counters.reduce(
    (sum, counter) => sum + counter.sqliteMs,
    0,
  );
  db.close();

  return {
    elapsedMs,
    fullReadsPerSecond: fullReads / (elapsedMs / 1_000),
    generationReadsPerSecond: generationReads / (elapsedMs / 1_000),
    sqliteMsPerSecond: sqliteMs / (elapsedMs / 1_000),
    cpuPercentOneCore: ((cpu.user + cpu.system) / 1_000 / elapsedMs) * 100,
  };
}

async function repeatedSteadyScenario(projectCount, controlCpuPercent) {
  const samples = [];
  for (let pass = 0; pass < repetitions; pass++) {
    samples.push(await runSteadyScenario(projectCount));
  }
  const medianCpu = percentile(
    samples.map((sample) => sample.cpuPercentOneCore),
    0.5,
  );
  return {
    projects: projectCount,
    tasksPerProject: taskCount,
    repetitions,
    durationMs,
    fullReadsPerSecondMedian: rounded(
      percentile(samples.map((sample) => sample.fullReadsPerSecond), 0.5),
    ),
    generationReadsPerSecondMedian: rounded(
      percentile(samples.map((sample) => sample.generationReadsPerSecond), 0.5),
    ),
    sqliteMsPerSecondMedian: rounded(
      percentile(samples.map((sample) => sample.sqliteMsPerSecond), 0.5),
    ),
    cpuPercentOneCoreMedian: rounded(medianCpu),
    cpuPercentOneCoreAdjusted: rounded(
      Math.max(0, medianCpu - controlCpuPercent),
    ),
  };
}

async function measurePickupLatency() {
  const db = initDb(":memory:");
  const project = seedProject(db, "pickup-project", taskCount);
  const settings = {
    ...defaultSettings(),
    holdWhileAwaitingApproval: true,
  };
  const counters = { fullReads: 0, generationReads: 0, sqliteMs: 0 };
  const waiting = new Map();
  const latencies = [];
  const orchestrator = new Orchestrator(
    benchmarkDeps(
      settings,
      measuredTaskReader(db, project.id, counters),
      benchmarkTaskChanges(db, project.id, counters),
      (taskId) => {
        const sample = waiting.get(taskId);
        if (!sample) return;
        waiting.delete(taskId);
        clearTimeout(sample.timeout);
        latencies.push(performance.now() - sample.committedAt);
        sample.resolve();
      },
    ),
  );
  const running = orchestrator.start(project, repo.getTasks(db, project.id));
  await delay(50);

  for (let index = 0; index < pickupSamples; index++) {
    // A deterministic spread across the 250 ms polling interval avoids a
    // favorable single phase while keeping before/after runs comparable.
    await delay((index * 73 + 19) % 240);
    const id = `pickup-task-${index}`;
    let resolveSeen;
    let rejectSeen;
    const seen = new Promise((resolve, reject) => {
      resolveSeen = resolve;
      rejectSeen = reject;
    });
    const timeout = setTimeout(
      () => rejectSeen(new Error(`task ${id} was not reconciled within 1 second`)),
      1_000,
    );
    waiting.set(id, {
      committedAt: 0,
      resolve: resolveSeen,
      timeout,
    });
    repo.createTask(db, taskInput(project.id, id));
    waiting.get(id).committedAt = performance.now();
    await seen;
  }

  await orchestrator.pause(project);
  await running;
  db.close();
  return {
    samples: latencies.length,
    p50Ms: rounded(percentile(latencies, 0.5)),
    p95Ms: rounded(percentile(latencies, 0.95)),
    maxMs: rounded(Math.max(...latencies)),
  };
}

const controlCpuSamples = [];
for (let pass = 0; pass < repetitions; pass++) {
  controlCpuSamples.push(await runIdleControl());
}
const controlCpuPercent = percentile(controlCpuSamples, 0.5);
const oneProject = await repeatedSteadyScenario(1, controlCpuPercent);
const eightProjects = await repeatedSteadyScenario(8, controlCpuPercent);
const pickup = await measurePickupLatency();
const cpu = cpus()[0];

process.stdout.write(
  `${JSON.stringify(
    {
      host: {
        platform: platform(),
        release: release(),
        architecture: process.arch,
        node: process.version,
        logicalCpus: cpus().length,
        cpuModel: cpu?.model ?? "unknown",
        totalMemoryGiB: rounded(totalmem() / 1024 ** 3),
        freeMemoryGiBAtEnd: rounded(freemem() / 1024 ** 3),
      },
      fixture: {
        taskRowsPerProject: taskCount,
        steadyDurationMs: durationMs,
        steadyRepetitions: repetitions,
        pickupSamples,
        database: "real in-memory SQLite with the production schema/repository mapper",
        hold: "one unresolved approval per active project",
      },
      control: {
        cpuPercentOneCoreMedian: rounded(controlCpuPercent),
      },
      steady: [oneProject, eightProjects],
      pickup,
    },
    null,
    2,
  )}\n`,
);
