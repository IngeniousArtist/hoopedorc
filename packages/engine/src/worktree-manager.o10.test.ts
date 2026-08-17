import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  inspectNodeDependencies,
  nodeDependencyFingerprint,
} from "./worktree-manager.js";

const PACKAGE_COUNT = 200;
const NESTED_DIRS = 10;
const FILES_PER_DIR = 5;
const CONCURRENCY = 4;
const RUNTIME = { nodeVersion: "v22.14.0", platform: "linux", arch: "x64" };

function buildLargeRepo(root: string): { files: number; packages: number } {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "o10-large-fixture",
      private: true,
      packageManager: "npm@10.9.0",
      workspaces: ["packages/*"],
    }),
  );
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: "o10-large-fixture",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "o10-large-fixture", private: true } },
    }),
  );
  let files = 2;
  mkdirSync(join(root, "packages"));
  for (let index = 0; index < PACKAGE_COUNT; index++) {
    const pkg = join(root, "packages", `p${String(index).padStart(3, "0")}`);
    mkdirSync(pkg);
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: `p${index}`, version: "1.0.0" }),
    );
    files += 1;
    for (let dirIndex = 0; dirIndex < NESTED_DIRS; dirIndex++) {
      const dir = join(pkg, "src", `d${dirIndex}`);
      mkdirSync(dir, { recursive: true });
      for (let fileIndex = 0; fileIndex < FILES_PER_DIR; fileIndex++) {
        writeFileSync(join(dir, `f${fileIndex}.ts`), `export const n = ${index};\n`);
        files += 1;
      }
    }
  }
  return { files, packages: PACKAGE_COUNT + 1 };
}

async function inspectAndFingerprint(root: string): Promise<string> {
  const plan = await inspectNodeDependencies(root);
  assert.ok(plan);
  return nodeDependencyFingerprint(root, plan, "10.9.0", RUNTIME);
}

function median(samples: number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

test(
  "O10: large-repo worktree prep measures event-loop stall under concurrent inspect",
  { timeout: 60_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "hoopedorc-o10-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const built = buildLargeRepo(root);

    const first = await inspectAndFingerprint(root);
    assert.equal(await inspectAndFingerprint(root), first);

    const inspectSamples: number[] = [];
    const hashSamples: number[] = [];
    const concurrentSamples: number[] = [];
    for (let sample = 0; sample < 3; sample++) {
      const inspectStart = performance.now();
      await inspectNodeDependencies(root);
      inspectSamples.push(performance.now() - inspectStart);

      const plan = await inspectNodeDependencies(root);
      assert.ok(plan);
      const hashStart = performance.now();
      await nodeDependencyFingerprint(root, plan, "10.9.0", RUNTIME);
      hashSamples.push(performance.now() - hashStart);

      const concurrentStart = performance.now();
      const fingerprints = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => inspectAndFingerprint(root)),
      );
      concurrentSamples.push(performance.now() - concurrentStart);
      for (const fingerprint of fingerprints) {
        assert.equal(fingerprint, first);
      }
    }

    const singleInspectMs = median(inspectSamples);
    const hashMs = median(hashSamples);
    const concurrentMs = median(concurrentSamples);
    t.diagnostic(
      JSON.stringify({
        files: built.files,
        packages: built.packages,
        concurrency: CONCURRENCY,
        samples: 3,
        singleInspectMs: Number(singleInspectMs.toFixed(2)),
        hashMs: Number(hashMs.toFixed(2)),
        concurrentInspectAndHashMs: Number(concurrentMs.toFixed(2)),
        eventLoopStallMs: Number(concurrentMs.toFixed(2)),
        host: `${process.platform}/${process.arch}`,
      }),
    );
  },
);
