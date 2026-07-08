import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizedEnv } from "./env.js";

test("sanitizedEnv strips secret-shaped keys but keeps the CLI allowlist", () => {
  const saved = { ...process.env };
  try {
    process.env.TELEGRAM_BOT_TOKEN = "shh";
    process.env.OPENROUTER_API_KEY = "shh";
    process.env.DEEPSEEK_SECRET = "shh";
    process.env.DB_PASSWORD = "shh";
    process.env.SOME_CREDENTIAL = "shh";
    process.env.NODE_ENV = "test";
    process.env.NODE_AUTH_TOKEN = "keep-me"; // npm needs this; matches TOKEN but allowlisted via NODE_
    process.env.npm_config_registry = "https://registry.example";
    process.env.ANTHROPIC_API_KEY = "keep-me-too";
    process.env.CODEX_API_KEY = "keep-codex-key";
    process.env.CODEX_HOME = "/home/x/.codex";
    process.env.LC_ALL = "C";
    process.env.PATH = "/usr/bin";
    process.env.HOME = "/home/x";
    process.env.RANDOM_APP_VAR = "keep";

    const env = sanitizedEnv();

    assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(env.OPENROUTER_API_KEY, undefined);
    assert.equal(env.DEEPSEEK_SECRET, undefined);
    assert.equal(env.DB_PASSWORD, undefined);
    assert.equal(env.SOME_CREDENTIAL, undefined);

    assert.equal(env.NODE_ENV, "test");
    assert.equal(env.NODE_AUTH_TOKEN, "keep-me");
    assert.equal(env.npm_config_registry, "https://registry.example");
    assert.equal(env.ANTHROPIC_API_KEY, "keep-me-too");
    assert.equal(env.CODEX_API_KEY, "keep-codex-key");
    assert.equal(env.CODEX_HOME, "/home/x/.codex");
    assert.equal(env.LC_ALL, "C");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/home/x");
    assert.equal(env.RANDOM_APP_VAR, "keep");
  } finally {
    process.env = saved;
  }
});

test("sanitizedEnv applies overrides after stripping, so they always win", () => {
  const env = sanitizedEnv({ PWD: "/tmp/worktree" });
  assert.equal(env.PWD, "/tmp/worktree");
});
