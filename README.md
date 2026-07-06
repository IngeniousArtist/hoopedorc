# Hoopedorc

[![CI](https://github.com/IngeniousArtist/hoopedorc/actions/workflows/ci.yml/badge.svg)](https://github.com/IngeniousArtist/hoopedorc/actions/workflows/ci.yml)

**A self-hosted, multi-model AI coding orchestrator.** Describe what you want
built in a planning chat; Hoopedorc turns it into a task DAG, runs a team of
coding agents on it in parallel — each in its own isolated git worktree — and
auto-merges their PRs to `main` behind hard gates and an independent AI
reviewer. You watch a live kanban, get pinged on your phone when something
actually needs you, and step in mid-run without breaking anything.

It exists for developers who hold **several model subscriptions at once**
(Claude Pro, GLM, DeepSeek, Grok, …) and want to combine them into one
hands-off engineering team instead of juggling terminals — while staying
inside each plan's usage limits.

## How it works

1. **Plan** — chat with Claude about what to build; it deconstructs the agreed
   plan into a dependency-aware task DAG with acceptance criteria, scope
   paths, and a difficulty-based model assignment per task.
2. **Dispatch** — the scheduler runs ready tasks in parallel, each agent in
   its own git worktree on its own branch. Tasks with overlapping scopes are
   serialized; per-model concurrency caps hold across every project.
3. **Gate** — every change must pass the repo's own typecheck/lint/build/test
   scripts, plus no-merge-conflict and stayed-in-scope checks. Optionally it
   also waits for the PR's own GitHub CI.
4. **Review** — a *different* model than the author grades the diff against
   the task's acceptance criteria with a confidence score.
5. **Merge** — clean + confident + not risky → auto-merged and logged. DB
   schema changes, new dependencies, auth/secret files, out-of-scope edits,
   low confidence, or exhausted gates → an approval lands on your phone via
   Telegram (Approve/Reject buttons) and in the app.

If an attempt fails, the task escalates through a fallback model chain before
giving up. If a model gets rate-limited, it cools down and work routes around
it. If you declared a subscription's usage window, the scheduler avoids
exhausting it in the first place.

## Features

**Planning & execution**
- Two-tier planning: conversational chat (Sonnet) + one high-leverage DAG
  deconstruction (Opus); editable task table before anything runs
- Parallel agents in isolated git worktrees; scope-overlap serialization;
  global per-model concurrency caps; automatic fallback-model escalation
- Mid-run control: stop a single task, add tasks to a live run, reprioritize
  by drag, pause-and-drain or hard-stop

**Safety rails**
- Hard gates (repo's own scripts, per-project overridable) + independent
  AI validator + risky-change rules + configurable merge policy
- Vacuous-gate detection (a scriptless repo can't "pass" by doing nothing)
- One-click rollback of any merged task; full audit log
- Stuck-run detection (max runtime, output idle, spin-loop) with automatic
  abort and fallback

**Cost & subscription awareness**
- Per-project and global monthly budget caps with 50%/80% soft warnings
- Per-model subscription quotas (rolling window + max runs/spend) enforced
  across all projects; rate-limit cooldowns; pre-run cost estimates

**Away-from-keyboard autonomy**
- Telegram: approvals with context, status digests, `/status` `/cost`
  `/start` `/pause` commands; browser notifications when the tab is hidden
- Scheduled runs (nightly / every-N-hours per project); end-of-run report
  cards; live mission-control strip on the board
- Remote access over Tailscale with token auth and an in-app login screen

**Operations**
- One process serves API + built web app; systemd unit provided; automatic
  daily DB backup rotation; log pruning; first-run onboarding wizard with
  CLI health checks and a real model roster

## Quickstart

Prereqs: Node ≥ 20 (22 recommended), plus the three CLIs the orchestrator
drives — `gh` (authenticated), `claude` (Claude Code, logged in), and
`opencode` (authenticated for your non-Claude models).

```bash
npm install          # install all workspaces
npm run setup        # create .env from .env.example, check gh/claude/opencode auth
npm run start        # build everything + run the server (serves the web app too)
```

Then open http://127.0.0.1:4317 — a first-run wizard walks you through model
mapping, routing, budgets, and your first project.

For development:

```bash
npm run mock         # frontend dev against mock data on :5173 (no real models)
npm run dev          # all packages in watch mode
```

See [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) for the full walkthrough
(first project, the safety model, scheduled runs, remote setup,
troubleshooting) and [`deploy/`](deploy/) for systemd/Docker notes.

## Layout

```
packages/
  types/      @orc/types      — shared domain model + REST/WS contract (the contract)
  engine/     @orc/engine     — scheduler, worktrees, git/PR, gates, validator
  adapters/   @orc/adapters   — Claude Code + OpenCode runners
  server/     @orc/server     — Fastify REST+WS API, SQLite persistence
apps/
  web/        @orc/web        — React kanban UI + live logs + settings
docs/         USER_GUIDE, ARCHITECTURE, CONTRACT, PRODUCTIZATION_PLAN, specs/
deploy/       systemd unit + reference Dockerfile/compose
bin/          `hoopedorc` CLI (start|init)
scripts/      npm run setup's implementation
```

This repo is **built by the orchestration pattern it implements**: Claude
wrote the scaffold and contracts, specialist models built the modules in
parallel worktrees, and the ongoing fix/feature waves are executed by one
model and independently audited by another — the full history is in
[`docs/PRODUCTIZATION_PLAN.md`](docs/PRODUCTIZATION_PLAN.md) and
[`CHANGELOG.md`](CHANGELOG.md).

## Security

The server binds to `127.0.0.1` and is unauthenticated by default (frictionless
solo localhost use). For remote access over Tailscale, `tailscale serve` (real
HTTPS, no non-loopback bind needed) is the recommended path; `HOST=0.0.0.0` +
`API_TOKEN` is the documented fallback — either way, set `API_TOKEN` so every
request requires `Authorization: Bearer <token>` — the server refuses to start
on a non-loopback `HOST` otherwise. See `docs/USER_GUIDE.md`'s Remote setup
section for the full walkthrough, and `.env.example` for `HOST`,
`CORS_ORIGINS`, `API_TOKEN`, `ALLOW_UNAUTHENTICATED`.

Secrets (the Telegram bot token, the API token itself) are stored in the local
SQLite DB and redacted (`"__SET__"` sentinel) on every read from the settings API
— they never round-trip back to the browser. Gate scripts and spawned agents
still run **directly on this host** with your CLI auth (`gh`, `claude`,
`opencode`) — don't run untrusted repos through it. Their environment is
stripped of anything secret-shaped (`sanitizedEnv()` in `@orc/adapters`, keyed
off `/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|TELEGRAM/i`) before spawn, so a
prompt-injected agent or a hostile `npm test` script in the repo being worked
on can't read your Telegram token or provider API keys — but they still run
with real filesystem/network access on your machine, since a repo's own
`test`/`build` scripts are executed as-is (there's no sandbox yet; see F13 in
the productization plan and its design doc, [`docs/specs/sandbox.md`](docs/specs/sandbox.md)).

## Status

`v0.2.0`. The original productization plan (Parts 1–3: 6 security items, 19
bugs, 19 features) is fully implemented, CI-covered, and independently
audited — see [`docs/PRODUCTIZATION_PLAN.md`](docs/PRODUCTIZATION_PLAN.md)
(progress tables near the top) for what's done and what's next, and
[`CHANGELOG.md`](CHANGELOG.md) for the summarized history.

## The rules every module follows

1. **The contract is `@orc/types`.** Don't change it without coordinating — it's shared.
2. **Each module depends only on `@orc/types`, never on a sibling module's internals.**
3. **`main` is sacred.** All work happens on branches + worktrees → PR → auto-merge only when green.
