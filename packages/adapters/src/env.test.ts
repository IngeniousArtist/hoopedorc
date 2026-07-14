import assert from "node:assert/strict";
import { test } from "node:test";
import { safeNpmConfigEnv, sanitizedEnv } from "./env.js";

test("sanitizedEnv starts from a runtime allowlist and drops provider/application credentials", () => {
  const source: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/operator",
    CODEX_HOME: "/home/operator/.codex-custom",
    CLAUDE_CONFIG_DIR: "/home/operator/.claude-custom",
    XDG_DATA_HOME: "/home/operator/.local/share",
    LC_ALL: "C",
    NODE_ENV: "test",
    NODE_EXTRA_CA_CERTS: "/etc/corporate.pem",
    HTTPS_PROXY: "http://proxy.example",
    ANTHROPIC_API_KEY: "anthropic-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-secret",
    CODEX_API_KEY: "codex-secret",
    OPENAI_API_KEY: "openai-secret",
    OPENROUTER_API_KEY: "openrouter-secret",
    DEEPSEEK_API_KEY: "deepseek-secret",
    GROK_API_KEY: "grok-secret",
    TELEGRAM_BOT_TOKEN: "telegram-secret",
    API_TOKEN: "app-secret",
    GH_TOKEN: "github-secret",
    GITHUB_TOKEN: "github-secret-2",
    SSH_AUTH_SOCK: "/tmp/credential-agent.sock",
    RANDOM_APP_VAR: "not-runtime-config",
  };

  const env = sanitizedEnv({}, source);

  for (const key of [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    "GROK_API_KEY",
    "TELEGRAM_BOT_TOKEN",
    "API_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "SSH_AUTH_SOCK",
    "RANDOM_APP_VAR",
  ]) {
    assert.equal(env[key], undefined, key);
  }

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/operator");
  assert.equal(env.CODEX_HOME, "/home/operator/.codex-custom");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/home/operator/.claude-custom");
  assert.equal(env.XDG_DATA_HOME, "/home/operator/.local/share");
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.NODE_EXTRA_CA_CERTS, "/etc/corporate.pem");
  assert.equal(env.HTTPS_PROXY, "http://proxy.example");
});

test("safe npm config preserves routing/behavior but strips registry credentials and config indirection", () => {
  const source: NodeJS.ProcessEnv = {
    npm_config_registry: "https://registry.example",
    NPM_CONFIG_HTTPS_PROXY: "http://proxy.example",
    npm_config_audit: "false",
    npm_config__authToken: "npm-secret",
    NPM_CONFIG_PASSWORD: "npm-password",
    npm_config_userconfig: "/tmp/secret-npmrc",
    npm_config_key: "/tmp/client.key",
    npm_config_cert: "/tmp/client.crt",
    NODE_AUTH_TOKEN: "node-secret",
  };

  const npm = safeNpmConfigEnv(source);
  assert.equal(npm.npm_config_registry, "https://registry.example");
  assert.equal(npm.NPM_CONFIG_HTTPS_PROXY, "http://proxy.example");
  assert.equal(npm.npm_config_audit, "false");
  assert.equal(npm.npm_config__authToken, undefined);
  assert.equal(npm.NPM_CONFIG_PASSWORD, undefined);
  assert.equal(npm.npm_config_userconfig, undefined);
  assert.equal(npm.npm_config_key, undefined);
  assert.equal(npm.npm_config_cert, undefined);
  assert.equal(npm.NODE_AUTH_TOKEN, undefined);

  const agent = sanitizedEnv({}, source);
  assert.deepEqual(agent, npm);
});

test("sanitizedEnv applies trusted caller overrides last", () => {
  const env = sanitizedEnv(
    { PWD: "/tmp/worktree" },
    { PWD: "/wrong", PATH: "/usr/bin" },
  );
  assert.equal(env.PWD, "/tmp/worktree");
  assert.equal(env.PATH, "/usr/bin");
});
