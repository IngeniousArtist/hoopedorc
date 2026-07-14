# Hoopedorc

[![CI](https://github.com/IngeniousArtist/hoopedorc/actions/workflows/ci.yml/badge.svg)](https://github.com/IngeniousArtist/hoopedorc/actions/workflows/ci.yml)

**A self-hosted, multi-model AI coding orchestrator.** Describe what you want
built in a planning chat; Hoopedorc turns it into a task DAG, runs a team of
coding agents on it in parallel — each in its own isolated git worktree — and
auto-merges their PRs to `main` behind hard gates and an independent AI
reviewer. You watch a live kanban, get pinged on your phone when something
actually needs you, and step in mid-run without breaking anything.

It exists for developers who hold **several model subscriptions at once**
(Claude Pro, ChatGPT Plus/Pro, GLM, DeepSeek, Grok, …) and want to combine
them into one hands-off engineering team instead of juggling terminals —
while staying inside each plan's usage limits.

## How it works

1. **Plan** — chat with the planner (Claude Code or Codex, your choice) about
   what to build; it deconstructs the agreed plan into a dependency-aware
   task DAG with acceptance criteria, scope paths, and a difficulty-based
   model assignment per task — plus a PRD and an `AGENTS.md` project-context
   file, both editable before anything runs.
2. **Dispatch** — the scheduler runs ready tasks in parallel, each agent in
   its own git worktree on its own branch. Tasks with overlapping scopes are
   serialized; per-model concurrency caps hold across every project.
3. **Gate** — every change must pass the repo's own typecheck/lint/build/test
   scripts, plus no-merge-conflict and stayed-in-scope checks — run inside a
   disposable Docker container by default when a daemon is available, so a
   repo's own scripts can't touch your host. Optionally it also waits for
   the PR's own GitHub CI.
4. **Review** — a *different* model than the author grades the diff against
   the task's acceptance criteria (and your configured engineering
   guidelines) with a confidence score; a docs-role model then keeps
   CHANGELOG/README/AGENTS.md current in the same PR.
5. **Merge** — clean + confident + not risky → auto-merged and logged. DB
   schema changes, new dependencies, auth/secret files, out-of-scope edits,
   low confidence, or exhausted gates → an approval lands on your phone via
   Telegram (Approve/Reject buttons) and in the app — the flagged task waits
   for your answer while independent tasks keep running.

If an attempt fails, the task escalates through a fallback model chain before
giving up. If a model gets rate-limited, it cools down and work routes around
it. If you declared a subscription's usage window, the scheduler avoids
exhausting it in the first place.

## Features

**Planning & execution**
- Two-tier planning: conversational chat + one high-leverage DAG
  deconstruction; editable task table, PRD, and `AGENTS.md` before anything
  runs; upload images/PDFs/files as planning context; every planning session
  archived as markdown in the repo
- Three interchangeable runners: **Claude Code** (Claude subscription),
  **Codex CLI** (ChatGPT subscription), and **OpenCode** (everything else —
  GLM, DeepSeek, Grok, OpenRouter, …); the planner itself is swappable
  between the two subscription CLIs
- Parallel agents in isolated git worktrees; scope-overlap serialization;
  global per-model concurrency caps; automatic fallback-model escalation
- Mid-run control: stop a single task (or everything at once), add tasks to
  a live run, reprioritize by drag, pause-and-drain or hard-stop

**Safety rails**
- Hard gates (repo's own scripts, per-project overridable) + independent
  AI validator + risky-change rules + configurable merge policy
- Gate scripts and dependency installs run in a disposable Docker sandbox
  by default when a daemon is reachable (`off`/`auto`/`required` modes,
  per-project image override)
- Your own coding/UX/security guidelines injected into both author and
  validator prompts; a per-task docs stage keeps CHANGELOG/README/AGENTS.md
  current in the same PR
- Vacuous-gate detection (a scriptless repo can't "pass" by doing nothing)
- One-click rollback of any merged task; full audit log
- Stuck-run detection (max runtime, output idle, spin-loop) with automatic
  abort and fallback

**Cost & subscription awareness**
- Per-project and global monthly budget caps with 50%/80% soft warnings
- Per-model subscription quotas (rolling window + max runs/spend) enforced
  across all projects, with live window usage in the health panel;
  rate-limit cooldowns; pre-run cost estimates
- Rate-limited models wait-and-retry before falling back, with Telegram
  alerts on waits, fallback switches, and exhausted chains

**Away-from-keyboard autonomy**
- Telegram: approvals with PR link + validator reasons, status digests,
  `/status` `/cost` `/start` `/pause` commands; browser notifications when
  the tab is hidden
- A pending approval blocks only the flagged task — it waits indefinitely
  for your decision while independent tasks keep flowing
- Scheduled runs (nightly / every-N-hours per project); end-of-run report
  cards; live mission-control strip on the board
- Remote access over Tailscale with token auth, an in-app login screen,
  hash-routed deep links, and a PWA manifest (install it on your phone)

**Operations**
- One process serves API + built web app; systemd unit provided (prebuilt
  start — no rebuild on restart); `npm run update` pulls/rebuilds/restarts
  in place; automatic daily DB backup rotation; log pruning; first-run
  onboarding wizard with CLI health checks and a real model roster; an
  ordered EC2 deploy checklist in the user guide

## Quickstart

Prereqs: Node ≥ 20 (22 recommended), plus the CLIs the orchestrator
drives — `gh` (authenticated), `claude` (Claude Code, logged in), and
`opencode` (authenticated for your non-Claude models). Optionally `codex`
(Codex CLI, `codex login`) if you want a ChatGPT-subscription-billed model
in the pool. Docker is optional — with it, gates run sandboxed.

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
(first project, the safety model, the gate sandbox, scheduled runs, remote
setup over Tailscale, an ordered EC2 deploy checklist, troubleshooting) and
[`deploy/`](deploy/) for the systemd unit and Docker notes.

## Layout

```
packages/
  types/      @orc/types      — shared domain model + REST/WS contract (the contract)
  engine/     @orc/engine     — scheduler, worktrees, git/PR, gates, validator, sandbox
  adapters/   @orc/adapters   — Claude Code + OpenCode + Codex runners
  server/     @orc/server     — Fastify REST+WS API, SQLite persistence, planner, Telegram
apps/
  web/        @orc/web        — React kanban UI + live logs + settings
docs/         USER_GUIDE, ARCHITECTURE, CONTRACT, PRODUCTIZATION_PLAN, specs/
deploy/       systemd unit + reference Dockerfile/compose
bin/          `hoopedorc` CLI (start|init)
scripts/      npm run setup + npm run update implementations
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
— they never round-trip back to the browser.

**Gate scripts, dependency installs, and project setup** — the riskiest
repo-owned code, including `postinstall` hooks — run inside a disposable Docker container by
default whenever a daemon is reachable (`Settings.sandboxGates`: `auto` by
default, `required` to refuse host fallback; see the user guide's
[Gate sandbox](docs/USER_GUIDE.md#gate-sandbox) section). The container sees
one task's worktree—not your home directory, the orchestrator's DB, sibling
worktrees, or your CLI credentials. Node dependencies are selected from the
repo's declared package manager/lockfile, published atomically to an immutable
fingerprinted cache outside the clone, and materialized separately per task.

**Spawned agents** still run directly on the host with the same user's stored
CLI auth (`claude`, `opencode`, `codex`) — don't run untrusted repos through it.
Their process environment is built from a small runtime/config allowlist
(`sanitizedEnv()` in `@orc/adapters`), not inherited from the server. Provider
keys, GitHub/Telegram/API tokens, SSH agent sockets, npm auth tokens/passwords,
and arbitrary app variables are not forwarded; safe registry/proxy settings and
the user's HOME/XDG/CLI config paths remain so existing CLI logins work.

This is credential hygiene, not process isolation. Host-run agents retain the
same user's real filesystem and network access, so they can still read CLI
credential files or invoke host tools that can. Moving agents into the sandbox
is phases 2–3 of [`docs/specs/sandbox.md`](docs/specs/sandbox.md), deliberately
future work.

## Status

`v0.4.0`. The full productization plan (Parts 1–7: 7 security items, 29
bugs, 39+ features across security, the core product loop, away-from-keyboard
autonomy, packaging, remote QoL, planning context, engineering standards,
Codex support, and the gates sandbox) is implemented, CI-covered, and
independently audited wave by wave — see
[`docs/PRODUCTIZATION_PLAN.md`](docs/PRODUCTIZATION_PLAN.md) (progress
tables near the top) for the full history and
[`CHANGELOG.md`](CHANGELOG.md) for the summarized version. Current target
deployment: an EC2 box inside a Tailscale tailnet, supervised from a phone.

## The rules every module follows

1. **The contract is `@orc/types`.** Don't change it without coordinating — it's shared.
2. **Each module depends only on `@orc/types`, never on a sibling module's internals.**
3. **`main` is sacred.** All work happens on branches + worktrees → PR → auto-merge only when green.
