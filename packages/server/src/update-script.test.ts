import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
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

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const updateScript = join(repositoryRoot, "scripts", "update.sh");
const updateEnvReader = join(repositoryRoot, "scripts", "read-update-env.mjs");

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
  symlinkSync(join(repositoryRoot, "node_modules"), join(root, "node_modules"), "dir");
  const source = readFileSync(updateScript, "utf8");
  const script = join(scripts, "update.sh");
  executable(script, source);
  writeFileSync(
    join(scripts, "read-update-env.mjs"),
    readFileSync(updateEnvReader, "utf8"),
  );

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
authorization=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -H)
      authorization="$2"
      shift 2
      ;;
    http://*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
if [ -n "\${FAKE_EXPECTED_PORT:-}" ] && [ "$url" != "http://127.0.0.1:\${FAKE_EXPECTED_PORT}/api/projects" ]; then
  echo '{"error":"unexpected probe port"}'
  exit 0
fi
if [ -n "\${FAKE_EXPECTED_TOKEN:-}" ] && [ "$authorization" != "Authorization: Bearer \${FAKE_EXPECTED_TOKEN}" ]; then
  echo '{"error":"unexpected probe credentials"}'
  exit 0
fi
if [ "\${FAKE_SERVER_UNREACHABLE:-0}" = "1" ]; then
  exit 7
fi
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

function runInteractive(f: ScriptFixture, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    "bash",
    [
      f.script,
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

function readUpdateEnvValue(contents: string, key: "PORT" | "API_TOKEN"): string {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-update-env-"));
  const envFile = join(root, ".env");
  writeFileSync(envFile, contents);
  const result = spawnSync(process.execPath, [updateEnvReader, envFile, key], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.endsWith("\0"), true);
  return result.stdout.slice(0, -1);
}

test("O19: the env helper parses supported dotenv syntax without evaluation", () => {
  const cases: Array<{
    name: string;
    contents: string;
    key: "PORT" | "API_TOKEN";
    expected: string;
  }> = [
    {
      name: "unquoted",
      contents: "API_TOKEN=plain-token\n",
      key: "API_TOKEN",
      expected: "plain-token",
    },
    {
      name: "single quoted",
      contents: "API_TOKEN='single # token=value'\n",
      key: "API_TOKEN",
      expected: "single # token=value",
    },
    {
      name: "double quoted",
      contents: 'API_TOKEN="double # token=value"\n',
      key: "API_TOKEN",
      expected: "double # token=value",
    },
    {
      name: "export prefixed",
      contents: "export PORT=4318\n",
      key: "PORT",
      expected: "4318",
    },
    {
      name: "assignment whitespace",
      contents: '  API_TOKEN = " padded value "  \n',
      key: "API_TOKEN",
      expected: " padded value ",
    },
    {
      name: "comment",
      contents: "# ignored\nAPI_TOKEN=kept # trailing comment\n",
      key: "API_TOKEN",
      expected: "kept",
    },
    {
      name: "empty",
      contents: "API_TOKEN=\n",
      key: "API_TOKEN",
      expected: "",
    },
    {
      name: "malformed named line",
      contents: "API_TOKEN\nPORT=4317\n",
      key: "API_TOKEN",
      expected: "",
    },
  ];

  for (const { name, contents, key, expected } of cases) {
    assert.equal(readUpdateEnvValue(contents, key), expected, name);
  }

  const root = mkdtempSync(join(tmpdir(), "hoopedorc-update-env-command-"));
  const marker = join(root, "must-not-exist");
  const literal = `$(touch ${marker})`;
  assert.equal(readUpdateEnvValue(`API_TOKEN=${literal}\n`, "API_TOKEN"), literal);
  assert.equal(existsSync(marker), false);
});

test("O19: the env helper exposes only fixed keys and credential-free errors", () => {
  const root = mkdtempSync(join(tmpdir(), "hoopedorc-update-env-refusal-"));
  const envFile = join(root, ".env");
  const secret = "o19-never-log-this-secret";
  writeFileSync(envFile, `UNRELATED_SECRET=${secret}\n`);

  const invalidKey = spawnSync(
    process.execPath,
    [updateEnvReader, envFile, "UNRELATED_SECRET"],
    { encoding: "utf8" },
  );
  assert.notEqual(invalidKey.status, 0);
  assert.equal(invalidKey.stdout, "");
  assert.equal(invalidKey.stderr.includes(secret), false);

  const missingFile = spawnSync(
    process.execPath,
    [updateEnvReader, join(root, "missing.env"), "API_TOKEN"],
    { encoding: "utf8" },
  );
  assert.notEqual(missingFile.status, 0);
  assert.equal(missingFile.stdout, "");
  assert.equal(missingFile.stderr.includes(secret), false);
});

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

test("O19: the updater parses quoted export-prefixed port and token values", () => {
  const f = fixture();
  const token = "o19 token # with=separators";
  writeFileSync(
    join(f.root, ".env"),
    `export PORT = "4318"\nexport API_TOKEN = '${token}'\n`,
  );

  const result = run(f, {
    FAKE_EXPECTED_PORT: "4318",
    FAKE_EXPECTED_TOKEN: token,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(token), false);
  assert.equal(result.stderr.includes(token), false);
});

test("O19: an unreachable server stays fail-closed without logging the token", () => {
  const f = fixture();
  const token = "o19-unreachable-secret";
  writeFileSync(join(f.root, ".env"), `API_TOKEN='${token}'\n`);

  const result = run(f, { FAKE_SERVER_UNREACHABLE: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /server is unreachable/i);
  assert.equal(result.stdout.includes(token), false);
  assert.equal(result.stderr.includes(token), false);
  assert.throws(() => readFileSync(f.logFile, "utf8"));
});

test("O19: interactive recovery retains its explicit unreachable fallback", () => {
  const f = fixture();
  const result = runInteractive(f, { FAKE_SERVER_UNREACHABLE: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /server not reachable.*skipping/i);

  const log = readFileSync(f.logFile, "utf8");
  assert.match(log, /git pull/);
  assert.match(log, /systemctl restart/);
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
