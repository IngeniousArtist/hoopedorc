# Architecture

## One TypeScript monorepo (npm workspaces)

```
@orc/types     shared domain model + REST/WS contract        (the contract)
@orc/adapters  Claude Code + OpenCode runners                (deepseek-flash)
@orc/engine    scheduler, worktrees, git/PR, gates, validator (deepseek-pro)
@orc/server    Fastify REST + WS, SQLite persistence          (deepseek-flash)
@orc/web       React kanban UI, live logs, settings           (glm)
```

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
                                ┌─────────────────────────────┼───────────────┐
                                ▼                                              ▼
                        ┌───────────────┐                            ┌──────────────────┐
                        │ ClaudeAdapter │  claude -p (Pro sub)       │ OpenCodeAdapter  │
                        │  (planner)    │                            │  HTTP -> opencode │
                        └───────────────┘                            │  serve (GLM,     │
                                                                     │  Deepseek, Grok, │
                                                                     │  Nex)            │
                                                                     └──────────────────┘
```

## Why this split
- **One language (TS)** so the parallel agents share `@orc/types` and can't drift.
- **OpenCode as the single gateway** for all non-Claude models — one HTTP API
  instead of six provider SDKs; Grok's OAuth lives inside OpenCode.
- **Claude Code headless** for the planner so it uses the Pro subscription.
- **Git worktrees** give each task an isolated working dir on shared history, so
  models work in parallel without colliding; PRs + gates protect `main`.

## Process / deploy
- Local: `npm run dev` (all packages in watch) or `npm run mock` (UI + fake API).
- EC2: `npm run build` then run `@orc/server` under pm2/systemd; serve the built
  web app statically from the server (Round 3). OpenCode + Claude Code must be
  installed and authenticated on the box; keep the instance awake.

## Key decisions (locked)
- Merge policy: **hard gate + flag risky** (`Settings.mergePolicy`).
- Validator: **deepseek-pro** (`Settings.validatorByDifficulty`), never the author.
- DB: **SQLite** (single-operator, local-first).
