# Optimization Plan — post-productization hardening

**Audience: the implementing model.** Produced 2026-07-28 by five parallel
full-code audits (engine, server core/persistence, server services/planner,
web app, cross-cutting adapters/contract/CI/deps) of the complete codebase at
commit `067e96e` (v0.6.0, Phase 18 closed). Every finding below was verified
against the actual source with file:line evidence; line numbers are accurate
as of `067e96e` and may drift — **re-verify each finding against current code
before implementing it.**

## Goal and non-goals

**Goal:** the same product, running smoother, more efficiently, and more
robustly. Every feature keeps its current behavior. The optimization removes
latent bugs, resource leaks, race conditions, missing bounds, and
verification gaps so the software does not break down or corrupt state during
long autonomous runs.

**Non-goals (explicitly out of scope):**

- No new features, no feature removals, no UI redesign.
- No rewrite. Every fix is the smallest behavior-preserving change at the
  owning layer.
- No deleting files, data, or capabilities unless an item explicitly requires
  it (none below do).
- No weakening of any fail-closed rail: gates, validators, destructive-change
  inspection, update refusals, and budget accounting must stay at least as
  strict as today.
- Preserve all operator data: projects, tasks, planning drafts, settings,
  cost history, and dirty worktrees survive every change and migration.

## Required workflow (applies to every item)

This is the AGENTS.md workflow, restated so no item skips it:

1. Start from a clean, current `main` (fetch `origin/main`; local `main` not
   ahead/behind/dirty). **Never implement on `main`.**
2. One descriptive branch per item (or per tightly coupled group where the
   plan says so). Reference the item ID (e.g. `O2`) in commit messages.
3. Re-verify the finding in current code before designing the fix. Trace the
   real contract → server → persistence → engine → UI → tests path affected.
4. For a bug, reproduce it in a failing test before or alongside the fix.
   Confirm the new test fails on pre-fix code and passes after (the
   before/after check used throughout Phase 18).
5. Contract changes (none are expected in this plan) follow the API checklist:
   `packages/types/src/api.ts` + `ROUTES` + server + web client + mock +
   `docs/CONTRACT.md` together.
6. SQLite changes ship as idempotent migrations in
   `packages/server/src/db/index.ts` **and** `schema.sql`, preserving old rows.
7. Before handoff, run **all** repository gates:

   ```bash
   npm run typecheck
   npm run build
   npm run lint
   npm test -w @orc/engine
   npm test -w @orc/adapters
   npm test -w @orc/server
   npm run test:web
   npm run test:e2e
   git diff --check
   ```

   If a gate cannot run, state which, why, and what evidence is outstanding.
8. UI items: verify in a real browser at 360, 390, 768, 1280, and 1440 px.
9. Push, open a PR, wait for green CI, review, merge. Never bypass a failed
   required check.
10. After merge: update this document's item with status + exact verification
    evidence (PR number, commit, test counts), mirroring the
    `PRODUCTIZATION_PLAN.md` convention. Deployed-behavior items additionally
    get a live smoke through `scripts/update.sh` on the EC2 box.

**Verification honesty:** a typecheck is not browser verification; a mock is
not a live systemd/EC2 smoke; a passing suite that never exercises the failure
path is not regression coverage.

---

## Phase 1 — Correctness and security (do these first)

### O1. Dependency security remediation — HIGH (security)

**Problem:** `npm audit` reports 8 vulnerabilities (1 low, 7 high). Two are
runtime-facing on the server: `@fastify/static` 9.1.3
(`packages/server/package.json:17`) has two HIGH advisories (authorization
bypass via non-canonical URL paths; route-guard bypass via path traversal) —
and it is reachable **pre-auth** by design: the token hook at
`packages/server/src/index.ts:862` only gates `/api/*` and `/ws`, so every
static path is served unauthenticated to anyone who can reach the port
(localhost or any tailnet peer via Tailscale Serve). `find-my-way` 9.6.0
(HTTP/2 DDoS) and `fast-uri` 3.1.2 (host confusion) are Fastify internals
fixed by a non-major fastify patch bump. The rest (`shell-quote` via
`concurrently`, `postcss`, `esbuild`, `brace-expansion`) are dev/build-only.

**Fix:** bump `@fastify/static` to ≥10.1.2 (deliberate semver-major; usage is
only the `register({ root: webDist })` at `index.ts:662` plus one
`sendFile("index.html")` SPA fallback — re-verify both against the v10 API and
the fastify 5.8.5 peer range). Then `npm audit fix` for the remaining set
(dry-run confirms non-major).

**Likely files:** `packages/server/package.json`, `package-lock.json`,
possibly the static-registration block in `packages/server/src/index.ts`.

**Acceptance:** `npm audit` reports zero high vulnerabilities; the built web
app serves correctly through the real server (index, assets, SPA fallback
route, 404 behavior); auth gate behavior on `/api` and `/ws` unchanged; full
gates green. Live smoke after deploy: `GET /api/health` ok and the dashboard
loads through Tailscale Serve.

**Fix risk:** low-medium (plugin major bump with a tiny usage surface).

### O2. Scheduler tick unhandled rejection can shut down the whole server — HIGH (robustness)

**Problem:** `checkSchedules` runs
`void startProject(...).then(...)` with **no `.catch`**
(`packages/server/src/index.ts:771-790`); the `.then` callback itself calls
`repo.updateProject` and `broadcast`. `installShutdownHandlers` treats any
`unhandledRejection` as fatal and shuts the entire server down with exit 1
(`packages/server/src/shutdown.ts:131-137`). A transient SQLITE_BUSY during a
routine 60-second tick can therefore kill every running project.

**Fix:** add `.catch((err) => app.log.error(...))` to the `checkSchedules`
chain, matching the `.catch` pattern already used for `backupDb` and
resume-on-boot in the same file. While there, sweep `index.ts` for any other
`void <promise>` without `.catch` and give them the same treatment.

**Likely files:** `packages/server/src/index.ts`.

**Acceptance:** a test (or targeted fault injection in a unit test around the
scheduler callback) proves a throwing `updateProject`/`broadcast` during a
scheduled start is logged and does not become an unhandled rejection; grep
confirms no bare `void promise.then(...)` chains without rejection handling
remain in server startup/timer paths; full gates green.

**Fix risk:** negligible.

### O3. Re-committing an already-successful plan duplicates tasks — HIGH (correctness)

**Problem:** violates the AGENTS.md invariant "retries must not create
duplicate tasks or commits" on the *succeeded-then-resubmitted* path.
`commitPlanningDraft` (`packages/server/src/planning-commit.ts:120-233`) has
no terminal-state guard; `planningLockError`
(`packages/server/src/index.ts:1568-1572`) only refuses when the project is
`running` or a commit is currently in flight. If a commit succeeds but the
HTTP response is lost (network blip, double-click, stale second tab), the
client re-POST passes the lock, `materializeTasks` mints fresh UUIDs, and the
board gets a duplicate task set. The failed-then-retried path is already
idempotent and tested; this success-resubmit path has no test.

**Fix:** add an idempotency guard at the owning layer keyed on the planning
draft/session rather than a blanket status check (a plain
`status !== "planning"` refusal would over-block legitimate follow-up
iteration commits on a `planned`/`completed` project). Prefer: dedupe on a
commit token or the draft/session identity so a resubmit of the same draft
no-op-returns the already-created tasks.

**Likely files:** `packages/server/src/planning-commit.ts`,
`packages/server/src/index.ts`, `packages/server/src/planning-commit.test.ts`,
`docs/CONTRACT.md` only if a request field is added (then the full API
checklist applies).

**Acceptance:** regression test: successful commit → identical resubmit →
no new tasks, no new commit, response identifies the existing result; a
legitimate second iteration (new draft) still creates its tasks; the existing
failed-retry idempotency test still passes; full gates green.

**Fix risk:** medium — must not block legitimate v2-iteration commits.

### O4. Unserialized git mutations on the shared primary clone — HIGH (robustness)

**Problem:** `worktree-manager.create` (`packages/engine/src/worktree-manager.ts:430-505`)
and `.remove` (`:1051-1067`) run `git fetch` / `git worktree add|remove|prune` /
`git branch -D` against `project.localPath` with no lock, while the dispatch
loop launches pipelines concurrently (`orchestrator.ts:992` does not await
`executeTask`) and `git-service`'s private `withRepoLock`
(`git-service.ts:48-94`) serializes only its own calls — including
`syncPrimary`, which checks out and ff-merges the primary working tree. Under
normal multi-task load, concurrent `create()` calls and a sibling task's merge
can collide on the same `.git`, turning git's internal lock contention into
transient `Fatal:` task failures, with the best-effort cleanup paths
swallowing errors and silently orphaning worktrees/branches
(`worktree-manager.ts:455,466,472,1058,1063`).

**Fix:** share one per-`localPath` serialization primitive between
`git-service` and `worktree-manager` (export `withRepoLock` or inject a shared
lock map through `SchedulerDeps`), wrapping only the primary-clone mutations in
`create`/`remove` — not the whole `create()` — so independent worktree setup
stays parallel.

**Likely files:** `packages/engine/src/git-service.ts`,
`packages/engine/src/worktree-manager.ts`, `packages/engine/src/index.ts`
(deps wiring), tests for both.

**Acceptance:** a test dispatches N concurrent `create()` calls (plus one
`syncPrimary`) against one real temp repo and proves serialized primary-clone
access with no orphaned worktrees/branches; existing worktree tests unchanged;
full gates green.

**Fix risk:** low; watch for over-broad locking slowing task bursts.

### O5. Destructive controls use `window.confirm` and can silently no-op — HIGH (robustness/ux)

**Problem:** AGENTS.md forbids `alert()`/`confirm()` for dangerous actions,
and this is a real failure mode: once a browser/webview suppresses dialogs
("prevent additional dialogs"), `confirm()` returns `false` with no prompt —
so **Stop, Stop-all, and Rollback silently do nothing**, the worst failure for
panic controls. Eight call sites: `apps/web/src/App.tsx:153,211,355`,
`apps/web/src/pages/Board.tsx:276`, `apps/web/src/components/TaskCard.tsx:103`,
`apps/web/src/pages/ProjectsView.tsx:173`,
`apps/web/src/components/ProjectHeader.tsx:53`,
`apps/web/src/components/ModelsEditor.tsx:96`.

**Fix:** replace all eight with the inline-confirm pattern the codebase
already uses (`ProjectsView.tsx:197-215` delete flow, `SetupView.tsx:392`
update flow). Keep each action's wording and effect identical; keep 40 px
touch targets and keyboard focus per AGENTS.md.

**Likely files:** the eight components above; a small shared inline-confirm
component if extraction avoids duplication; Vitest interaction tests.

**Acceptance:** zero `window.confirm`/`alert(` occurrences in `apps/web/src`;
interaction tests cover confirm-then-act and confirm-then-cancel for stop,
stop-all, rollback, and discard-settings; browser check at all five required
widths; full gates green.

**Fix risk:** low-medium (several interaction flows touched — the tests are
the point).

### O6. Board state diverges after WS reconnect or external task creation — MEDIUM-HIGH (correctness)

**Problem:** two related gaps in `apps/web/src/pages/Board.tsx`:
(a) the `task.updated` reducer only replaces known tasks
(`Board.tsx:216-218`), so a task created outside this tab (planner commit,
second browser, Telegram, or snapshot replay after reconnect) never appears
until reload — `App.tsx:296-301` and `Notifications.tsx:165-175` already use
the correct update-or-prepend pattern; (b) the headline cost is seeded once
per project (`Board.tsx:134`) then accumulated from `cost.updated` deltas
(`:243`), so events missed during a disconnect (laptop sleep, server restart
mid-run) under-report spend and the budget bar permanently drifts until
reload.

**Fix:** (a) append unknown task ids, mirroring App/Notifications; (b) re-seed
`costUsd` from `costAnalytics` on WS reconnect (the `useWS` hub already knows
reconnects) instead of relying on pure delta accumulation.

**Likely files:** `apps/web/src/pages/Board.tsx`,
`apps/web/src/hooks/useWS.ts` (reconnect signal only if not already exposed),
Vitest interaction tests.

**Acceptance:** interaction tests: `task.updated` for an unknown id appears in
the right column; simulated reconnect re-seeds cost to the server value;
existing drag/optimistic tests unaffected; full gates green.

**Fix risk:** low.

### O7. `mergePr` can fail a genuinely-merged task after restart — MEDIUM-HIGH (correctness)

**Problem:** the already-merged idempotency shortcut depends on a single
`gh pr view ... state` read whose catch swallows the error
(`packages/engine/src/git-service.ts:374-405`). After a crash/restart with the
PR already merged on GitHub, one transient API flap sends the code into
`gh pr merge` retries, which fail on a merged PR, exhaust 3 attempts, and mark
a completed task as failed — then failed-branch cleanup acts on an
already-merged PR.

**Fix:** retry the state read briefly before abandoning the idempotency
check, and treat `gh pr merge`'s "already merged / not open" error as success.
Verify the exact error text against the installed `gh` CLI (AGENTS.md: never
guess CLI behavior).

**Likely files:** `packages/engine/src/git-service.ts`, its tests.

**Acceptance:** tests: state-read fails twice then reports MERGED → task
completes without a merge attempt; `gh pr merge` returning the already-merged
error → treated as success; normal merge and real-failure paths unchanged;
full gates green.

**Fix risk:** low.

### O8. Killed/stuck runs report zero cost — MEDIUM (correctness/accounting)

**Problem:** the stuck-detection abort path fabricates a result with
`costUsd: 0, tokensIn: 0, tokensOut: 0`
(`packages/engine/src/orchestrator.ts:2324-2333`). A model can burn tokens for
up to 30 minutes (`STUCK_DETECTION.maxRunMs`) before SIGKILL and report $0,
violating the "model calls are accounted exactly once" invariant and letting
budget enforcement drift low.

**Fix:** surface partial usage on abort — track last-known usage from the
streamed events in the adapter (or attach it to the thrown
`ManagedProcessError`) so the stuck emit reports real numbers. The
resolved-but-aborted path (`:2273-2280`) already spreads the real result; make
the exception path match.

**Likely files:** `packages/adapters/src/index.ts`,
`packages/adapters/src/managed-process.ts`,
`packages/engine/src/orchestrator.ts`, tests in both packages.

**Acceptance:** test: an author run that streams usage then hangs and is
aborted records the streamed cost/tokens, not zeros; non-stuck paths byte-for-
byte unchanged; ledger still records exactly one terminal outcome per
invocation; full gates green.

**Fix risk:** medium (adapter–engine interface touch); keep it additive.

---

## Phase 2 — Resource bounds and durability

### O9. Adapters retain up to 128 MB of captured output they never read — HIGH on small hosts (efficiency)

**Problem:** `spawnManagedProcess` copies every stdout/stderr chunk into
capture arrays up to `DEFAULT_MAX_OUTPUT_BYTES = 64 MiB` per stream
(`packages/adapters/src/managed-process.ts:7,135-145`), but all three
streaming adapters parse via their own `onData` and discard the settled
result (`packages/adapters/src/index.ts:149,351,547` —
`void managed.settled.catch(() => {})`). Concurrent chatty
`--output-format stream-json` runs holding duplicate multi-MB buffers is a
real OOM path on the 1–2 GB EC2 target
(`deploy/hoopedorc.service:29-30` already worries about this). Secondary: the
64 MiB cap SIGTERM-kills a long legitimate session mid-work with an
undistinguished error.

**Fix:** add `captureOutput?: boolean` (default `true`) to
`ManagedProcessOptions`; when `false`, still count bytes toward
`maxOutputBytes` (keeping the runaway-kill rail) but retain nothing. Pass
`captureOutput: false` from the three streaming adapters (they already keep
their own bounded `stderrTail`). Consider parameterizing the streaming cap so
long legitimate runs aren't killed, and make an output-cap kill
distinguishable in the error reason.

**Likely files:** `packages/adapters/src/managed-process.ts`,
`packages/adapters/src/index.ts`, adapter tests. `execManagedProcess` callers
(engine git/gh/gates) keep the default and are untouched.

**Acceptance:** test proves no buffer retention with `captureOutput: false`
while byte-counting/kill still triggers at the cap; engine callers still get
`result.stdout`; full gates green.

**Fix risk:** low (additive option).

### O10. Synchronous FS walks + hashing block the event loop during worktree prep — HIGH (efficiency/robustness)

**Problem:** `nodeDependencyFingerprint`, `walkFiles`, `dependencyArtifacts`,
`hasDeclaredNodeDependencies`, and `customSetupFingerprint`
(`packages/engine/src/worktree-manager.ts:158-342,897-920`) all use
`readdirSync`/`readFileSync` + synchronous SHA-256 on the dispatch hot path
(`ensureDeps`, `:964-976`), potentially for several tasks at once. On a large
repo this stalls the single event loop — Fastify, WebSocket, and every other
project's scheduler — for hundreds of ms to seconds.

**Fix:** convert to `fs/promises` with streamed hashing, preserving the
deterministic `localeCompare` input ordering so fingerprints stay stable; or
compute the fingerprint once per project revision instead of per worktree.

**Likely files:** `packages/engine/src/worktree-manager.ts`, its tests.

**Acceptance:** fingerprints byte-identical to pre-change values for the same
tree (test with a fixture repo); no `readFileSync`/`readdirSync` remain on the
`create()`/`ensureDeps` path; full gates green.

**Fix risk:** low-moderate (fingerprint stability is the invariant to test).

### O11. Planner chat/deconstruct have no output-size cap — MEDIUM (robustness)

**Problem:** `runPlannerChat` (`packages/server/src/planner.ts:1679-1688`) and
`runPlannerDeconstruct` (`:1759-1767`) call `runPlannerJson` with no `limits`,
so `maxOutputBytes` is undefined; only the Figma probe caps output
(`:1214-1218`, 1 MiB). A runaway CLI turn grows buffered stdout for up to the
5-minute timeout — an OOM/GC-pressure risk on the main server process.

**Fix:** pass a generous `maxOutputBytes` (a few MiB) to chat/deconstruct,
matching the probe's pattern; make the cap-hit error message actionable.

**Likely files:** `packages/server/src/planner.ts`, planner tests.

**Acceptance:** test proves the cap terminates a runaway planner subprocess
with a clear error while normal-size plans are unaffected; full gates green.

**Fix risk:** low (set the cap comfortably above real deconstruct output).

### O12. WebSocket broadcast has no backpressure bound — MEDIUM (robustness)

**Problem:** `broadcast` sends to every client with no `bufferedAmount` check
and no per-send error observation (`packages/server/src/ws-hub.ts:86-100`). A
stalled dashboard tab during a chatty run buffers indefinitely, growing server
memory per stuck client with no drop/close policy.

**Fix:** skip or disconnect clients whose `bufferedAmount` exceeds a cap (a
few MB); keep the existing `readyState` guard. On disconnect-for-backpressure,
close with a distinct code so the web client's reconnect logic treats it as a
normal reconnect (which, after O6, re-seeds state).

**Likely files:** `packages/server/src/ws-hub.ts`, its tests.

**Acceptance:** test with a mock socket whose `bufferedAmount` is inflated
proves the cap triggers; healthy clients unaffected; full gates green.

**Fix risk:** low (only affects clients already failing).

### O13. Missing SQLite indexes on hot, ever-growing tables + orphaned rows — MEDIUM (efficiency)

**Problem:** (a) `getGlobalMonthlyCost`/`getModelMonthlyCost` filter on
`started_at` (`packages/server/src/db/repo.ts:1234-1251`) but the only
`model_invocations` indexes lead with `model`/`project_id`
(`schema.sql:89-94`) — the per-dispatch budget check (`budget.ts:43,125`) is a
growing full-table scan and the table is never pruned. (b) `merge_decisions`
has no index yet `getMergeDecisions` does `WHERE task_id = ? ORDER BY ts DESC`
(`repo.ts:975-980`). (c) `notifications` has no index yet `getNotifications`
filters/sorts per project (`repo.ts:1332-1364`) and the capability lookup
scans by `task_id` (`repo.ts:1300-1319`). (d) `deleteProject`
(`repo.ts:134-154`) removes every project-scoped table except `budget_alerts`
rows with `scope = 'project:<id>'` (written at `repo.ts:1506`), leaking rows.

**Fix:** idempotent migration adding
`idx_model_invocations_started ON model_invocations(started_at)`,
`idx_merge_decisions_task ON merge_decisions(task_id, ts)`, and notification
indexes on `(project_id, created_at)` + `task_id`; add the `budget_alerts`
delete inside the existing `deleteProject` transaction. Do **not** prune
`model_invocations` (it backs historical analytics) — prefer the index.

**Likely files:** `packages/server/src/db/index.ts` (migration),
`packages/server/src/db/schema.sql`, `packages/server/src/db/repo.ts`, repo
tests.

**Acceptance:** migration is idempotent on an existing DB and fresh
`schema.sql` matches; `EXPLAIN QUERY PLAN` shows index use for the three
queries; delete-project test asserts no `budget_alerts` residue; full gates
green.

**Fix risk:** low (additive).

### O14. Multi-write route sequences run outside transactions — LOW-MEDIUM (robustness)

**Problem:** `POST /api/tasks/:id/stop` performs `markTaskStoppedIfActive` →
`updateRun(stopped)` → `createAuditEntry` as three separate writes
(`packages/server/src/index.ts:2149-2178`); `resolveNotification` similarly
splits its writes (`:886-914`). A crash between writes leaves a task `blocked`
with its run still `running` — a confusing inconsistent pair that survives
restart.

**Fix:** wrap each related-write sequence in `db.transaction(...)` (the repo
already does this for `deleteProject` and `terminalizeInvocation`); keep
broadcasts after commit.

**Likely files:** `packages/server/src/index.ts` (or move the sequences into
repo-level transactional helpers), tests.

**Acceptance:** fault-injection test proves all-or-nothing behavior;
broadcasts fire only on commit; full gates green.

**Fix risk:** low.

### O15. Telegram poll offset is memory-only; commands can re-execute after restart — MEDIUM (robustness)

**Problem:** the poll offset starts at 0 and only advances in memory
(`packages/server/src/telegram.ts:201,356-381`), so a restart makes Telegram
redeliver unconfirmed updates: approval taps are safe (single-use resolvers)
but slash commands (`/stopall` confirmation, `/start <project>`) can fire
twice. The offset also advances **before** `processUpdate`, so a crash
mid-processing silently drops that update.

**Fix:** persist the last-processed offset (small settings/db key) and restore
it in `start()`; advance it after successful processing (or make the affected
command handlers idempotent and document the at-least-once window).

**Likely files:** `packages/server/src/telegram.ts`,
`packages/server/src/db/repo.ts` (tiny key-value or settings field), tests.

**Acceptance:** test: restart between receipt and confirmation does not
re-execute a command twice (or the redelivered command is a provable no-op);
offset survives restart; full gates green.

**Fix risk:** low.

### O16. Human-approval waits are not abort-aware — MEDIUM (robustness)

**Problem:** two halves of one gap. Engine: `EngineEvents.requestApproval`
takes no signal (`packages/engine/src/index.ts:101-106`), and the awaits at
`orchestrator.ts:1921,1970,2015,2122,2136` only check stop *after* the human
answers — a Pause issued mid-wait is observed post-answer, and the subsequent
`mergePr(..., signal)` then throws on the aborted signal, silently discarding
the just-given approval. Server: the non-rollback resolver is a bare promise
kept in `pendingApprovals` forever (`packages/server/src/engine-runner.ts:793`)
— unlike `requestRollbackApproval` (`:906-921`), which correctly rejects and
cleans up on abort — so a hard Stop leaks the resolver and its async frame
until process exit.

**Fix:** thread the task's abort signal into `requestApproval` end-to-end,
mirroring the rollback-approval wiring: hard Stop settles/removes the pending
resolver; a pause/drain must **not** reject a pending approval (approvals are
intentionally allowed to wait across a pause) — only re-check pause state
after resolution so an answered approval is honored or safely requeued, never
silently lost.

**Likely files:** `packages/engine/src/index.ts`,
`packages/engine/src/orchestrator.ts`,
`packages/server/src/engine-runner.ts`, tests in both.

**Acceptance:** tests: Stop during a pending approval settles the wait and
removes the resolver; approval answered just after Pause is not discarded
(task requeues with the decision recorded or the merge proceeds —
whichever current documented semantics say — but never a lost decision);
rollback-approval behavior unchanged; full gates green.

**Fix risk:** low-medium (must respect the pause-vs-stop semantic split).

### O17. Self-update can wedge "in progress" for 2 h after an early death — MEDIUM-LOW (robustness)

**Problem:** `start()` persists `state:"queued"` before launching
`systemd-run` (`packages/server/src/self-update.ts:433-440`); the stale window
is a flat 2 h (`STALE_UPDATE_MS`, `:30,236-253`); `buildStatus` refuses new
updates while ACTIVE (`:366-367`). A crash in the pre-launch window, or
`update.sh` dying before its first progress write, blocks updates for 2 hours.

**Fix:** use a much shorter stale window for pre-progress states
(`queued`/`checking`), and/or have `status()` check
`systemctl is-active hoopedorc-self-update.service` before reporting
in-progress. Keep the long window for `building` (a genuinely long step must
not be declared failed prematurely).

**Likely files:** `packages/server/src/self-update.ts`, its tests.

**Acceptance:** tests cover: early-state staleness expires quickly;
`building` keeps the long window; a genuinely active unit is still reported
in-progress; full gates green. Live check on EC2 recorded with the item.

**Fix risk:** low.

### O18. Malformed request bodies produce 500s instead of 400s — LOW-MEDIUM (robustness)

**Problem:** handlers cast `req.body as {...}` without schemas. Example:
`POST /api/projects/:id/tasks` does `dependsOn.find(...)` on an unvalidated
field (`packages/server/src/index.ts:1976-1978`) — a non-array throws an
unhandled `TypeError`; `PATCH /api/tasks/:id` persists unvalidated
`acceptanceCriteria`/`scopePaths` verbatim (`:2098-2099`), which can store a
malformed JSON array shape.

**Fix:** attach Fastify JSON schemas to the mutating routes (validation +
clean 400s) or add explicit `Array.isArray`/element-type guards. Schemas must
exactly match currently accepted shapes — no accidental contract tightening
beyond rejecting what already crashes.

**Likely files:** `packages/server/src/index.ts` (or a small schemas module),
route tests (lands naturally with O27).

**Acceptance:** tests: malformed `dependsOn`/`acceptanceCriteria`/`scopePaths`
get 400 with a useful message; all currently-valid client payloads still
accepted (web test suite as the oracle); full gates green.

**Fix risk:** low.

### O19. `update.sh` parses `.env` naively and can spuriously abort UI updates — LOW (robustness)

**Problem:** `scripts/update.sh:198-200` extracts `PORT`/`API_TOKEN` with
`grep|cut`, so quoted (`API_TOKEN="abc"`) or `export`-prefixed values produce
a wrong token → the running-project pre-check 401s → `--non-interactive` (the
UI path) fails closed with "server unreachable". Safe, but a spurious refusal.

**Fix:** strip surrounding quotes/`export ` prefixes (or read the values in a
subshell). Extend the existing script rather than adding a second updater
(AGENTS.md).

**Likely files:** `scripts/update.sh`.

**Acceptance:** shell test (or documented manual matrix) covering unquoted,
quoted, and `export`-prefixed `.env` values; interactive and non-interactive
paths still fail closed when the server is genuinely unreachable; live EC2
UI-update smoke recorded.

**Fix risk:** low.

### O20. Silent log-flush failures and a lost-cost planner edge — LOW (robustness)

**Problem:** (a) `flushLogs` swallows every SQLite error
(`packages/server/src/engine-runner.ts:216-218`) — a full disk drops all run
logs invisibly; the flush timer is also not `unref()`ed. (b) in
`runPlannerJson`, the terminal `onInvocation({outcome:"completed"})` sits
inside the try (`packages/server/src/planner.ts:917-926`); if that sink write
throws, the catch re-records the same invocation as failed/$0 and surfaces a
successful, paid turn as a failure (`:928-940`).

**Fix:** (a) keep the run-never-breaks guarantee but emit a rate-limited
error log on repeated flush failure; `unref()` the timer. (b) emit the
terminal completed event outside the try, or detect sink-originated errors
and don't re-emit a failed terminal for them.

**Likely files:** `packages/server/src/engine-runner.ts`,
`packages/server/src/planner.ts`, tests.

**Acceptance:** tests: repeated flush failure produces an operator-visible
signal while runs continue; a completed-sink failure neither double-records
nor converts success to failure; full gates green.

**Fix risk:** low.

### O21. Engine lifecycle hygiene: unpruned `mergeConflicts`, pause/status race — LOW-MEDIUM (robustness)

**Problem:** (a) `mergeConflicts` (`packages/engine/src/orchestrator.ts:343`,
written `:1895-1896`) is never deleted or cleared — unlike the sibling
warn-sets reset in `start()` (`:695-699`) — so a task carries conflict-retry
counts across runs and can hit `MAX_MERGE_RETRIES` early. (b) `pause()` flips
active tasks to `backlog` (`:1078-1095`) while `executeTask` concurrently
writes stage statuses (`:1285,1578`); a late stage write leaves a transient
`in_review`/`in_progress` task with no live run until the next start's orphan
recovery.

**Fix:** (a) delete entries in the task pipeline's `finally` (like
`rateLimitWaits`) and/or clear in `start()`. (b) re-check `this.paused`
immediately before each status write in `executeTask`.

**Likely files:** `packages/engine/src/orchestrator.ts`, tests.

**Acceptance:** tests: conflict counts reset across runs; pause leaves no
task in a stage status without a live run; full gates green.

**Fix risk:** very low / low.

---

## Phase 3 — Web live-run smoothness

### O22. Board re-renders and refetches on every streamed log line — HIGH (efficiency)

**Problem:** the live-run hot path re-renders the whole board per event:
`markActivity` creates a new object per `log` event
(`apps/web/src/pages/Board.tsx:191-193,247-255`), `TaskCard` is unmemoized
with fresh inline closures per card (`components/TaskCard.tsx:50`,
`Board.tsx:564-576`), `fetchEstimates()` fires on **every** `task.updated`
(`Board.tsx:224`), and a 1 s `setNowTick` re-renders everything while running
(`:268-272`). Sustained CPU/GC churn on exactly the screen an operator
watches during a run, plus redundant estimate requests server-side.

**Fix:** coalesce `activity` updates (rAF or ~500 ms batch), wrap `TaskCard`
in `React.memo` with stable `useCallback` handlers, debounce `fetchEstimates`
(leading+trailing ~1 s), and scope the ticker so it doesn't re-render the full
tree.

**Likely files:** `apps/web/src/pages/Board.tsx`,
`apps/web/src/components/TaskCard.tsx`, Vitest interaction tests.

**Acceptance:** interaction tests still pass with identical visible behavior
(heartbeat text may lag ≤ the throttle interval); a burst of N log events
causes O(1) board renders per throttle window (assertable via a render
counter in tests); full gates green plus a real-browser check during a live
run.

**Fix risk:** low.

### O23. CostView/AuditView unconditionally refetch on high-frequency events — MEDIUM (efficiency)

**Problem:** `CostView` refetches two endpoints on every `cost.updated` *or*
`task.updated` (`apps/web/src/pages/CostView.tsx:37-45`); `AuditView` refetches
on four event types (`apps/web/src/pages/AuditView.tsx:131-146`). No debounce,
no in-flight dedup — an open Costs/Audit tab streams full-table requests
during a run.

**Fix:** debounce (~1 s trailing) and skip when a request is in flight.

**Likely files:** `apps/web/src/pages/CostView.tsx`,
`apps/web/src/pages/AuditView.tsx`, shared debounce hook if useful, tests.

**Acceptance:** tests prove coalescing under an event burst and a final
trailing refresh; UI freshness lag ≤ ~1 s; full gates green.

**Fix risk:** low.

### O24. No request cancellation — stale responses can overwrite newer state — MEDIUM (robustness)

**Problem:** the `api()` client supports `signal`
(`apps/web/src/api/client.ts:69`) but no caller passes one. Most exposed:
`PlanView`'s 5-request `Promise.all` on project change
(`apps/web/src/pages/PlanView.tsx:178-228`) — a rapid A→B→A switch can let an
older resolution overwrite the newer project's plan/tasks/attachments. Also
`Board.fetchEstimates` (`Board.tsx:107-116`) and `CostView.fetchAll`
(`CostView.tsx:20-31`). (`Board.load` and `TaskDrawer` already use a
`cancelled` flag — the pattern to copy.)

**Fix:** add `AbortController`/`cancelled` guards to `PlanView`'s load effect
and the estimate/analytics fetchers, aborting on project change/unmount.

**Likely files:** `apps/web/src/pages/PlanView.tsx`,
`apps/web/src/pages/Board.tsx`, `apps/web/src/pages/CostView.tsx`, tests.

**Acceptance:** test simulating out-of-order resolutions proves the newest
request wins; no setState-after-unmount warnings; full gates green.

**Fix risk:** low.

### O25. Task log list grows unbounded in the DOM — MEDIUM (efficiency/robustness)

**Problem:** every selected-task log line is appended with no cap
(`apps/web/src/pages/Board.tsx:252`) and `LogPanel` renders the entire array
(`apps/web/src/components/LogPanel.tsx:73-89`). Long runs emit thousands of
lines — unbounded memory and per-render cost while the drawer is open.

**Fix:** cap retained lines (keep last N with a "showing last N" note; full
history stays available via the server-side `taskLogs` fetch) or windowize.

**Likely files:** `apps/web/src/pages/Board.tsx`,
`apps/web/src/components/LogPanel.tsx`, tests.

**Acceptance:** test proves the cap and the visible note; autoscroll and
filtering behavior unchanged; full gates green.

**Fix risk:** low.

### O26. Web minor robustness/a11y batch — LOW-MEDIUM

One PR, five audited paper-cuts (no behavior changes beyond the fixes):

- **Toast timers never cleared** (`apps/web/src/hooks/useToast.tsx:37-39`):
  track and clear on unmount.
- **Dialog semantics** (`components/TaskDrawer.tsx:116`,
  `components/TokenGate.tsx:44`): add `role="dialog"`, `aria-modal`, Escape
  handling, and initial/return focus via a small shared helper (AGENTS.md
  keyboard-focus requirement).
- **LogPanel autoscroll** (`components/LogPanel.tsx:40-42`): respect
  `prefers-reduced-motion` and scroll the container explicitly (as
  `PlanView.tsx:265-274` already does).
- **Dead "New Project" button** (`pages/PlanView.tsx:455-465`,
  `onClick={() => {}}`): wire it to the New Project page or remove the
  misleading control.
- **`useWS` single-project invariant** (`hooks/useWS.ts:161-166`): document at
  the export and upgrade the silent `console.warn` to a dev-only throw.

**Acceptance:** interaction tests for Escape/focus-trap and toast cleanup;
keyboard walkthrough in a real browser; full gates green.

**Fix risk:** minimal.

---

## Phase 4 — Verification depth (tests, CI, lint, docs)

### O27. Server HTTP route tests + extraction of the untested security validators — HIGH (testing)

**Problem:** there is no `app.inject(...)` test anywhere in
`packages/server`. Zero coverage on: `parseProjectConfig`,
`validateLocalPath`, `localPathOkForClone`, `safeToDeleteLocalPath`
(`packages/server/src/index.ts:365,535,559,583`), `redactSettings` (`:594`),
`safeTokenEqual` + loopback guard + the auth `onRequest` hook
(`:829,841,853`), `isValidBranchName`/`isValidRepoUrl` (`:337,346`), and
`pruneLogs` (`db/repo.ts:930`). These gate the two most dangerous behaviors —
the recursive `rmSync` in `DELETE /api/projects/:id` (`index.ts:1435`) and
token auth. A regression here ships green today.

**Fix:** extract the pure path/config/token validators into a
`project-validation.ts` module (the one clearly-justified extraction from the
2,700-line `index.ts` — it shrinks the file *and* makes security logic
testable) and add: unit tests for every validator, plus a Fastify
`app.inject` suite covering auth on/off, 401 + loopback behavior, project
create/delete refusal paths, and the O18 validation cases.

**Likely files:** `packages/server/src/index.ts`, new
`packages/server/src/project-validation.ts` (+ tests), new route test file.

**Acceptance:** all listed helpers have success/refusal/error coverage
(AGENTS.md test standard); delete-refusal paths proven (dirty path, wrong
path, non-managed path); behavior byte-identical (extraction only moves
code); full gates green.

**Fix risk:** low (move + test, no logic change).

### O28. Deterministic fix for the flaky adapters process-tree test — MEDIUM (testing)

**Problem:** the known local-only flake in
`packages/adapters/src/managed-process.test.ts:21-60` ("abort terminates a
SIGTERM-resistant parent and its child") infers process death from
`process.kill(pid, 0)` under fixed 2 s wall-clock deadlines (`:5-19,40,56-58`).
`kill(pid, 0)` treats an **unreaped zombie as alive**; on GitHub CI orphans are
reaped promptly, but in a local/sandboxed environment the orphaned
grandchild's PID entry can outlive the deadline even though it was killed.

**Fix:** observe death via fd closure instead of PID-table absence — have the
grandchild hold an inherited pipe and await pipe EOF (or assert a heartbeat
*stops*); remove the fixed wall-clock deadlines and let the runner's per-test
timeout be the only backstop. Production code unchanged.

**Likely files:** `packages/adapters/src/managed-process.test.ts`.

**Acceptance:** the suite passes ≥20 consecutive local runs including under
CPU load, and still passes on CI; no production changes; full gates green.

**Fix risk:** low (test-only).

### O29. Merge-conflict retry/approval path has zero orchestrator coverage — MEDIUM (testing)

**Problem:** every orchestrator test stubs `syncBranchWithMain()` to
`"clean"` (`packages/engine/src/orchestrator.test.ts:113`), so the conflict
branch of `resolveMergeOutcome`
(`packages/engine/src/orchestrator.ts:1894-1934`: clear `prNumber`, requeue,
cap at `MAX_MERGE_RETRIES`, then `requestApproval`) is never exercised — a
non-trivial idempotency path where a regression ships unnoticed.

**Fix:** add tests: conflict→clean (requeue → re-run → merge); repeated
conflicts → retry cap → approval → fail; restart with the worktree present.
Lands naturally alongside O21(a).

**Likely files:** `packages/engine/src/orchestrator.test.ts`.

**Acceptance:** the new tests fail when the conflict path is deliberately
broken (e.g. `prNumber` not cleared) and pass on current code; full gates
green.

**Fix risk:** none (test-only).

### O30. `ROUTES` manifest is not enforced against server registration — MEDIUM (testing)

**Problem:** all 49 `ROUTES` entries (`packages/types/src/api.ts:623-673`)
currently match the server's hardcoded registrations exactly (verified), but
nothing guards this: the server never imports `ROUTES`, and only the web
client derives URLs from it (`apps/web/src/api/client.ts:50-63`). A future
server path edit without the matching `ROUTES` change silently 404s the web
app.

**Fix:** a server test asserting every `ROUTES` method+path is registered
(via Fastify's route table) and, optionally, the reverse direction.

**Likely files:** new test in `packages/server`.

**Acceptance:** deliberately renaming one route fails the test; full gates
green.

**Fix risk:** low.

### O31. ESLint covers only `apps/web` — the backend is unlinted — MEDIUM (maintainability)

**Problem:** the root `lint` script is `npm run lint -w @orc/web` and every
`eslint.config.js` block scopes to `apps/web/**` (`eslint.config.js:6`).
Adapters/engine/server/types — the bulk of the runtime logic — get no
`no-floating-promises`-class checks (exactly the O2 bug class).

**Fix:** extend `eslint.config.js` to `packages/*/src/**/*.ts` with a
type-checked Node config; update the root `lint` script. Introduce
rules-as-warnings first, then ratchet the backlog to errors in a follow-up so
one PR isn't a thousand-line lint sweep.

**Likely files:** `eslint.config.js`, root `package.json`, hoisted
typescript-eslint dev deps, then targeted fixes.

**Acceptance:** `npm run lint` covers all five workspaces;
`no-floating-promises` (or equivalent) is at least a warning on the backend;
CI runs it; full gates green.

**Fix risk:** low-medium (staged rollout controls the blast radius).

### O32. CI omissions: `git diff --check`, audit gate, Playwright cache — LOW (testing/efficiency)

**Problem:** `.github/workflows/ci.yml` omits `git diff --check` (a declared
repository gate), has no `npm audit` signal, re-downloads the Playwright
browser every run (`:24`, `~/.cache/ms-playwright` never cached), duplicates
type-package builds between the `typecheck` and `build` steps, and has no
`concurrency` group to cancel superseded PR runs.

**Fix:** add the missing steps (`git diff --check`; `npm audit
--audit-level=high` — advisory at first if noise is a concern), cache
`~/.cache/ms-playwright` keyed on the `@playwright/test` version, and add a
`concurrency` group.

**Likely files:** `.github/workflows/ci.yml`.

**Acceptance:** CI enforces the full documented gate list; a whitespace error
fails CI; repeat runs restore the browser from cache; full gates green.

**Fix risk:** none/low.

### O33. `docs/CONTRACT.md` is missing 11 of 49 live routes — MEDIUM (docs)

**Problem:** these registered, typed, client-consumed routes have zero
mention in the contract doc: `updateProject`, `planSessionArchives`,
`retryTask`, `taskDiff`, `costAnalytics`, `estimatePlan`, `telegramTest`,
`auditLog`, `rollbackTask`, `taskRollback`, `testModels`. AGENTS.md names
CONTRACT.md a source of truth; agents planning changes to diff/retry/rollback/
analytics work from an incomplete contract.

**Fix:** document the 11 endpoints (shapes already exist in `api.ts`); add a
small test asserting every `ROUTES` key appears in CONTRACT.md so it can't
regress (pairs with O30).

**Likely files:** `docs/CONTRACT.md`, the O30 test file.

**Acceptance:** every route in `ROUTES` is documented; the coverage test
fails when a route is added undocumented; full gates green.

**Fix risk:** none.

---

## Phase 5 — Structural maintainability and efficiency (careful changes last)

These are the highest-payoff long-term items but the most behavior-sensitive;
they intentionally come after Phases 1–4 so the new tests protect them.

### O34. Consolidate `executeTask`'s duplicated escalation logic — MEDIUM (maintainability)

**Problem:** `executeTask` is ~640 lines
(`packages/engine/src/orchestrator.ts:1208-1845`) with the identical
"exhausted → next fallback → switch/continue, else notify + fail" block
repeated at `:1440-1470`, `:1525-1558`, `:1630-1662`, `:1705-1743`, each
bumping `task.maxAttempts` slightly differently. This duplication already
produced one shipped bug (documented at `:1569` — the `prNumber` gate that
previously skipped `openPr()` forever). Related smell: the retry loop mutates
the **persisted, user-facing** `maxAttempts` as control-flow bookkeeping
(`:1427,1446,1531,1636,1711`), so the board shows creeping "attempt 3/7"
budgets.

**Fix:** extract a single `escalateOrFail(...)` helper used by all four
sites; move the wait/fallback "free retry" bookkeeping into an in-memory
counter so the persisted `maxAttempts` stays stable. Land **after** O29's
tests exist; keep the pipeline structure otherwise intact.

**Likely files:** `packages/engine/src/orchestrator.ts`, orchestrator tests.

**Acceptance:** all existing + O29 orchestrator tests pass unchanged except
where attempt-count expectations become saner (each such change justified in
the PR); persisted `maxAttempts` no longer changes during a run; fallback
order/exhaustion behavior byte-identical; full gates green.

**Fix risk:** medium — behavior-sensitive; the test suite is the rail.

### O35. Scheduler busy-poll efficiency — MEDIUM (efficiency; careful)

**Problem:** the dispatch loop re-fetches and rebuilds all task state every
250 ms per active project (`packages/engine/src/orchestrator.ts:753-1046`,
`reconcileTasks` at `:635-658`, idle delay `:1037`) — ~4 full task-table reads
plus map rebuilds per second even when nothing changes. The poll also drives
cooldown/quota re-checks and mid-run task pickup, so it cannot be naively
slowed.

**Fix:** gate `reconcileTasks`/`getTasks` behind a cheap "tasks changed"
signal (the server owns all writes and can flip a dirty flag/event), keeping
the fast poll only while actively dispatching and preserving the
cooldown/quota wake-ups exactly.

**Likely files:** `packages/engine/src/orchestrator.ts`,
`packages/engine/src/index.ts` (deps), `packages/server/src/engine-runner.ts`
(signal source), tests.

**Acceptance:** existing scheduler/cooldown/quota tests pass unchanged; a new
test proves an external task edit still gets picked up promptly; measured
steady-state DB reads drop (assert via a counting stub); full gates green.

**Fix risk:** medium — wake-up semantics are the invariant; do not merge
without the cooldown tests passing untouched.

### O36. Server and engine hot-path micro-efficiency batch — LOW-MEDIUM (efficiency)

One PR of small, independently safe reductions in redundant work:

- **`liveSettings()` re-read per event** — read once per handler invocation
  instead of multiple times (`packages/server/src/engine-runner.ts:514-601,698`);
  keeps per-event freshness (no cross-event caching).
- **WS catch-up snapshot N+1** — add `getRunsForProject(projectId)` (one
  indexed query + group in memory) replacing per-task `getRuns`
  (`packages/server/src/index.ts:2617-2622`); index `runs(project_id)` if
  missing (fold into O13's migration if convenient).
- **Settings-save full scan** — replace the projects×tasks warning loop
  (`packages/server/src/index.ts:2406-2420`) with one join query.
- **Redundant git diffs per merge decision** — reuse the
  `changedFilesWithStatus` result instead of re-running `git diff` at
  `packages/engine/src/orchestrator.ts:2706` (four-plus subprocess diffs per
  attempt today; `:2631-2634`, `validator.ts:199-203`, `gate-runner.ts:123`).

**Acceptance:** behavior identical (existing tests unchanged); the N+1 and
re-read paths provably collapsed (counting stubs); full gates green.

**Fix risk:** low.

---

## Deliberately deferred (recorded, not scheduled)

- **Gate-container batching** (`gate-runner.ts:113-121` +
  `sandbox.ts:243-284`): each sandboxed gate pays a fresh `docker run`
  cold-start, but the per-gate `withCleanWorktree` isolation is a deliberate
  guarantee (a gate must not consume generated source). Batching would trade
  a documented safety rail for latency — revisit only with a design note
  under `docs/specs/sandbox.md`.
- **Adapter-internal idle timeout** (`packages/adapters/src/index.ts:135,342,539`
  omit `timeoutMs`): stuck detection is the engine watchdog's job by design
  (`index.ts:49`); an adapter backstop is belt-and-suspenders that risks
  double-cancellation semantics. Revisit only if a real watchdog failure is
  observed.
- **Docs-stage commit merges without a re-gate**
  (`orchestrator.ts:2450-2460`): docs-only scope enforced by
  `revertOutOfScope` against `DOCS_ALLOWED_SCOPE`; residual risk accepted. If
  ever tightened, re-run only the cheap no-conflict check.
- **`model_invocations` pruning:** intentionally NOT pruned (backs historical
  cost analytics). O13's index is the chosen mitigation.

## Execution order

Each numbered item is one PR unless noted. Within a phase, order is the
listed order; the phases exist because later work depends on earlier rails
(Phase 4's tests protect Phase 5's refactors; O6 pairs with O12's
close-on-backpressure).

1. Merge this plan as a documentation-only PR after the complete gate.
2. Phase 1: O1 → O2 → O3 → O4 → O5 → O6 → O7 → O8.
3. Phase 2: O9 → O10 → O11 → O12 → O13 → O14 → O15 → O16 → O17 → O18 → O19 →
   O20 → O21.
4. Phase 3: O22 → O23 → O24 → O25 → O26.
5. Phase 4: O27 → O28 → O29 → O30 → O31 → O32 → O33 (O30+O33 may share a
   branch; O18's route tests may land inside O27).
6. Phase 5: O34 → O35 → O36 — each only after the full Phase 4 gates are in
   place and green.
7. After each merge: update this document's item with status + evidence
   (PR, commit, test counts). After each phase: run the complete repository
   gate on `main` and, for deploy-affecting phases (1, 2), a live
   `scripts/update.sh` smoke on the EC2 box with `GET /api/health` evidence.

## Definition of done (whole plan)

- All items merged with recorded evidence, or explicitly moved to the
  deferred section with a reason.
- `npm audit` reports zero high-severity vulnerabilities.
- Every repository gate green on `main`, including the new route tests,
  backend lint, and the de-flaked adapters suite (20 consecutive local runs).
- Feature-parity spot-check on the deployed instance: plan → commit →
  autorun → gates → validate → merge; Telegram approval; rollback; settings
  save; self-update from the UI; dashboard live during a run at phone width.
- No operator data lost: existing projects, tasks, cost history, and settings
  from the pre-optimization database still load and behave identically.
