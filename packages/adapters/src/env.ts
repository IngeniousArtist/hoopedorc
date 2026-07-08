// Spawned agents run with --permission-mode bypassPermissions (Claude) or
// full tool access (opencode), and gate scripts execute whatever `npm run
// <script>` a repo defines — both are untrusted, repo-controlled surfaces (a
// prompt-injected model, or simply a hostile package.json test script). The
// server's process.env typically holds TELEGRAM_BOT_TOKEN and provider API
// keys; inheriting it wholesale lets either surface read and exfiltrate them.
//
// Strip anything secret-shaped before handing the environment to a child
// process, keeping only what the CLIs (git/npm/node/claude/opencode)
// actually need to run.
const SECRET_PATTERN = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|TELEGRAM/i;

const EXACT_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "TMPDIR",
  "LANG",
  // Codex CLI reads its own credentials/config location from these even
  // under a sanitized env — same reasoning as the ANTHROPIC_ allowlist
  // below, just without a shared prefix to key off of.
  "CODEX_API_KEY",
  "CODEX_HOME",
]);

function isAllowlisted(key: string): boolean {
  return (
    EXACT_ALLOWLIST.has(key) ||
    key.startsWith("LC_") ||
    key.startsWith("NODE_") ||
    key.startsWith("npm_config_") ||
    // Claude Code reads its own credentials from these even under a
    // sanitized env — without them the CLI can't authenticate at all.
    key.startsWith("ANTHROPIC_")
  );
}

/**
 * A copy of `process.env` with secret-shaped keys removed, merged with
 * `overrides` (applied last, so e.g. `{ PWD: cwd }` always wins).
 */
export function sanitizedEnv(
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SECRET_PATTERN.test(key) && !isAllowlisted(key)) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}
