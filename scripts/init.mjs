#!/usr/bin/env node
// Interactive-ish setup: create .env from .env.example if missing, then check
// the three CLIs the app depends on (gh / claude / opencode). Standalone (no
// build required) so it works before `npm install`/`npm run build` ever runs.
import { execFile } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function ensureEnv() {
  const envPath = join(root, ".env");
  const examplePath = join(root, ".env.example");
  if (existsSync(envPath)) {
    console.log(".env already exists — leaving it untouched.");
    return;
  }
  if (existsSync(examplePath)) {
    copyFileSync(examplePath, envPath);
    console.log("Created .env from .env.example — edit it if you need non-default ports/hosts.");
  } else {
    console.log("No .env.example found to copy from — skipping.");
  }
}

async function check(name, cmd, args) {
  try {
    const { stdout, stderr } = await pexecFile(cmd, args, { timeout: 10_000 });
    const firstLine = (stdout || stderr || "ok").trim().split("\n")[0];
    console.log(`  ✅ ${name} — ${firstLine}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  ❌ ${name} — ${message.trim().split("\n")[0]}`);
    return false;
  }
}

console.log("hoopedorc setup\n");
ensureEnv();
console.log("\nChecking CLI auth (gh / claude / opencode)...\n");

const results = await Promise.all([
  check("GitHub CLI (gh)", "gh", ["auth", "status"]),
  check("Claude Code (claude)", "claude", ["--version"]),
  check("OpenCode (opencode)", "opencode", ["auth", "list"]),
]);

console.log();
if (results.every(Boolean)) {
  console.log("All set. Run `npm run start` (or `hoopedorc start`) to boot the app.");
} else {
  console.log("Fix the ❌ item(s) above (install/auth the CLI), then re-run `npm run setup`.");
  process.exitCode = 1;
}
