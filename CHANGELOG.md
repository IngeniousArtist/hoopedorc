# Changelog

All notable changes to Hoopedorc are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — 2026-07-05

The productization pass (`docs/PRODUCTIZATION_PLAN.md`) is complete as of
this tag: every security/bug item (Part 1) and every product feature (Part
2, F1–F12) is done. This is the first tagged version.

## Phase 6 — flexibility, packaging, docs (F9–F12)

- **F12 — Multi-project run queue.** `ModelConfig.maxConcurrent` was only
  ever enforced per-`Orchestrator`-instance, so two concurrently-running
  projects could each dispatch `maxConcurrent` copies of the same model at
  once — now a shared registry (`EngineRunner` wires one counter into every
  project's Orchestrator) makes it a true global cap. Fixed a correctness
  gap this surfaced: the dispatch loop could prematurely wind a run down
  when a task was blocked by *another* project's in-flight dispatch rather
  than its own. The Projects page also gained inline Start/Pause per row.
- **F11 — Docs for other users.** New `docs/USER_GUIDE.md`: what it is,
  install/prereqs, a first-project tutorial, the safety model, remote
  Tailscale setup, and a troubleshooting table from real failure modes.
- **F10 — Packaging & deployment.** The server now serves the built web app
  itself (`apps/web/dist`) once it exists — one process, one port, no CORS
  needed in production. `npm run start`/`npm run setup`, a `hoopedorc` CLI,
  and `deploy/` (a systemd unit as the primary path, plus a reference
  Dockerfile/compose with documented auth caveats — Claude Code's login
  lives in the macOS Keychain and isn't reachable from a Linux container;
  use `ANTHROPIC_API_KEY` there instead).
- **F9 — Project templates & per-project gate config.** Per-project
  overrides (`Project.config`): gate script name overrides (or skip a gate),
  a free-form test command for non-npm stacks, a `maxAttempts` default, and
  a `mergePolicy` override. Fixed a real pre-existing bug found while
  testing it: vacuous-gate detection (B11) never actually worked against a
  real repo, since `npm run --if-present` exits 0 whether or not the script
  exists.

## Phase 5 — away-from-keyboard autonomy (F5–F8)
- Browser + Telegram notifications with a configurable digest level and
  richer approval context (PR link, top validator reasons).
- Per-model health panel, failure-rate tracking, and a rate-limit cooldown
  that routes the autonomous loop around a throttled model instead of
  burning attempts on it.
- Soft budget warnings at 50%/80% (project + global monthly), a per-task
  cost estimate chip, and budget-bar color thresholds.
- Autonomous-run report cards (tasks done/failed, cost, PRs, approvals,
  top failure reasons) surfaced in a dedicated Audit view section and
  pushed to Telegram.

## Phase 4 — core product loop (F1–F4)
- First-run onboarding wizard (tool health checks, model roster mapping,
  routing defaults, optional budget/Telegram, first project).
- Task detail drawer (overview/attempts, logs, gate+validator review
  history, PR/diff/rollback).
- Mid-run control: stop a running task, add a task while the run is live,
  reprioritize via drag, and a "pause — finish current tasks" drain mode
  distinct from an immediate stop.
- A live "mission control" strip on the Board (active agents, budget burn,
  pending approvals).

## Phase 3 — hygiene & safety rails (S5, B6–B15)
- Vacuous-gate detection (a script-less repo no longer auto-merges
  silently) and a standing planner instruction so new projects scaffold
  real gate scripts.
- Sanitized environment for every spawned agent/gate process (secrets
  stripped by name pattern).
- Fixes for an argv-size (E2BIG) risk on long prompts, mid-run task
  additions being invisible to the running loop, zombie approvals
  surviving a restart, risky-file/glob-scope false positives and misses,
  and WebSocket broadcasts leaking across projects.

## Phase 2 — control-plane bugs (B1–B5)
- Stop actually stops the running agent (and can no longer be silently
  overtaken by an in-flight auto-merge).
- Task-scoped log history that survives a page reload.
- Manual dispatch and the autonomous loop can no longer double-run the
  same task.
- Live "running" run rows with correct durations, instead of only
  appearing once a run ends.
- `PATCH /api/tasks/:id` validates `status` against real transitions.

## Phase 1 — security (S1–S4)
- Converted shell-string `execSync` calls to argv-array `execFile` (closed
  a command-injection path via user-controlled `defaultBranch`/`localPath`).
- The API is no longer unauthenticated-and-CORS-open by default: loopback
  binding, a CORS allowlist, and optional bearer-token auth.
- The Telegram bot token (and other secrets) are redacted on every read.
- Guardrails against `rm -rf`-ing an arbitrary user-supplied `localPath`.

## Round 0–3 — initial build (dogfooded)
- Claude planned the initial scaffold and shared contract (`@orc/types`);
  specialist OpenCode models (GLM, Deepseek Pro/Flash) built the engine,
  server/adapters, and web modules in parallel worktrees; Claude integrated
  the pieces and added the real planner, Telegram bot, audit log, and cost
  analytics. See `docs/NEXT_STEPS.md` for the detailed history of this
  period.
