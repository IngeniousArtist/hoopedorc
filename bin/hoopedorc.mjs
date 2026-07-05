#!/usr/bin/env node
// Thin CLI wrapper so a global/linked install can run `hoopedorc start` /
// `hoopedorc init` instead of remembering the npm script names.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cmd = process.argv[2];

function runNpmScript(script) {
  const child = spawn("npm", ["run", script], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    console.error(err.message);
    process.exit(1);
  });
}

const USAGE = `Usage: hoopedorc <start|init>

  start   Build everything and run the server (also serves the built web app).
  init    Create .env from .env.example (if missing) and check gh/claude/opencode auth.
`;

switch (cmd) {
  case "start":
    runNpmScript("start");
    break;
  case "init":
    runNpmScript("setup");
    break;
  default:
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
}
