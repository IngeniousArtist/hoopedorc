# Harness compatibility (VW17)

Compatibility is a set of independently verified capabilities. Setup → Harnesses
reads versions on the server using fixed `--version` commands, sanitized runtime
configuration and bounded managed processes. It makes no authentication or model
request. Mock mode returns four explicitly unprobed entries and starts no tools.
A missing CLI is recoverable with Refresh versions after operator installation.
No CLI is installed, upgraded or logged in by this endpoint.

| Harness | Inspected CLI | Native host | Selected instructions/MCP | Isolated worker | Selected native plugins |
| --- | --- | --- | --- | --- | --- |
| Claude Code | 2.1.278 | Existing adapter | Version-pinned VW12 path | Unverified | Unverified |
| Codex | 0.154.0 | Existing adapter | Unverified | VW14 profile and worker check required | Unverified |
| OpenCode | 1.18.30 | Existing adapter | Unverified | Unverified | Unverified |
| Gemini CLI | 0.60.0 | Opt-in adapter, version pinned | Refused | Refused | Unverified; inherited CLI config only |

The matrix is not a provider-access guarantee. Existing native adapters remain
available after a version change but show the mismatch. Gemini refuses other
versions until their protocol is verified. Claude selective activation retains
its exact version guard. A host Codex version does not certify a container:
Settings → Resources checks the actual worker image/profile separately.

## Gemini configuration and execution

Install the chosen CLI as the same operator who runs Hoopedorc; configure its
login outside the app. Add a Gemini model profile in Settings → Models and enter
an exact model ID available to that CLI account. No catalog command was verified,
so the app supplies no guessed model list or default route. A disabled draft can
be saved before billing is configured. Enabling requires either a subscription
account pool or all three manual token prices. The CLI reports tokens, not USD;
subscription calls remain counted with zero metered cost. Manual pricing is an
operator estimate for the selected profile, not a verified invoice (CLI-internal
model choices and provider billing can differ).

The adapter uses `--model`, `--prompt`, `--output-format stream-json`,
`--approval-mode yolo` and `--skip-trust`. The full prompt goes through stdin;
`--skip-trust` grants workspace trust for this session without modifying the
operator's persistent trust list. Existing worktree ownership and managed process
groups remain authoritative. Native host execution can access the operator's
filesystem and cached CLI credentials; it is not strong agent isolation.

`GEMINI_CLI_HOME` and `GEMINI_CLI_SYSTEM_SETTINGS_PATH` are allowed configuration
locations. Provider API keys and control-plane secrets are not inherited from the
server environment. Existing CLI-managed policy, tools, extensions, skills and
MCP configuration remain inherited. Selected activation and isolated profiles
fail closed; Gemini effort controls are not advertised or forwarded.

The parser accepts streamed assistant text and requires a valid terminal result
plus exit zero. Final aggregate stats are applied once (not added to per-model
subtotals); fresh input excludes cached tokens. Malformed/missing or duplicate
terminal output fails. Observed final usage survives a failed/cancelled call and
uses the existing exactly-once invocation ledger. If a CLI dies before reporting
usage, unreported tokens remain unknown; no adapter can reconstruct them from a
partial text stream. Scheduler retries create a new invocation; they never replay
billing on the old one. Planning, authoring, review, documentation and explicit
model tests share this adapter. Task preflight checks the version before dispatch;
the adapter rechecks at each call boundary.

## Evidence and limitations

On macOS arm64, Node 22.23.0: inspected installed help/version for Claude 2.1.278,
Codex 0.154.0 and OpenCode 1.18.30. Gemini 0.60.0 was installed only in a task-owned
temporary prefix, with scripts disabled. Its actual stream schema was inspected
in that package. A headless call using an empty temporary CLI home, empty
workspace and no provider keys exited 41 with a missing-authentication diagnostic
before a provider request. The session trust flag was verified in the same call.
No operator credential file was changed, no paid model test was made, and the
temporary CLI is not an application dependency.

Subprocess fixtures cover protocol/argv/stdin/environment isolation, success,
error/rate-limit usage, malformed/absent result, retry, cancellation and process
group settlement. Server fixtures cover planner/health ledger persistence,
exactly-once terminals and reopen/restart. These also run on Linux CI. They do
not certify a live authenticated Gemini task on Linux or AWS. Provider-powered
completion, exact account entitlement, model availability and AWS commissioning
remain operator checks. AWS is explicitly deferred because no server is set up.

Source references (reviewed 2026-09-21):

- [Gemini headless output](https://geminicli.com/docs/cli/headless/)
- [Gemini authentication](https://geminicli.com/docs/get-started/authentication/)
- [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [OpenCode CLI](https://opencode.ai/docs/cli/) and
  [configuration](https://opencode.ai/docs/config/)

Codex's `--ignore-user-config` and OpenCode's `--pure` do not establish complete
selective context isolation: project configuration/skills or other inherited
sources remain relevant. No compatibility claim is inferred from a flag name.
