# Selective invocation capabilities (VW12)

Library → Agent capabilities stores immutable project activation revisions.
Revision zero preserves existing CLI configuration. `hoop-activation:N` pins a
task; otherwise each invocation resolves the current default. Planning resolves
once for the operation, including deconstruction retries and Figma probes.
Author, reviewer and documentation calls use the task selection. Existing calls
never reread their policy. This is context management, not filesystem isolation;
repository CLAUDE.md and managed policy remain inherited.

## Verified compatibility

Claude Code **2.1.278**, locally on macOS, supports selected Library instruction
snapshots and MCP registrations. Launch flags are `--setting-sources ''`,
`--disable-slash-commands`, `--strict-mcp-config`, `--mcp-config <owned-file>` and
`--settings '{"disableAllHooks":true}'`. The private temporary directory and
0600 config contain only selected MCPs. User settings/auth files are not copied
or edited. Normal/selective `claude auth status` must agree on a logged-in
authentication method/provider. `--bare` is unused because it excludes OAuth.

Bounded control initialization checks connected MCPs, an empty command catalog
and only verified builtin agents before sending a model request. The invocation
repeats the check against its cwd; a ten-second preflight cache avoids duplicate
eligibility checks. No probe sends a user message/model request. Configured MCPs
start during these checks; registration/save alone never starts them.

The synthetic positive control loaded an unwanted skill, plugin agent, plugin
MCP and SessionStart hook. Selective flags excluded them and exposed only an
explicit inert MCP; the production probe repeated this. MCP status exposes tool
names but omits most input schemas in this version; manifests leave those hashes
absent. Hoopedorc's browser schemas are owned/tested. Installed-CLI discovery
exposed all three real browser bridge tools; Playwright calls produced PNG,
trace and diagnostics, and cancellation settled the worker.

Read-only auth status stayed logged in as `oauth_token`/`firstParty` in both
modes. No paid model request was sent. Authenticated model use is a remaining
live check. AWS checks are owner-deferred: the former host is shut down and no
replacement exists. Linux/AWS compatibility is not inferred from macOS evidence.

Codex 0.154.0 and OpenCode 1.18.30 were inspected; selective mode is explicitly
unsupported. Codex required exact SKILL.md paths for exclusions in the installed
version; OpenCode merges configuration and can depend on authentication plugins.
Both retain inherited mode. Native plugin bundles are unsupported in selective
mode: enabling agents while disabling the bundle's skills/hooks/MCPs is not full
activation. Use explicit skills/MCP registrations. VW17 owns more compatibility;
unknown Claude versions refuse selective mode rather than guessing.

Primary references: [Claude CLI](https://code.claude.com/docs/en/cli-reference),
[plugins](https://code.claude.com/docs/en/plugins-reference),
[MCP](https://code.claude.com/docs/en/mcp),
[Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
[OpenCode configuration](https://opencode.ai/docs/config/),
[OpenCode skills](https://opencode.ai/docs/skills/).

## Browser lifecycle

Explicit author/reviewer selections receive `hoop-browser`: ephemeral loopback
HTTP MCP, random invocation-scoped bearer, never the control-plane token.
Browser Origin headers are rejected. `browser_status`, `browser_start` and
`browser_capture` accept no task/project/command/URL override. Start uses the
saved preview profile; capture uses a relative path, bounded viewport and typed
steps. The VW10 supervisor supplies a fresh browser context and existing
evidence/retention rules. PNGs up to 1 MiB can be returned to the agent; every
artifact remains in Review.

Path, worktree, attempt and generation are revalidated per action. One mutating
call at a time, at most twenty per invocation. Closing revokes calls, closes the
endpoint, settles owned checks and stops only a preview it started. Operator
previews survive. Cleanup failure blocks success while preserving incurred model
usage. Restart cannot reconnect an old bridge; unfinished checks follow VW10
recovery. Planning/docs show browser unavailable-outside-task. No second
scheduler, model ledger or approval path is added.
