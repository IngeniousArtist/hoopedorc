# Changelog

All notable changes to Hoopedorc are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] — 2026-07-08

Part 6 of `docs/PRODUCTIZATION_PLAN.md` is complete as of this tag: three
Phase 10 audit fixes, a real `@orc/server` test package, and the owner's
quality-of-life wave — planning-context attachments, engineering-standards
prompts for authors and validators, per-task documentation, rate-limit
resilience with Telegram alerts, an honest model-identity test, a skills
strategy, and quota visibility.

## Phase 10 audit fixes (B25–B27)

- **B25** — fixed the wrong port in `USER_GUIDE.md`'s `tailscale serve`
  example.
- **B26** — old still-pending approvals no longer fall off the
  notifications fetch once 250+ newer, already-responded notifications
  exist.
- **B27** — `update.sh`'s systemd-unit detection no longer misfires against
  older `systemctl` versions that exit 0 with zero matches.

## T1 — a real `@orc/server` test package

- 35 new tests (`node --import tsx --test`, wired into CI) covering the
  scheduler's due-check math, quota window math, DB backup rotation against
  real files on disk, notification pruning/pending-approval exemption, and
  Telegram-URL token redaction — previously only verified by standalone
  scripts, not a real test suite.

## Planning context (F27, F28)

- **F27 — Plan-mode attachments.** Upload images/PDFs/files from the
  planning chat into the project's `context/attachments/` folder; the
  planner reads them with its own file tools.
- **F28 — Plan-chat session history.** Every planning chat/deconstruct
  session is archived as a markdown file under `context/plan-sessions/`.

## Engineering standards (F31, F29, F30)

- **F31 — Coding/UX/security guidelines.** Settings-editable house rules
  are injected into both the author's and the validator's prompts, so
  "meets the standards" is a checkable claim rather than vibes.
- **F29 — Documentation guidelines.** Fixed README/CHANGELOG conventions
  for docs-role tasks (and the standing per-project docs task).
- **F30 — Per-task documentation stage.** After the validator approves a
  task (and before the merge), a docs-role model updates CHANGELOG.md (and
  README.md/docs/** only if needed) in the same PR — scope-enforced,
  strictly best-effort, opt-out per project (`ProjectConfig.perTaskDocs`).

## Resilience (F32, F33)

- **F32 — Rate-limit wait-and-retry.** A rate-limited author run waits and
  retries the same model (bounded, abortable) before falling back to the
  next model; Telegram alerts fire on a wait, a fallback switch, or an
  exhausted retry chain.
- **F33 — Honest model-identity test.** "Test models" now asks each model
  to say hello and name itself, showing the real reply instead of a bare
  "OK" — with a note that self-identification is approximate.

## Skills + quota visibility (F34, F35)

- **F34 — Per-project skill hints.** A free-text nudge (`skill name — when
  to use it`) is appended to the author prompt as a `## Skills` section,
  pointing Claude Code toward project-specific or user-level skills that
  headless discovery alone wouldn't reliably reach for.
- **F35 — Quota usage in Setup & Health.** Each model with a subscription
  quota configured (F16) now shows its current window usage (runs and
  spend against the configured limits) instead of enforcing invisibly.

## [0.2.0] — 2026-07-06

Part 3 of `docs/PRODUCTIZATION_PLAN.md` is complete as of this tag: the
five review-pass fixes (Phase 7), the second feature wave (Phase 8,
including scheduled runs, which was pulled into scope mid-phase), and a
post-plan audit pass with three follow-up fixes.

## Post-plan audit (A1–A3)

- **A1 — Concurrent 401s no longer hang the app.** On a token-protected
  server, a fresh page load fires several API calls at once; each 401
  previously invoked the login gate separately, clobbering all but the last
  caller's resolver and leaving those requests hanging forever. All
  concurrent 401s now share one in-flight login and retry together.
- **A2 — Scheduled runs now show as running.** A scheduled auto-start set
  the run in motion but never flipped the project's status or notified open
  tabs — the UI showed the stale pre-run status for the whole run.
- **A3 — Daily schedules can no longer skip a day.** The due-check required
  the exact HH:MM minute, which the 60-second poll can drift past; daily
  runs now fire within a 5-minute grace window (still once per day, never
  retroactively after a server was down at the scheduled time).

## Phase 8 — second feature wave (F14–F19)

- **F14 — CI.** GitHub Actions on every PR and push to `main` (typecheck,
  build, engine + adapter tests). The very first run caught a real bug:
  `npm run typecheck` only worked on machines where a previous build had
  already produced `dist/` type declarations — the root script now builds
  the type-bearing packages first, so a fresh checkout typechecks.
- **F15 — "Wait for GitHub checks" merge gate.** Opt-in per project: the
  auto-merge additionally waits for the PR's own GitHub checks (the target
  repo's CI). Checks failing or timing out escalates to a human instead of
  merging; repos with no checks configured are unaffected.
- **F16 — Subscription quota awareness.** Declare a per-model usage window
  (hours + max runs and/or max spend); the scheduler routes around an
  exhausted window *before* burning attempts, complementing the existing
  after-the-failure rate-limit cooldown. Enforced across all projects.
- **F17 — DB backup rotation.** Automatic online backups of the SQLite DB
  on boot and daily, pruned to the newest N (default 7), via
  `DB_BACKUP_DIR`/`DB_BACKUP_KEEP`.
- **F18 — Sandbox design doc.** `docs/specs/sandbox.md` designs the future
  containerized mode for agents + gates (no implementation).
- **F19 — Scheduled runs.** Cron-style per-project auto-start: every N
  hours or daily at HH:MM, triggering the same Start (and the same safety
  rails) as the button.

## Phase 7 — review-pass fixes (B16–B19, S6)

- **B16** — the reference Dockerfile's build stage was missing COPYs for
  `tsconfig.base.json`, `bin/`, and `scripts/`, making it deterministically
  unbuildable.
- **B17** — an explicitly configured gate-script override naming a missing
  npm script now fails the gate loudly instead of silently passing.
- **B18** — a project waiting on another project's model-concurrency slot
  now logs a warn-once "model at capacity" line instead of polling
  silently (previously indistinguishable from a hang).
- **B19** — manually dispatched tasks now count toward the shared
  per-model concurrency cap (still never blocked by it — a human's explicit
  dispatch must not silently queue).
- **S6** — auth polish: a real in-app login screen replaces the blocking
  browser prompt, the server compares tokens in constant time, and the
  unauthenticated-by-design SPA shell is documented.

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
