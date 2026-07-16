# Changelog

All notable changes to Hoopedorc are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### B39 — planning and Git durability

- Plan commit now saves the exact edited draft first, then awaits one atomic
  PRD/AGENTS/CLAUDE commit and push plus the readable session archive before
  creating task rows, clearing scratch, or marking the project planned.
- A delayed or failed plan commit leaves the project in retryable `planning`
  state and blocks every Start path. Failed pushes can retry an already-local
  no-diff commit without duplicating tasks or repository commits.
- Git commit/fetch/merge/push failures now retain typed stages. Only a verified
  clean tree is a commit no-op; optional changelog/worktree/branch cleanup stays
  non-blocking but emits an operator-visible warning when it fails.
- Planning archives and uploaded attachments under Hoopedorc's local
  `context/` paths no longer trip the unrelated-change guard that protects the
  primary clone; real owner changes elsewhere still block persistence.

### Model slug catalog

- Added a dedicated, searchable Model Slugs page with one-click copy,
  per-runner loading/error/empty states, responsive coverage, and deep links.
- Codex slugs come from the installed CLI's bundled catalog, Claude Code shows
  its short aliases and current documented full IDs, and OpenCode is limited
  to the requested `zai/`, `xai/`, and `deepseek/` providers.
- Settings and onboarding now autocomplete runner model fields from the same
  catalog, replacing the stale Codex example that no longer appeared in the
  installed CLI.
- The planning chat composer now starts at five lines and can be resized
  vertically for long prompts without creating horizontal page overflow.

### B38 — portable dependency setup and atomic caching

- Node projects now select npm, pnpm, Yarn, or Bun from `packageManager`
  first and otherwise require one unambiguous lockfile; installs use each
  manager's frozen mode and report missing tooling before author dispatch.
- Dependency keys include every monorepo `package.json`, the selected lock,
  manager/version, Node version, OS, and architecture. Per-key process/file
  locks serialize identical installs, and successful artifacts are published
  atomically outside the primary clone before being materialized per worktree.
- Projects can configure a direct setup command plus literal argument array
  for non-Node and specialist SDK workflows. It inherits sandbox policy,
  timeout, and cancellation; Setup & Health reports the resolved tooling, and
  Apple/Xcode projects fail actionably on non-macOS hosts.

### B37 — enabled models, live operational settings, and complete validation

- Disabled models can no longer receive a new routed, fallback, validator,
  planner, documenter, or health invocation; active calls still finish.
- Active project runtimes now read routing, budgets, quotas, approval holds,
  merge policy, notification gates, and manual pricing live from Settings.
- Defaults, boot migration, repository/API/Telegram writes, and runtime reads
  now share one field-specific settings normalizer and validator.

### F48 — per-model reasoning effort

- Model Settings now configure Claude Code `--effort`, OpenCode `--variant`,
  and Codex `model_reasoning_effort` consistently across every model stage.
- Run records, logs, task history, model-test results, and model health expose
  the resolved effort; runner changes clear incompatible values.

## [0.6.0] — 2026-07-14

Part 9 of `docs/PRODUCTIZATION_PLAN.md` is complete as of this tag: an
autonomy-hardening wave from the owner's first real dogfooding runs on
the EC2 box, fixing a deconstruction-breaking JSON parser bug, the root
cause of "full autonomous doesn't work" (a stalled run on a
cooldown/quota block), a non-bypassable destructive-change safety rail,
and a real cwd bug in the opencode integration.

## B31 — deconstruction JSON parser breaks on inner code fences

- Fixed the exact bug behind `deconstruction failed: Unexpected token
  '\', "\nprisma/"...`: the fence-extraction regex matched a code fence
  living INSIDE a JSON string value (e.g. a plan mentioning
  `prisma/schema.prisma` in a fenced snippet) instead of treating the
  response as bare JSON. Added a control-character repair pass and one
  automatic re-ask retry before giving up.

## F46 — planner output-shape hardening

- The task list is now validated against nested subtasks (flattened one
  level), empty entries (dropped), oversized lists (capped at 30), and
  duplicate titles (deduped) — defensive parsing for planner paths with
  no native output-schema enforcement.

## F47 — scope-aware planning

- Planner-authored scope paths now cover shared wiring files
  (package.json, entry points, tool config) that real tasks legitimately
  touch, cutting down on false "modified files outside declared scope"
  flags.

## B32 — autonomous runs no longer silently end on a cooldown/quota block

- The dispatch loop now walks a task's fallback chain when its assigned
  model is cooldown/quota-blocked instead of just holding it, and keeps
  polling (rather than winding the run down) when every fallback is
  also time-bounded blocked — both are self-clearing, so the run now
  survives a subscription's usage window instead of quietly stopping.

## S8 — non-bypassable destructive-change rail

- Mass deletions, deleted migration/schema/`.env`/CI/lockfile files,
  destructive SQL, and a risky `rm -rf` now force human approval before
  merging in EVERY merge policy, including `fully_autonomous` — this
  rail can't be bypassed by merge policy. Fixed safety instructions
  also added to every author and validator prompt.

## B33 — no-changes diagnosis + a real opencode bug fix

- "Author produced no changes" failures now diagnose whether the agent
  wrote into the primary clone instead of its own worktree. Found and
  fixed a real bug along the way: the opencode adapter's `--attach`
  path relied on `PWD` alone, which has no effect on an attached
  server's own process — any deployment with a shared opencode server
  configured was silently writing every task's changes into the
  server's own directory.

## F44 — automode notification parity

- Model-trouble events (rate-limit waits, fallback switches, exhausted
  chains, cooldown/quota stalls) and non-completed run endings now show
  up in the web notification bell, not just Telegram.

## F45 — opencode-runner models as planner/deconstructor

- Any enabled model can now plan and deconstruct, not just Claude Code
  and Codex — the earlier hard rejection predated per-tier model
  routing.

## [0.5.0] — 2026-07-10

Part 8 of `docs/PRODUCTIZATION_PLAN.md` is complete as of this tag: a
restart-safe approval mechanism, a Telegram command wave, an optional
hold-dispatch mode, the missing gate-sandbox UI toggle, and a one-command
EC2 bootstrap script.

## B30 — restart during a pending approval no longer re-runs the task

- A server restart while a task was waiting on an approval used to be
  treated as an orphaned run and re-authored/re-validated from scratch.
  It now re-arms the pending decision instead — no re-authoring, no
  re-validating, just a fresh notification for whichever decision was
  still open.

## F40 — Telegram command wave

- `/autonomous [on|off]` — view or flip the merge policy from your phone.
- `/pending` — re-sends every still-open approval with its buttons.
- `/stopall` — two-step (Yes/No confirm) global stop.
- `/retry <taskId-or-prefix>` — retry a failed/blocked task by a short
  unique id prefix.
- `/digest [off|terminal|all]` and `/health` (per-model cooldown/quota/
  last-check summary).

## F41 — optional hold-dispatch while an approval is pending

- New `Settings.holdWhileAwaitingApproval` (default off): when on, a
  project's dispatch loop skips picking up new tasks while any of its
  approvals is still pending — active tasks finish normally, nothing new
  starts until you respond.

## F43 — gate-sandbox toggle in Settings

- The `sandboxGates` mode (`off`/`auto`/`required`) is now a select in
  Settings instead of settings-API/DB-only.

## F42 — `deploy/ec2-bootstrap.sh`

- One-command setup for a fresh Amazon Linux 2023 or Ubuntu LTS box:
  packages, swap on small instances, clone, install/build, and the
  systemd unit — stopping short of the genuinely interactive steps (CLI
  logins, `.env`, `tailscale serve`) and printing exactly what to do next.

## [0.4.0] — 2026-07-09

Part 7 of `docs/PRODUCTIZATION_PLAN.md` is complete as of this tag: a
referential-integrity fix, four small UX items, a native Codex runner, a
swappable planner, AGENTS.md generation, the gates-only Docker sandbox, an
EC2 deploy checklist, and a stale-dependency-fingerprint fix.

## B28 — dangling model references

- Removing or renaming a model in Settings now clears/remaps every
  `Routing`/task reference to it instead of leaving dangling references
  that silently misroute future dispatches.

## UX polish (U15–U18)

- **U15** — Approve/reject buttons on Notifications are now visually
  distinct (not just color) instead of near-identical.
- **U16** — Removed duplicated estimate copy and fake-precision cost
  formatting (no more implying penny-level accuracy on estimates).
- **U17** — Fixed the Projects-row orphan "·" separator and made the
  pause/stop icon pairing consistent.
- **U18** — An unknown URL hash now falls back visibly instead of the URL
  and the UI silently disagreeing about which view is showing.

## F36, F37 — Codex CLI support

- **F36 — Codex as a first-class runner.** Author/validator tasks can run
  through OpenAI's Codex CLI (`codex exec`), billed via a ChatGPT
  subscription rather than per-token.
- **F37 — Swappable planner runner.** The planning pipeline (deconstruct +
  chat) can run through Claude Code or Codex, configurable per project.

## F38 — AGENTS.md generation

- The planning pipeline now generates an `AGENTS.md` for the target repo
  (when missing), giving every author/validator run a consistent, durable
  set of project instructions instead of relying on prompt-only context.

## F13-P1 — gates-only Docker sandbox

- Gate scripts (`typecheck`/`lint`/`build`/`test`) and dependency installs
  now run inside a disposable `docker run --rm` container by default when a
  Docker daemon is reachable (`Settings.sandboxGates`), isolated from the
  host, other tasks' worktrees, and CLI credentials — falling back to host
  execution transparently when no daemon is available.

## F39 — EC2 deploy checklist

- New root `start:prebuilt` script (serve only, no rebuild) so the systemd
  unit doesn't re-run a full build on every restart. `USER_GUIDE.md` gained
  a single ordered "Deploying to EC2 — checklist" section plus a "Two
  boxes" section documenting the Mac/EC2 split (Apple/Xcode projects stay
  on the Mac; one project lives on exactly one box).

## B29 — stale dependency fingerprint

- Fixed `ensureDeps` fingerprinting and installing against the primary
  clone's own (frequently stale) `package.json`/lockfile instead of the
  freshly-checked-out worktree's — previously, once any task changed
  dependencies, every later task could silently symlink into a stale
  `node_modules`, permanently failing gates for missing dependencies.

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
