import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

interface ScriptFixture {
  root: string;
  script: string;
  statusFile: string;
  logFile: string;
  env: NodeJS.ProcessEnv;
}

function executable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function fixture(): ScriptFixture {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-update-script-"));
  const bin = join(root, "bin");
  const scripts = join(root, "scripts");
  const statusFile = join(root, "state", "update.json");
  const logFile = join(root, "commands.log");
  const pullMarker = join(root, "pulled");
  mkdirSync(bin);
  mkdirSync(scripts);
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/update.sh"),
    "utf8",
  );
  const script = join(scripts, "update.sh");
  executable(script, source);

  executable(
    join(bin, "git"),
    `#!/usr/bin/env bash
case "$1" in
  status)
    [ "\${FAKE_GIT_DIRTY:-0}" = "1" ] && echo "?? unrelated.txt"
    exit 0
    ;;
  branch)
    echo "\${FAKE_GIT_BRANCH:-main}"
    ;;
  rev-parse)
    if [ -f "$FAKE_PULL_MARKER" ]; then echo "def5678"; else echo "abc1234"; fi
    ;;
  pull)
    echo "git pull" >> "$FAKE_LOG"
    touch "$FAKE_PULL_MARKER"
    ;;
  *)
    echo "unexpected git command: $*" >&2
    exit 1
    ;;
esac
`,
  );
  executable(
    join(bin, "systemctl"),
    `#!/usr/bin/env bash
case "$1" in
  list-unit-files)
    echo "hoopedorc.service enabled"
    ;;
  show)
    echo "$FAKE_REPO_ROOT"
    ;;
  restart)
    echo "systemctl restart" >> "$FAKE_LOG"
    ;;
  *)
    echo "unexpected systemctl command: $*" >&2
    exit 1
    ;;
esac
`,
  );
  executable(
    join(bin, "sudo"),
    `#!/usr/bin/env bash
if [ "$1" = "-n" ]; then shift; fi
if [ "$1" = "-l" ]; then
  shift
  if [ "\${FAKE_SUDO_DENY_RESTART:-0}" = "1" ]; then
    echo "not allowed" >&2
    exit 1
  fi
  exit 0
fi
exec "$@"
`,
  );
  executable(
    join(bin, "curl"),
    `#!/usr/bin/env bash
if [ "\${FAKE_ACTIVE_PROJECT:-0}" = "1" ]; then
  echo '{"projects":[{"status":"running"}]}'
elif [ "\${FAKE_INVALID_PROJECT_RESPONSE:-0}" = "1" ]; then
  echo '{"error":"unauthorized"}'
else
  echo '{"projects":[]}'
fi
`,
  );
  executable(
    join(bin, "npm"),
    `#!/usr/bin/env bash
echo "npm $*" >> "$FAKE_LOG"
`,
  );

  return {
    root,
    script,
    statusFile,
    logFile,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_LOG: logFile,
      FAKE_PULL_MARKER: pullMarker,
      FAKE_REPO_ROOT: root,
    },
  };
}

function run(f: ScriptFixture, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    "bash",
    [
      f.script,
      "--non-interactive",
      "--require-main",
      "--require-systemd-restart",
      "--status-file",
      f.statusFile,
      "--started-at",
      "2026-07-16T12:00:00.000Z",
    ],
    {
      cwd: f.root,
      env: { ...f.env, ...extraEnv },
      encoding: "utf8",
    },
  );
}

test("F50: non-interactive update runs pull, ci, build, and exact systemd restart", () => {
  const f = fixture();
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);

  const log = readFileSync(f.logFile, "utf8");
  assert.match(log, /git pull/);
  assert.match(log, /npm ci/);
  assert.match(log, /npm run build/);
  assert.match(log, /systemctl restart/);

  const status = JSON.parse(readFileSync(f.statusFile, "utf8")) as {
    state: string;
    message: string;
    fromCommit: string;
  };
  assert.equal(status.state, "succeeded");
  assert.match(status.message, /restarted successfully/i);
  assert.equal(status.fromCommit, "abc1234");
});

test("F50: active projects are refused before Git pull", () => {
  const f = fixture();
  const result = run(f, { FAKE_ACTIVE_PROJECT: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /at least one project is currently running/i);
  assert.throws(() => readFileSync(f.logFile, "utf8"));

  const status = JSON.parse(readFileSync(f.statusFile, "utf8")) as {
    state: string;
    message: string;
  };
  assert.equal(status.state, "failed");
  assert.match(status.message, /currently running/i);
});

test("F50: a dirty checkout is refused before network or dependency changes", () => {
  const f = fixture();
  const result = run(f, { FAKE_GIT_DIRTY: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /uncommitted or untracked changes/i);
  assert.throws(() => readFileSync(f.logFile, "utf8"));

  const status = JSON.parse(readFileSync(f.statusFile, "utf8")) as {
    state: string;
  };
  assert.equal(status.state, "failed");
});

test("F50: an unauthorized or malformed project response fails closed", () => {
  const f = fixture();
  const result = run(f, { FAKE_INVALID_PROJECT_RESPONSE: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not prove that every project is idle/i);
  assert.throws(() => readFileSync(f.logFile, "utf8"));
});

test("F50: a non-main checkout is refused before Git pull", () => {
  const f = fixture();
  const result = run(f, { FAKE_GIT_BRANCH: "release-test" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be on main.*release-test/i);
  assert.throws(() => readFileSync(f.logFile, "utf8"));
});

test("F50: missing passwordless restart permission is refused before Git pull", () => {
  const f = fixture();
  const result = run(f, { FAKE_SUDO_DENY_RESTART: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot restart.*without a password/i);
  assert.throws(() => readFileSync(f.logFile, "utf8"));
});
