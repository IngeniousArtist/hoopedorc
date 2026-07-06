# Sandbox mode for agents & gates (F13 design doc)

**Status: design only. No implementation exists yet — do not build against
this doc without re-confirming it against the code at implementation time,
the same way every item in `docs/PRODUCTIZATION_PLAN.md` gets a real-CLI
check before being trusted.**

## Why this exists

The honest current security posture (established by S5 and B11) is: agents
and gate scripts execute **directly on the host**, with the operator's own
`gh`/`claude`/`opencode` auth, real filesystem access, and real network
access. S5's `sanitizedEnv()` (`packages/adapters/src/env.ts`) strips
secret-shaped environment variables before every spawn, and Claude runs
under `--permission-mode bypassPermissions` (`packages/adapters/src/index.ts`)
— but neither of those stops a prompt-injected agent, or a hostile
`npm test`/`build` script in the repo being worked on, from reading
arbitrary files on disk, making arbitrary outbound network calls, or
modifying anything the host OS user can touch. `README.md`'s Security
section says this plainly: "there's no sandbox yet." This doc is that
sandbox's design, so F13 can be picked up later without re-deriving the
constraints from scratch.

## Goals

- Run a task's **author agent** and its **gates** (typecheck/lint/build/test,
  or `ProjectConfig.gates.testCommand`) inside a disposable, network-restricted
  environment that can't read the host's secrets or touch anything outside
  the one task's worktree.
- Keep the product's core promise intact: an agent can still `git commit`,
  `git push`, and (via `gh`) open a PR against the real target repo — the
  sandbox constrains *what the process can reach*, not what git operations
  it's allowed to perform.
- Make sandboxing **opt-in and incremental** — `SANDBOX=container` (or
  similar) as an env var, off by default, so existing native installs
  (the only verified, fully-working path as of this doc) are unaffected.

## Non-goals

- **Not a multi-tenant SaaS security boundary.** Hoopedorc is still a
  self-hosted, single-operator tool (see `docs/PRD.md` / the user's own
  framing in memory: "not a SaaS"). The sandbox protects the operator's own
  host from the operator's own (or a prompt-injected) agent — it is not
  designed to isolate mutually-untrusted tenants from each other.
- **Not a replacement for `sanitizedEnv()` or bearer-token auth (S2).**
  Those stay; the sandbox is an additional layer, not a substitute.
- **Not solving `gh`/`claude`/`opencode` auth being interactive-login-only**
  in general — see the container-auth problem below, which this doc treats
  as a constraint to design around, not something F13 fixes.
- **Not covering the *validator*'s own model call** (it doesn't touch the
  worktree's filesystem the way the author/gates do — it reads a diff and a
  gate result, both already captured as data). Sandboxing scope is author
  runs + gate execution only.

## The authenticated-CLIs-inside-a-container problem

This is the load-bearing constraint the whole design has to route around.
F10 (packaging) already hit and documented the sharpest edge of it
(`deploy/README.md`, `docs/USER_GUIDE.md`'s troubleshooting table): **on
macOS, Claude Code's login lives in the system Keychain**
(verified directly: `security find-generic-password -s
"Claude Code-credentials"` finds it) — a Linux container has **no path to
that Keychain at all**, mountable or not. `claude --help` documents a
`--bare` mode whose auth is "strictly `ANTHROPIC_API_KEY` or
`apiKeyHelper`... OAuth and keychain are never read," confirming
`ANTHROPIC_API_KEY` is the only container-compatible auth path for Claude.
The real cost implication: `ANTHROPIC_API_KEY` bills **pay-per-token via the
Anthropic Console**, not the flat rate of a Pro/Max subscription — a
sandboxed run of the Claude-backed roles (planner, and any author/validator
role mapped to `claude`) is not free just because the subscription is
already paid for.

The other two CLIs are more container-friendly but still need care:

- **`opencode`**: credentials live in a plain file
  (`~/.local/share/opencode/auth.json`, verified on macOS — `deploy/README.md`
  notes the exact path can differ by OS/install method). A read-only mount of
  that directory into the sandbox works, but it means the sandbox has a
  standing credential for every model routed through OpenCode, not just the
  one task's assigned model — narrower scoping (e.g. one OAuth grant per
  sandbox instance) isn't something OpenCode's auth model supports today.
- **`gh`**: supports `GH_TOKEN` natively (no file needed), which is the
  cleaner sandbox path — generate a fine-grained PAT scoped to the one repo
  being worked on, inject it as an env var into the sandbox only, rather than
  mounting the host's `~/.config/gh`.

**Implication for the phased rollout below:** the *author agent* stage is
where this problem bites hardest (it needs `claude`/`opencode` auth to run
at all). The *gates* stage mostly doesn't need any of these three CLIs —
`npm run test`/`build`/etc. and a free-form `testCommand` are just the
target repo's own tooling — which is exactly why gates-only sandboxing can
ship first without solving the auth problem at all.

## Worktree mount model

Today (`packages/engine/src/worktree-manager.ts`), each task gets:

- A git worktree at `${project.localPath}-wt-${task.id}` — a sibling
  directory of the primary clone, **not** nested inside it (deliberately;
  nesting would make coding agents resolve the wrong project root by
  walking up to the nearest `.git`, a historic bug documented in
  `docs/USER_GUIDE.md`'s troubleshooting table).
- A symlinked `node_modules` (see `DEPS_MARKER`/`GIT_EXCLUDE_ENTRIES` in
  `worktree-manager.ts`) so `npm ci`/`install` isn't repeated per task, with
  a `.git/info/exclude` entry so it's never accidentally `git add -A`'d into
  the task's own commit.

For a sandboxed run, the natural mapping is: **bind-mount exactly that one
worktree directory** (`task.worktreePath`) into the container at a fixed
path (e.g. `/workspace`), read-write, and nothing else from the host
filesystem. The symlinked `node_modules` needs a decision at implementation
time: either resolve the symlink and copy/bind the real `node_modules` in
too (simplest, costs disk/time per sandbox instance), or keep the shared
symlink target bind-mounted read-only alongside the worktree (cheaper, but
means the sandbox can see a directory shared across every task's sandbox
instance — acceptable, since `node_modules` isn't secret, just don't extend
the same reasoning to anything else outside the worktree).

The primary clone directory (`project.localPath` itself) and every
*other* task's worktree must **not** be reachable from inside the sandbox —
that's the actual isolation boundary; today's engine has no filesystem
enforcement of "one task can only touch its own worktree" at all beyond
convention, and this design point closes that gap incidentally.

## Network policy

Default-deny outbound, with explicit allowances for exactly what a run
needs:

- The `git`/`gh` operations against the target repo's host (typically
  `github.com` + its API/object-storage endpoints).
- Whatever the assigned model's runner needs to reach: `api.anthropic.com`
  for `claude`, or the relevant provider endpoint(s) for `opencode` (varies
  by which model — DeepSeek, GLM, Grok, OpenRouter, OpenCode Zen all have
  different endpoints; see the model roster in `packages/server/src/config.ts`
  `DEFAULT_MODELS`), or `OPENCODE_BASE_URL` if centralized sessions are in use.
  The `gates` stage additionally needs whatever the repo's own tooling
  fetches — e.g. an `npm ci` against the npm registry — which is real
  friction: a "no network at all" gates sandbox breaks any repo whose gate
  scripts install dependencies at run time, so this may need to be an
  allowlist of a small number of package-registry hosts rather than truly
  zero network.
- **Nothing else.** In particular: no reaching arbitrary URLs a
  prompt-injected agent might try to exfiltrate data to, and no reaching the
  Hoopedorc server's own API (the sandboxed process must not be able to call
  back into the orchestrator's control plane).

This is exactly the kind of allowlist that's easy to describe and hard to
get right generically across container runtimes — the implementation
decision (iptables rules in the container, a proxy sidecar, the runtime's
own network policy primitives) is deliberately left open here; whichever is
chosen must be verified against a real blocked-request test before being
trusted, per this project's established practice of checking real tool
behavior rather than assuming it.

## Env sanitization inside vs. outside

Two layers, not one:

- **Outside (already built, S5):** `sanitizedEnv()` strips secret-shaped
  vars before the host ever spawns anything — this stays exactly as-is and
  keeps protecting the *native* (non-sandboxed) path, and continues to
  gate what env vars get passed *into* the sandbox in the first place (the
  sandbox should receive an already-sanitized env, not the raw host one).
- **Inside:** the container's own env should be an even smaller, explicit
  allowlist assembled by the sandbox layer itself — the model's auth
  (`ANTHROPIC_API_KEY` for Claude, the `opencode` auth mount for others),
  `GH_TOKEN` scoped to the one repo, `PATH`/`HOME`/`NODE_*`/`npm_config_*`
  for the tooling to function, and nothing from the *host's* environment
  gets forwarded wholesale. In other words: don't sanitize-then-forward the
  host env into the container; **construct** the container's env from
  scratch out of only what that specific run needs. This is stricter than
  `sanitizedEnv()`'s denylist approach (remove secret-shaped keys) precisely
  because a container boundary makes an allowlist cheap to maintain — the
  set of things a sandboxed process legitimately needs is small and known.

## Gates in-container

The gates stage (`packages/engine/src/gate-runner.ts` — `runScript`,
`runCommand`, `checkNoConflicts`) is the simpler half to sandbox, and per
the phased rollout below, the one to build first:

- No CLI-auth problem: gate scripts are the target repo's own
  `typecheck`/`lint`/`build`/`test` (or `ProjectConfig.gates` overrides /
  `testCommand`) — plain `npm`/`execFile` calls, no `gh`/`claude`/`opencode`
  involved.
- `checkNoConflicts`'s `git merge`/`git fetch` calls do need network to
  `origin` and git itself inside the container — a much narrower ask than
  the author stage's full model-provider access.
- The existing `sanitizedEnv({ PWD: cwd })` call in `gate-runner.ts` is
  exactly the right *shape* of env for a container too (see above) — the
  container version should be even smaller.
- A gate run is naturally short-lived and disposable — spin up, run,
  capture stdout/exit code into the existing `GateResult` shape, tear down.
  This maps cleanly onto typical container-runtime "run one command in an
  ephemeral container" primitives without needing a long-lived agent
  session inside the container.

The author stage (`packages/adapters/src/index.ts` — `ClaudeAdapter`,
`OpenCodeAdapter`) is harder: it's a longer-lived, streaming, multi-turn
process (the adapters parse `stream-json`/incremental events, not a single
exit code), and it's the stage that actually needs the CLI-auth story
solved. It also needs the worktree mount to be read-write (an author agent
edits files; a gate run only needs read access to the worktree plus
write access to build/test output directories).

## Phased rollout

1. **Gates-only sandbox.** Wrap `GateRunnerImpl.runScript`/`runCommand`/
   `checkNoConflicts` to optionally execute inside a container instead of
   directly on the host, gated by (e.g.) `SANDBOX=container`. No agent
   changes at all in this phase — the author still runs natively. This
   phase alone closes most of B11's "repo's own scripts execute arbitrary
   code on the host" gap, since gate scripts are exactly the surface that
   flagged.
2. **Agents, opt-in per model.** Extend the same container mechanism to
   `AgentAdapter.run()`, starting with whichever model's auth story is
   simplest to containerize first (likely `opencode`'s file-based auth
   mount, before tackling `claude`'s `ANTHROPIC_API_KEY` cost tradeoff).
   Both `ClaudeAdapter` and `OpenCodeAdapter` implement the same interface
   today, so the container wrapper can sit at that boundary without
   touching orchestrator logic.
3. **Agents, all models, default-on.** Once both CLI-auth paths are proven
   in production use, flip the default and treat native/unsandboxed as the
   opt-out escape hatch instead of the other way around.

Each phase should ship with the same verification bar as everything else in
`docs/PRODUCTIZATION_PLAN.md`: a real container boot, a real blocked-network
test, a real task run end-to-end — not just code review.

## Open questions for whoever implements this

- Which container runtime/API (plain Docker, a rootless alternative,
  something with cheaper cold-start than Docker for short gate runs)?
  Cold-start latency matters more for gates (many short runs per task) than
  for the author stage (one longer-lived run).
- Does the `opencode` credentials mount need to be scoped narrower than
  "the whole `auth.json`" once OpenCode's own auth model allows it?
- Is there a per-task-worktree disk-cleanup story once the container exits,
  distinct from the existing `WorktreeManager.remove()`?
