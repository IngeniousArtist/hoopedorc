import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execManagedProcess } from "@orc/adapters";
import type { Project, Task } from "@orc/types";
import { probeEnvironment, environmentFile } from "./environment.js";
import { WorktreeManagerImpl } from "./worktree-manager.js";
import { GateRunnerImpl } from "./gate-runner.js";

const profile = { runtime: "python3" as const, platform: "any" as const, majorVersion: 3, output: "artifacts" as const, setupInputs: ["bootstrap.txt"], setupOutputs: [".hoopedorc-venv/pyvenv.cfg"] };
function project(path: string, remote: string): Project { return { id: "python", name: "Python backend", repoUrl: remote, localPath: path, defaultBranch: "main", status: "planned", createdAt: "", updatedAt: "", config: { environment: profile, setupCommand: { command: "python3", args: ["-m", "venv", "--without-pip", ".hoopedorc-venv"] }, gates: { commands: { typecheck: false, lint: false, build: false, tests: { command: ".hoopedorc-venv/bin/python", args: ["-B", "-m", "unittest", "discover", "-s", "tests", "-v"] } } } } }; }
test("VW16: environment requirements reject wrong hosts/versions and do not execute a probe for an incompatible host", async () => {
  const p = project("/unused", ""); let calls = 0;
  const execute = () => { calls++; return Promise.resolve({ stdout: "Python 3.12.1" }); };
  p.config!.environment = { ...profile, platform: "darwin" };
  await assert.rejects(probeEnvironment(p, true, execute), /requires darwin/); assert.equal(calls, 0);
  p.config!.environment = { ...profile, majorVersion: 2 };
  await assert.rejects(probeEnvironment(p, false, execute, "linux"), /requires python3 major 2/);
  p.config!.environment = profile;
  assert.match(await probeEnvironment(p, false, execute, "linux") ?? "", /Python 3.12.1/);
  await assert.rejects(probeEnvironment(p, false, () => Promise.resolve({ stdout: "garbage" }), "linux"), /Cannot verify/);
});

test("VW16: real Python backend setup, literal arguments, failure, cancellation, restart/retry and retained gate output", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hoop-python-")); const path = join(root, "primary"); const remote = join(root, "remote.git");
  const git = (args: string[], cwd = root) => execManagedProcess("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
  const p = project(path, remote); const settings = { sandboxGates: "off" as const }; let manager = new WorktreeManagerImpl(settings);
  const task: Task = { id: "backend", projectId: p.id, title: "Backend", description: "Validate backend behavior", status: "ready", difficulty: "easy", assignedModel: "fixture", dependsOn: [], acceptanceCriteria: ["Health responds and missing records are refused"], scopePaths: ["**/*"], attempts: 0, maxAttempts: 1, runGeneration: 0, runExtraAttempts: 0, runExhaustedModels: [], runRateLimitRetries: 0, createdAt: "", updatedAt: "" };
  try {
    await git(["init", "--bare", "--initial-branch=main", remote]); await git(["clone", remote, path]); mkdirSync(join(path, "tests"));
    writeFileSync(join(path, "bootstrap.txt"), "v1");
    writeFileSync(join(path, "backend.py"), 'import json\nfrom http.server import BaseHTTPRequestHandler\nclass Backend(BaseHTTPRequestHandler):\n def do_GET(self):\n  status, result = (200, {"status": "ok"}) if self.path == "/health" else (404, {"error": "not found"})\n  self.send_response(status)\n  self.send_header("Content-Type", "application/json")\n  self.end_headers()\n  self.wfile.write(json.dumps(result).encode())\n def log_message(self, *args): pass\n');
    writeFileSync(join(path, "tests/test_backend.py"), 'import json, unittest, threading, urllib.request, urllib.error\nfrom http.server import ThreadingHTTPServer\nfrom backend import Backend\nclass Integration(unittest.TestCase):\n def test_health_and_missing_record(self):\n  server=ThreadingHTTPServer(("127.0.0.1",0),Backend)\n  worker=threading.Thread(target=server.serve_forever)\n  worker.start()\n  url="http://127.0.0.1:"+str(server.server_port)\n  try:\n   with urllib.request.urlopen(url+"/health") as response: self.assertEqual(json.load(response), {"status":"ok"})\n   with self.assertRaises(urllib.error.HTTPError) as error: urllib.request.urlopen(url+"/missing")\n   self.assertEqual(error.exception.code,404)\n  finally: server.shutdown(); worker.join(); server.server_close()\n');
    await git(["add", "."], path); await git(["commit", "-m", "Python backend fixture"], path); await git(["push", "origin", "main"], path);
    assert.equal((await manager.setupHealth(p)).ok, true);
    const workspace = await manager.create(p, task); task.worktreePath = workspace.path; task.branch = workspace.branch;
    const marker = join(workspace.path, ".hoopedorc-setup-hash"); const initial = readFileSync(marker, "utf8");
    let result = await new GateRunnerImpl(manager, settings).run(p, task);
    assert.equal(result.tests, true, result.details.tests); assert.match(result.environment ?? "", /Python 3\./); assert.match(result.details.tests, /test_health_and_missing_record.*ok/);
    // A fresh manager represents a process restart; immutable setup remains reusable.
    manager = new WorktreeManagerImpl(settings); await manager.prepareForGates(p, task); assert.equal(readFileSync(marker, "utf8"), initial);
    writeFileSync(join(workspace.path, "bootstrap.txt"), "v2"); await manager.prepareForGates(p, task); assert.notEqual(readFileSync(marker, "utf8"), initial);
    await git(["restore", "bootstrap.txt"], workspace.path);
    p.config!.gates!.commands!.tests = { command: ".hoopedorc-venv/bin/python", args: ["-B", "-c", "import sys; print(sys.argv[1]); sys.exit(1)", "literal space;$(not-a-shell)"] };
    result = await new GateRunnerImpl(manager, settings).run(p, task); assert.equal(result.tests, false); assert.match(result.details.tests, /literal space;\$\(not-a-shell\)/);
    p.config!.gates!.commands!.tests = { command: "no-such-hoop-tool", args: [] };
    assert.equal((await new GateRunnerImpl(manager, settings).run(p, task)).tests, false);
    const controller = new AbortController();
    p.config!.gates!.commands!.tests = { command: ".hoopedorc-venv/bin/python", args: ["-B", "-c", "import time; time.sleep(30)"] };
    const timer = setTimeout(() => controller.abort(), 300);
    await assert.rejects(new GateRunnerImpl(manager, settings).run(p, task, controller.signal)); clearTimeout(timer);
    p.config!.gates = project(path, remote).config!.gates;
    result = await new GateRunnerImpl(manager, settings).run(p, task); assert.equal(result.tests, true, result.details.tests);
    rmSync(join(workspace.path, ".hoopedorc-venv"), { recursive: true }); await manager.prepareForGates(p, task); assert.equal(existsSync(join(workspace.path, ".hoopedorc-venv/pyvenv.cfg")), true);
    symlinkSync(join(path, "bootstrap.txt"), join(workspace.path, "escape.txt")); assert.throws(() => environmentFile(workspace.path, "escape.txt"), /inside this workspace/); rmSync(join(workspace.path, "escape.txt"));
    await manager.remove(p, task); assert.equal(existsSync(workspace.path), false); assert.equal((await git(["status", "--porcelain"], path)).stdout.trim(), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
