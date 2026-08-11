#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import dotenv from "dotenv";

const ALLOWED_KEYS = new Set(["PORT", "API_TOKEN"]);
const [file, key, ...extra] = process.argv.slice(2);

if (!file || !key || extra.length > 0 || !ALLOWED_KEYS.has(key)) {
  console.error("Usage: read-update-env.mjs <env-file> <PORT|API_TOKEN>");
  process.exitCode = 2;
} else {
  try {
    const values = dotenv.parse(await readFile(file));
    const value = values[key] ?? "";
    if (value.includes("\0")) {
      throw new Error("NUL cannot be represented in a shell variable");
    }
    process.stdout.write(value);
    process.stdout.write("\0");
  } catch {
    console.error("Could not safely read the requested update setting.");
    process.exitCode = 1;
  }
}
