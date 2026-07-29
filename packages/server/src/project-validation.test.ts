import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { SECRET_SENTINEL } from "@orc/types";
import { defaultSettings } from "./config.js";
import {
  isLoopbackHost,
  isValidBranchName,
  isValidRepoUrl,
  localPathOkForClone,
  parseProjectConfig,
  redactSettings,
  safeToDeleteLocalPath,
  safeTokenEqual,
  unauthenticatedBindingError,
  validateLocalPath,
} from "./project-validation.js";

const pexecFile = promisify(execFile);
const MATCHING_ORIGIN = "https://github.com/example/project";

async function git(cwd: string, args: string[]): Promise<void> {
  await pexecFile("git", args, { cwd, encoding: "utf8" });
}

async function makeRepo(
  parent: string,
  name: string,
  origin = MATCHING_ORIGIN,
): Promise<string> {
  const path = join(parent, name);
  mkdirSync(path);
  await git(path, ["init", "--quiet"]);
  await git(path, ["remote", "add", "origin", origin]);
  return path;
}

test("O27: branch and repository URL validators accept only supported argv shapes", () => {
  for (const branch of ["main", "feature/O27", "release-1.2_3"]) {
    assert.equal(isValidBranchName(branch), true, branch);
  }
  for (const branch of ["-main", "bad branch", "main;touch", ""]) {
    assert.equal(isValidBranchName(branch), false, branch);
  }

  for (const url of [
    "https://github.com/example/project",
    "https://github.com/example/project.git",
    "git@github.com:example/project",
    "git@github.com:example/project.git",
  ]) {
    assert.equal(isValidRepoUrl(url), true, url);
  }
  for (const url of [
    "https://gitlab.com/example/project",
    "file:///tmp/project",
    "--upload-pack=payload",
    "https://github.com/example",
  ]) {
    assert.equal(isValidRepoUrl(url), false, url);
  }
});

test("O27: project config parser canonicalizes a complete valid override", () => {
  assert.deepEqual(
    parseProjectConfig({
      setupCommand: { command: " npm ", args: ["ci", "--ignore-scripts"] },
      maxAttempts: 4,
      mergePolicy: "always_ask",
      gates: {
        typecheckScript: " typecheck ",
        lintScript: false,
        testCommand: " npm test ",
      },
      requireGithubChecks: true,
      githubChecksTimeoutMin: 30,
      perTaskDocs: false,
      skillHints: [" focused ", ""],
      gateImage: "node:22",
      schedule: {
        enabled: true,
        mode: "daily",
        hour: 8,
        minute: 30,
      },
    }),
    {
      value: {
        setupCommand: {
          command: "npm",
          args: ["ci", "--ignore-scripts"],
        },
        maxAttempts: 4,
        mergePolicy: "always_ask",
        gates: {
          typecheckScript: "typecheck",
          lintScript: false,
          testCommand: "npm test",
        },
        requireGithubChecks: true,
        githubChecksTimeoutMin: 30,
        perTaskDocs: false,
        skillHints: ["focused"],
        gateImage: "node:22",
        schedule: {
          enabled: true,
          mode: "daily",
          hour: 8,
          minute: 30,
        },
      },
    },
  );
  assert.deepEqual(parseProjectConfig(null), { value: undefined });
  assert.deepEqual(parseProjectConfig({}), { value: undefined });
});

test("O27: project config parser reports bounded field errors", () => {
  const cases: Array<[unknown, RegExp]> = [
    [[], /config must be an object/],
    [{ setupCommand: "npm ci" }, /setupCommand must be an object/],
    [{ maxAttempts: 0 }, /maxAttempts/],
    [{ mergePolicy: "unsafe" }, /mergePolicy/],
    [{ gates: [] }, /gates must be an object/],
    [{ gates: { lintScript: "" } }, /lintScript/],
    [{ requireGithubChecks: "yes" }, /requireGithubChecks/],
    [{ githubChecksTimeoutMin: 121 }, /githubChecksTimeoutMin/],
    [{ perTaskDocs: 1 }, /perTaskDocs/],
    [{ skillHints: new Array(21).fill("x") }, /at most 20/],
    [{ gateImage: "--privileged" }, /gateImage/],
    [{ schedule: { enabled: true, mode: "hourly" } }, /schedule.mode/],
    [
      {
        schedule: {
          enabled: true,
          mode: "interval",
          intervalHours: 0,
        },
      },
      /intervalHours/,
    ],
  ];
  for (const [input, expected] of cases) {
    const result = parseProjectConfig(input);
    assert.ok("error" in result);
    assert.match(result.error, expected);
  }
});

test("O27: local path validation protects home, server, and repository roots", () => {
  const context = {
    homeDir: "/home/operator",
    serverCwd: "/srv/hoopedorc",
    reposDir: "/data/repos",
  };
  assert.match(validateLocalPath("relative", context) ?? "", /absolute/);
  assert.match(validateLocalPath("/", context) ?? "", /cannot be '\/'/);
  assert.match(validateLocalPath("/home/operator", context) ?? "", /home/);
  assert.match(validateLocalPath("/srv", context) ?? "", /server/);
  assert.match(validateLocalPath("/data", context) ?? "", /repos directory/);
  assert.equal(validateLocalPath("/data/repos/project", context), null);
  assert.equal(validateLocalPath("/tmp/project", context), null);
});

test("O27: existing clone validation distinguishes empty, matching, wrong, and unmanaged paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-clone-validation-"));
  try {
    assert.equal(
      await localPathOkForClone(join(root, "missing"), MATCHING_ORIGIN),
      null,
    );

    const empty = join(root, "empty");
    mkdirSync(empty);
    assert.equal(await localPathOkForClone(empty, MATCHING_ORIGIN), null);

    const file = join(root, "file");
    writeFileSync(file, "not a directory");
    assert.match(
      (await localPathOkForClone(file, MATCHING_ORIGIN)) ?? "",
      /not a directory/,
    );

    const unmanaged = join(root, "unmanaged");
    mkdirSync(unmanaged);
    writeFileSync(join(unmanaged, "operator.txt"), "keep");
    assert.match(
      (await localPathOkForClone(unmanaged, MATCHING_ORIGIN)) ?? "",
      /not a git clone/,
    );

    const matching = await makeRepo(root, "matching");
    assert.equal(await localPathOkForClone(matching, MATCHING_ORIGIN), null);

    const wrong = await makeRepo(
      root,
      "wrong",
      "https://github.com/example/other",
    );
    assert.match(
      (await localPathOkForClone(wrong, MATCHING_ORIGIN)) ?? "",
      /different repository/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("O27: destructive cleanup accepts only a clean, direct, matching-origin clone", async () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-delete-validation-"));
  try {
    const clean = await makeRepo(root, "clean");
    assert.equal(
      await safeToDeleteLocalPath(clean, MATCHING_ORIGIN, root),
      true,
    );

    const dirty = await makeRepo(root, "dirty");
    writeFileSync(join(dirty, "operator.txt"), "keep");
    assert.equal(
      await safeToDeleteLocalPath(dirty, MATCHING_ORIGIN, root),
      false,
      "a matching origin must not authorize deletion of operator changes",
    );

    const wrong = await makeRepo(
      root,
      "wrong",
      "https://github.com/example/other",
    );
    assert.equal(
      await safeToDeleteLocalPath(wrong, MATCHING_ORIGIN, root),
      false,
    );

    const unmanaged = join(root, "unmanaged");
    mkdirSync(unmanaged);
    writeFileSync(join(unmanaged, "operator.txt"), "keep");
    assert.equal(
      await safeToDeleteLocalPath(unmanaged, MATCHING_ORIGIN, root),
      false,
    );

    const symlinkTarget = await makeRepo(root, "symlink-target");
    const symlink = join(root, "symlink");
    symlinkSync(symlinkTarget, symlink, "dir");
    assert.equal(
      await safeToDeleteLocalPath(symlink, MATCHING_ORIGIN, root),
      false,
    );

    const parentRepo = await makeRepo(root, "parent");
    const nested = await makeRepo(parentRepo, "nested");
    assert.equal(
      await safeToDeleteLocalPath(nested, MATCHING_ORIGIN, root),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("O27: settings and token helpers preserve secrets and auth policy", () => {
  const settings = defaultSettings();
  settings.apiToken = "api-secret";
  settings.telegram = {
    enabled: true,
    botToken: "telegram-secret",
    chatId: "42",
  };
  const redacted = redactSettings(settings);
  assert.equal(redacted.apiToken, SECRET_SENTINEL);
  assert.equal(redacted.telegram?.botToken, SECRET_SENTINEL);
  assert.equal(settings.apiToken, "api-secret");
  assert.equal(settings.telegram.botToken, "telegram-secret");

  assert.equal(safeTokenEqual("same", "same"), true);
  assert.equal(safeTokenEqual("nope", "same"), false);
  assert.equal(safeTokenEqual(undefined, "same"), false);
  assert.equal(safeTokenEqual("é", "e"), false);

  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    assert.equal(isLoopbackHost(host), true);
    assert.equal(unauthenticatedBindingError(host, undefined, false), null);
  }
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.match(
    unauthenticatedBindingError("0.0.0.0", undefined, false) ?? "",
    /API_TOKEN/,
  );
  assert.equal(
    unauthenticatedBindingError("0.0.0.0", "secret", false),
    null,
  );
  assert.equal(
    unauthenticatedBindingError("0.0.0.0", undefined, true),
    null,
  );
});
