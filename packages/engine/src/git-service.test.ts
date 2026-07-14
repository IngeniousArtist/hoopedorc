import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "@orc/types";
import { GitServiceImpl } from "./git-service.js";

test("GitHub checks polling aborts during its retry wait", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hoopedorc-gh-test-"));
  const fakeGh = join(bin, "gh");
  writeFileSync(
    fakeGh,
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([{ bucket: "pending" }]));\n',
  );
  chmodSync(fakeGh, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;

  const project: Project = {
    id: "p1",
    name: "project",
    repoUrl: "owner/repo",
    defaultBranch: "main",
    localPath: "/tmp",
    status: "running",
    createdAt: "",
    updatedAt: "",
  };
  const controller = new AbortController();
  const started = Date.now();
  try {
    const polling = new GitServiceImpl().waitForChecks(
      project,
      1,
      60_000,
      undefined,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(polling, { name: "AbortError" });
    assert.ok(Date.now() - started < 1_000);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
