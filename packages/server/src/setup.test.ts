import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project } from "@orc/types";
import { projectSetupChecks } from "./setup.js";

test("B38: Setup health names each project's selected manager and runtime", async () => {
  const localPath = mkdtempSync(join(tmpdir(), "hoopedorc-setup-health-"));
  writeFileSync(join(localPath, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(join(localPath, "package-lock.json"), "{}");
  const project: Project = {
    id: "p1",
    name: "Portable fixture",
    repoUrl: "",
    defaultBranch: "main",
    localPath,
    status: "created",
    createdAt: "",
    updatedAt: "",
  };
  const checks = await projectSetupChecks({ sandboxGates: "off" }, [project]);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.name, "Project setup — Portable fixture");
  assert.equal(checks[0]?.ok, true, checks[0]?.detail);
  assert.match(checks[0]?.detail ?? "", /npm@.*package-lock\.json.*v\d+.*(?:darwin|linux|win32)\//i);
});
