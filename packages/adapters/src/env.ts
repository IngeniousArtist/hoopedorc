// Agents and planners run with broad host filesystem/network access. Their
// child environment therefore starts from a small runtime/config allowlist,
// rather than inheriting the server environment and trying to guess every
// possible spelling of a secret afterward. OAuth/config/keychain state remains
// reachable through the same user's HOME/XDG/CLI config locations; provider
// keys, application tokens, and credential handles do not cross this boundary.

const RUNTIME_KEYS = new Set(
  [
    // Executable discovery, user/config roots, locale, temp files, and terminal
    // behavior used by Claude Code, Codex, and OpenCode on Unix/macOS.
    "PATH",
    "HOME",
    "SHELL",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LANGUAGE",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "FORCE_COLOR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "XDG_DATA_DIRS",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_DATA_DIR",
    "OPENCODE_CACHE_DIR",
    // Corporate TLS/proxy support. Auth-shaped npm settings remain excluded
    // below; these names carry routing/runtime configuration only.
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "NODE_ENV",
    // Windows process/config discovery. Matching is case-insensitive.
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    // CoreFoundation uses this for locale/text encoding on macOS.
    "__CF_USER_TEXT_ENCODING",
  ].map((key) => key.toUpperCase()),
);

// Safe behavior/routing settings needed when an agent invokes npm. Keep this
// explicit: npm_config_userconfig, *_authToken, password, client key/cert, and
// other credential-bearing settings must not reach repo-controlled processes.
const SAFE_NPM_CONFIG_KEYS = new Set([
  "registry",
  "proxy",
  "https_proxy",
  "noproxy",
  "strict_ssl",
  "cafile",
  "cache",
  "offline",
  "prefer_offline",
  "prefer_online",
  "fetch_retries",
  "fetch_retry_factor",
  "fetch_retry_mintimeout",
  "fetch_retry_maxtimeout",
  "fetch_timeout",
  "loglevel",
  "color",
  "progress",
  "fund",
  "audit",
  "update_notifier",
  "legacy_peer_deps",
]);

function safeNpmConfigKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (!normalized.startsWith("npm_config_")) return false;
  return SAFE_NPM_CONFIG_KEYS.has(normalized.slice("npm_config_".length));
}

/** Safe npm settings copied into agent or sandbox environments. */
export function safeNpmConfigEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && safeNpmConfigKey(key)) env[key] = value;
  }
  return env;
}

function runtimeKey(key: string): boolean {
  const upper = key.toUpperCase();
  return RUNTIME_KEYS.has(upper) || upper.startsWith("LC_");
}

/**
 * Build the environment for an agent/planner CLI from an explicit allowlist.
 * Trusted caller overrides (normally only PWD) are applied last.
 */
export function sanitizedEnv(
  overrides: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (runtimeKey(key) || safeNpmConfigKey(key)) env[key] = value;
  }
  return { ...env, ...overrides };
}
