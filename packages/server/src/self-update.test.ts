import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SELF_UPDATE_UNIT,
  SelfUpdater,
  type RunCommand,
} from "./self-update.js";

interface FakeRunnerOptions {
  repoRoot: string;
  branch?: string;
  commit?: string;
  dirty?: boolean;
  unitDir?: string;
  sudoError?: Error;
  launchError?: Error;
  calls?: Array<{ file: string; args: string[] }>;
}

function fakeRunner(options: FakeRunnerOptions): RunCommand {
  return async (file, args) => {
    options.calls?.push({ file, args });
    if (file === "systemctl") {
      return { stdout: `${options.unitDir ?? options.repoRoot}\n`, stderr: "" };
    }
    if (file === "sudo" && args.includes("--version")) {
      if (options.sudoError) throw options.sudoError;
      return { stdout: "systemd 255\n", stderr: "" };
    }
    if (file === "sudo" && args.includes("systemctl")) {
      if (options.sudoError) throw options.sudoError;
      return { stdout: `${options.unitDir ?? options.repoRoot}\n`, stderr: "" };
    }
    if (file === "sudo" && args.includes("--unit=hoopedorc-self-update")) {
      if (options.launchError) throw options.launchError;
      return { stdout: `Running as unit: ${SELF_UPDATE_UNIT}\n`, stderr: "" };
    }
    if (file === "git" && args[0] === "branch") {
      return { stdout: `${options.branch ?? "main"}\n`, stderr: "" };
    }
    if (file === "git" && args[0] === "rev-parse") {
      return { stdout: `${options.commit ?? "abc1234"}\n`, stderr: "" };
    }
    if (file === "git" && args[0] === "status") {
      return { stdout: options.dirty ? "?? unrelated.txt\n" : "", stderr: "" };
    }
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-self-update-"));
  const repoRoot = join(root, "checkout");
  const statusFile = join(root, "state", "status.json");
  return { root, repoRoot, statusFile };
}

test("F50: a clean main systemd deployment is available for UI updates", async () => {
  const { repoRoot, statusFile } = fixture();
  const updater = new SelfUpdater({
    repoRoot,
    statusFile,
    mock: false,
    platform: "linux",
    uid: 1000,
    username: "deploy",
    homeDir: "/home/deploy",
    runCommand: fakeRunner({ repoRoot }),
  });

  const status = await updater.status();
  assert.equal(status.available, true);
  assert.equal(status.blockedReason, undefined);
  assert.equal(status.state, "idle");
  assert.equal(status.branch, "main");
  assert.equal(status.fromCommit, "abc1234");
});

test("F50: unit mismatch, dirty Git state, and active projects fail closed", async () => {
  const mismatch = fixture();
  const mismatchUpdater = new SelfUpdater({
    repoRoot: mismatch.repoRoot,
    statusFile: mismatch.statusFile,
    mock: false,
    platform: "linux",
    uid: 1000,
    username: "deploy",
    homeDir: "/home/deploy",
    runCommand: fakeRunner({
      repoRoot: mismatch.repoRoot,
      unitDir: "/opt/another-checkout",
    }),
  });
  const mismatchStatus = await mismatchUpdater.status();
  assert.equal(mismatchStatus.available, false);
  assert.match(mismatchStatus.unavailableReason ?? "", /not .*checkout/i);

  const dirty = fixture();
  const dirtyUpdater = new SelfUpdater({
    repoRoot: dirty.repoRoot,
    statusFile: dirty.statusFile,
    mock: false,
    platform: "linux",
    uid: 1000,
    username: "deploy",
    homeDir: "/home/deploy",
    runCommand: fakeRunner({ repoRoot: dirty.repoRoot, dirty: true }),
  });
  const dirtyStatus = await dirtyUpdater.status(["Production app"]);
  assert.equal(dirtyStatus.available, true);
  assert.match(dirtyStatus.blockedReason ?? "", /stop or pause.*Production app/i);

  const dirtyOnlyStatus = await dirtyUpdater.status();
  assert.match(dirtyOnlyStatus.blockedReason ?? "", /unrelated changes/i);

  const tokenOnlyStatus = await dirtyUpdater.status(
    [],
    "UI updates require API_TOKEN in .env.",
  );
  assert.match(tokenOnlyStatus.blockedReason ?? "", /API_TOKEN in \.env/i);

  const branch = fixture();
  const branchUpdater = new SelfUpdater({
    repoRoot: branch.repoRoot,
    statusFile: branch.statusFile,
    mock: false,
    platform: "linux",
    uid: 1000,
    username: "deploy",
    homeDir: "/home/deploy",
    runCommand: fakeRunner({ repoRoot: branch.repoRoot, branch: "release-test" }),
  });
  const branchStatus = await branchUpdater.status();
  assert.match(branchStatus.blockedReason ?? "", /must be on main.*release-test/i);
});

test("F50: starting an update launches only the fixed transient systemd command", async () => {
  const { repoRoot, statusFile } = fixture();
  const calls: Array<{ file: string; args: string[] }> = [];
  const updater = new SelfUpdater({
    repoRoot,
    statusFile,
    mock: false,
    platform: "linux",
    uid: 1000,
    username: "deploy",
    homeDir: "/home/deploy",
    pathEnv: "/usr/bin:/bin",
    runCommand: fakeRunner({ repoRoot, calls }),
    now: () => new Date("2026-07-16T12:00:00.000Z"),
  });

  const response = await updater.start();
  assert.equal(response.state, "queued");
  assert.match(response.blockedReason ?? "", /already in progress/i);

  const launch = calls.find(
    (call) =>
      call.file === "sudo" && call.args.includes("--unit=hoopedorc-self-update"),
  );
  assert.ok(launch);
  assert.deepEqual(launch.args.slice(0, 2), ["-n", "systemd-run"]);
  assert.ok(launch.args.includes("--collect"));
  assert.ok(launch.args.includes("--service-type=exec"));
  assert.ok(launch.args.includes("--uid=deploy"));
  assert.ok(launch.args.includes(`--working-directory=${repoRoot}`));
  assert.ok(launch.args.includes("--setenv=HOME=/home/deploy"));
  assert.ok(launch.args.includes("/usr/bin/bash"));
  assert.ok(launch.args.includes(join(repoRoot, "scripts", "update.sh")));
  assert.ok(launch.args.includes("--non-interactive"));
  assert.ok(launch.args.includes("--require-main"));
  assert.ok(launch.args.includes("--require-systemd-restart"));

  const persisted = JSON.parse(readFileSync(statusFile, "utf8")) as {
    state: string;
    fromCommit: string;
  };
  assert.equal(persisted.state, "queued");
  assert.equal(persisted.fromCommit, "abc1234");
});

test("F50: launch failure is durable and safe to retry", async () => {
  const { repoRoot, statusFile } = fixture();
  const updater = new SelfUpdater({
    repoRoot,
    statusFile,
    mock: false,
    platform: "linux",
    uid: 1000,
    username: "deploy",
    homeDir: "/home/deploy",
    runCommand: fakeRunner({
      repoRoot,
      launchError: Object.assign(new Error("exit 1"), {
        stderr: "Failed to start transient service",
      }),
    }),
    now: () => new Date("2026-07-16T12:00:00.000Z"),
  });

  await assert.rejects(
    updater.start(),
    /Could not launch the update service: Failed to start transient service/,
  );
  const persisted = JSON.parse(readFileSync(statusFile, "utf8")) as {
    state: string;
    message: string;
  };
  assert.equal(persisted.state, "failed");
  assert.match(persisted.message, /journalctl -u hoopedorc-self-update\.service/i);

  const status = await updater.status();
  assert.equal(status.blockedReason, undefined);
});

test("F50: concurrent launch requests cannot create two updater units", async () => {
  const { repoRoot, statusFile } = fixture();
  const baseRunner = fakeRunner({ repoRoot });
  let releaseLaunch!: () => void;
  let announceLaunch!: () => void;
  const launchReleased = new Promise<void>((resolvePromise) => {
    releaseLaunch = resolvePromise;
  });
  const launchSeen = new Promise<void>((resolvePromise) => {
    announceLaunch = resolvePromise;
  });
  const runCommand: RunCommand = async (file, args, options) => {
    if (file === "sudo" && args.includes("--unit=hoopedorc-self-update")) {
      announceLaunch();
      await launchReleased;
      return { stdout: `Running as unit: ${SELF_UPDATE_UNIT}\n`, stderr: "" };
    }
    return baseRunner(file, args, options);
  };
  const updater = new SelfUpdater({
    repoRoot,
    statusFile,
    mock: false,
    platform: "linux",
    uid: 1000,
    username: "deploy",
    homeDir: "/home/deploy",
    runCommand,
  });

  const first = updater.start();
  await launchSeen;
  await assert.rejects(updater.start(), /already being launched/i);
  releaseLaunch();
  await first;
});

test("F50: a new server boot turns the durable restarting marker into success", async () => {
  const { repoRoot, statusFile } = fixture();
  mkdirSync(join(statusFile, ".."), { recursive: true });
  writeFileSync(
    statusFile,
    JSON.stringify({
      state: "restarting",
      message: "Restarting.",
      startedAt: "2026-07-16T11:55:00.000Z",
      updatedAt: "2026-07-16T11:59:00.000Z",
      fromCommit: "abc1234",
      toCommit: "def5678",
      updateUnit: SELF_UPDATE_UNIT,
    }),
  );
  const updater = new SelfUpdater({
    repoRoot,
    statusFile,
    mock: false,
    platform: "linux",
    uid: 1000,
    username: "deploy",
    homeDir: "/home/deploy",
    runCommand: fakeRunner({ repoRoot, commit: "def5678" }),
    now: () => new Date("2026-07-16T12:00:00.000Z"),
  });

  const status = await updater.status();
  assert.equal(status.state, "succeeded");
  assert.equal(status.toCommit, "def5678");
  assert.ok(status.finishedAt);
});

test("F50: mock and non-Linux deployments never launch commands", async () => {
  const { repoRoot, statusFile } = fixture();
  let calls = 0;
  const updater = new SelfUpdater({
    repoRoot,
    statusFile,
    mock: true,
    platform: "darwin",
    runCommand: async () => {
      calls += 1;
      throw new Error("should not run infrastructure commands");
    },
  });

  const status = await updater.status();
  assert.equal(status.available, false);
  assert.match(status.unavailableReason ?? "", /mock mode/i);
  assert.equal(calls, 0);
  await assert.rejects(updater.start(), /mock mode/i);
});
