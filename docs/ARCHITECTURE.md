# Architecture

## One TypeScript monorepo (npm workspaces)

```
@orc/types     shared domain model + REST/WS contract        (the contract)
@orc/adapters  Claude Code + OpenCode + Codex runners        (deepseek-flash)
@orc/engine    scheduler, worktrees, git/PR, gates, validator,
               Docker gate sandbox                            (deepseek-pro)
@orc/server    Fastify REST + WS, SQLite persistence,
               planner, Telegram bot, scheduler               (deepseek-flash)
@orc/web       React kanban UI, live logs, settings           (glm)
```

(The parenthetical model names record which agent originally built each
package in the dogfooded initial rounds — see the README's closing note.)

Dependency rule: every package depends on `@orc/types` and nothing else
horizontal. `engine` may use `adapters`. `server` wires `engine` + `adapters`
together at the edge (Round 2 integration). `web` talks only to the HTTP/WS API.

## Runtime picture

```
                 ┌──────────────┐   WS (logs/board)   ┌──────────────┐
                 │   @orc/web    │◀───────────────────▶│  @orc/server │
                 │  (browser UI) │   REST (/api/*)     │  Fastify+WS  │
                 └──────────────┘                      │   SQLite     │
                                                       └──────┬───────┘
                                                              │ drives
                                                       ┌──────▼───────┐
                                                       │  @orc/engine │
                                                       │ DAG + gates  │
                                                       │ + validator  │
                                                       └──────┬───────┘
                                              creates worktrees, runs models
                     ┌────────────────────────────────────────┼────────────────────────┐
                     ▼                                        ▼                        ▼
             ┌───────────────┐                      ┌──────────────────┐      ┌───────────────┐
             │ ClaudeAdapter │ claude -p            │ OpenCodeAdapter  │      │ CodexAdapter  │
             │ (Claude sub)  │                      │ opencode run     │      │ codex exec    │
             └───────────────┘                      │ (GLM, Deepseek,  │      │ (ChatGPT sub) │
                                                    │  Grok, Nex, …)   │      └───────────────┘
                                                    └──────────────────┘
```

Gate scripts and dependency installs run through `@orc/engine`'s Docker
sandbox (`sandbox.ts`) when a daemon is reachable — a disposable
`docker run --rm` per command, mounting only the task's worktree (rw) and
the shared dependency install (ro), with an allowlist env built from
scratch. Agents themselves still run on the host (sandbox phases 2–3 are
future work; see `docs/specs/sandbox.md`).

Every author, validator, documenter, and planner CLI receives the same
`sanitizedEnv()` boundary: an explicit runtime/config allowlist containing the
same user's HOME/XDG/CLI config roots, locale, PATH, platform requirements, and
non-credential npm registry/proxy settings. Server/provider/GitHub/Telegram
tokens and npm auth/password/config-indirection variables are not forwarded.
This limits accidental environment leakage but does not sandbox host filesystem
or network access; a host-run model can still reach files available to that OS
user.

Settings have two timing classes. Runner/model/effort are snapshotted directly
before each CLI invocation so an in-flight process is never killed or mutated by
a settings save. Operational policy is read from the validated SQLite settings
row at each decision boundary: dispatch and fallback routing, enabled state,
budgets/quotas, approval holds, merge policy, notification gates, and manual
pricing. Defaults, migrations, HTTP/Telegram writes, repository reads, and
runtime access all share the same normalizer, so an active scheduler never sees
a shape that the API would reject.

## Why this split
- **One language (TS)** so the parallel agents share `@orc/types` and can't drift.
- **OpenCode as the single gateway** for all API-billed models — one CLI
  instead of six provider SDKs; Grok's OAuth lives inside OpenCode.
- **Claude Code and Codex headless** as native runners so each subscription
  bills at its flat rate; the planner is swappable between the two
  (`routing.planner` + that model's `runner`).
- **Git worktrees** give each task an isolated working dir on shared history, so
  models work in parallel without colliding; PRs + gates protect `main`.

## Process / deploy
- Local: `npm run dev` (all packages in watch) or `npm run mock` (UI + fake API).
- Production: `npm run build` once, then `npm run start:prebuilt` under the
  provided systemd unit (`deploy/hoopedorc.service`) — one process serves the
  API and the built web app; `npm run update` pulls/rebuilds/restarts in
  place. The CLIs (`gh`/`claude`/`opencode`, optionally `codex`) must be
  authenticated on the box as the service user. Full ordered walkthrough:
  USER_GUIDE's "Deploying to EC2 — checklist".

## Key decisions (locked)
- Merge policy: **hard gate + flag risky** (`Settings.mergePolicy`; a
  fully-autonomous mode exists but flag-risky is the default).
- Validator: configurable per difficulty (`Settings.validatorByDifficulty`),
  **never the same model as the author** — enforced at settings-save time.
- DB: **SQLite** (single-operator, local-first), with daily online-backup
  rotation.
- One project lives on exactly one instance — nothing deduplicates across
  servers (see USER_GUIDE's "Two boxes" section for the Mac↔EC2 split).
