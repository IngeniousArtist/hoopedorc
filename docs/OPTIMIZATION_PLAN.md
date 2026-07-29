# Optimization Plan — post-productization hardening

**Audience: the implementing model.** Produced 2026-07-28 by five parallel
full-code audits (engine, server core/persistence, server services/planner,
web app, cross-cutting adapters/contract/CI/deps) of the complete codebase at
commit `067e96e` (v0.6.0, Phase 18 closed). Every finding below was verified
against the actual source with file:line evidence; line numbers are accurate
as of `067e96e` and may drift — **re-verify each finding against current code
before implementing it.**

**Safety review:** revised 2026-07-28 after a second plan-to-code audit. This
revision keeps the original O1–O36 identifiers and evidence trail, but corrects
designs that could create false merge success, infinite retries, lost WebSocket
state, duplicate Telegram commands, or restart-unsafe bookkeeping. It also
moves prerequisite regression rails before the behavior they protect and makes
speculative performance work conditional on measurements. Findings changed by
this revision were re-verified against `bf38bb3` (`origin/main` on
2026-07-28); implementation must still re-verify against its own starting
commit.

**Original-author response:** reviewed 2026-07-29 against `a24e637`. The
safety revision's load-bearing counterpoints were spot-verified in code and
are correct: the scheduler tick really is an uncaught `void ...then(...)`
chain under a fatal `unhandledRejection` handler (O2); the merge shortcut
really swallows its single PR-state read, and the original "treat the
already-merged error string as success" fix would have violated the
no-error-string-proof invariant (O7); `requestApproval` really registers a
bare resolver with none of the rollback path's abort wiring (O16); and the
conflict path requeues before the pipeline's `finally` runs, so the original
"clear the counter in `finally`" fix would have made `MAX_MERGE_RETRIES`
unreachable — an infinite conflict-retry loop (O21). The original fixes for
O6, O12, O23, O34, and O35 had the ordering, lost-event, or restart flaws
this revision describes; the corrected designs and the revised execution
order stand. One proportionality question was recorded inline at O15 and is
resolved by the follow-up below.

**Follow-up resolution (2026-07-29):** a full pass over the current Telegram
and lifecycle paths resolved that question in favor of the safety revision.
The offset-only O15 alternative cannot prove exactly-once domain effects across
the post-side-effect/pre-offset crash window without a durable per-update
receipt, which is the core of the proposed inbox/outbox. The pass also
clarified O16/O21's terminology: `drain: true` is the graceful **Pause** that
keeps active approval waits alive; `drain: false` is the hard **Stop** that
aborts and settles them. The item text below is authoritative.

## Goal and non-goals

**Goal:** the same product, running smoother, more efficiently, and more
robustly. Every feature keeps its current behavior. The optimization removes
latent bugs, resource leaks, race conditions, missing bounds, and
verification gaps so the software does not break down or corrupt state during
long autonomous runs.

**Decision rule:** correctness and recovery beat cleverness. Prefer a local
guard, conditional write, bounded queue, or existing contract extension over a
new cross-layer protocol. A performance item does not ship from static
inspection alone: record a reproducible baseline, make the smallest change that
addresses the measured bottleneck, and retain the measurement as acceptance
evidence. If the measured impact is immaterial on the target 1–2 GB host, move
the item to the deferred section instead of adding maintenance burden.

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
- No error-string matching as proof of a durable external outcome. GitHub,
  Git, systemd, and model invocations must be confirmed through authoritative
  state.
- No memory-only replacement for state that currently survives a restart.
- No boolean dirty flag or skipped event where a monotonic generation,
  snapshot, conditional write, or forced resynchronization is required.

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
5. Contract changes follow the matching contract checklist. REST
   route/payload changes update `packages/types/src/api.ts` + `ROUTES` + server
   + web client + mock + `docs/CONTRACT.md` together. WebSocket event changes
   update `packages/types/src/ws.ts` + server snapshot/broadcast behavior + web
   consumer + mock + `docs/CONTRACT.md` together; they do not invent a fake
   REST route. O3 is expected to add a durable planning revision/idempotency
   identity; O6 is expected to add an authoritative cost snapshot event. Do
   not disguise either as an implementation-only detail.
6. SQLite changes ship as idempotent migrations in
   `packages/server/src/db/index.ts` **and**
   `packages/server/src/db/schema.sql`, preserving old rows.
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
11. Performance items additionally record before/after evidence from the same
    fixture, workload, host class, and build. Render/request counts may be
    deterministic test assertions; CPU, event-loop delay, memory, and DB-read
    claims require a repeatable measurement command or script. No
    measurement, no optimization refactor.

**Verification honesty:** a typecheck is not browser verification; a mock is
not a live systemd/EC2 smoke; a passing suite that never exercises the failure
path is not regression coverage.

---

## Workstream 1 — Correctness and security

Workstreams group related ownership areas; they are not implementation order.
The prerequisite-aware sequence near the end of this document is
authoritative.

### O1. Dependency security remediation — HIGH (security)

**Problem:** the lock at the audit commit contains `@fastify/static` 9.1.3,
`find-my-way` 9.6.0, and `fast-uri` 3.1.2. Published upstream fixes require
`@fastify/static` 10.1.2 for the newest non-canonical-path advisory and
`find-my-way` 9.7.0 for the route-lookup crash fixes. The original review
identified `fast-uri` 3.1.3 as the fix for failed IDN hostname
canonicalization, but O1's start-of-item recheck found a newer high-severity
literal-backslash authority-delimiter advisory affecting through 3.1.3;
3.1.4 is therefore the authoritative target. The original audit's
vulnerability count is a point-in-time registry result and must be regenerated
when the item starts; do not preserve stale counts in acceptance evidence.

The static plugin is runtime-facing and pre-auth by design, but Hoopedorc
serves only `apps/web/dist`, with no protected subtree or `allowedPath`
boundary. That lowers the application-specific exploit impact of the
route-guard advisories; it does not justify retaining vulnerable code. The
other high-severity audited packages (`shell-quote` via `concurrently`,
`postcss`, `brace-expansion`) are dev/build paths and still need remediation
because they run in trusted build/update workflows. The lower-severity esbuild
finding is handled explicitly under **Fix** below.

**Upstream evidence:** GitHub advisories
[`GHSA-83w8-p2f5-377r`](https://github.com/fastify/fastify-static/security/advisories/GHSA-83w8-p2f5-377r)
and
[`GHSA-8pvw-jcv7-9cmj`](https://github.com/fastify/fastify-static/security/advisories/GHSA-8pvw-jcv7-9cmj)
identify `@fastify/static` 10.1.1 and 10.1.2 as successive fixes;
[`GHSA-4c8g-83qw-93j6`](https://github.com/fastify/fast-uri/security/advisories/GHSA-4c8g-83qw-93j6)
identifies `fast-uri` 3.1.3 for the original finding;
[`GHSA-v2hh-gcrm-f6hx`](https://github.com/fastify/fast-uri/security/advisories/GHSA-v2hh-gcrm-f6hx)
supersedes that minimum with 3.1.4; the upstream
[`find-my-way` 9.7.0 release](https://github.com/delvedor/find-my-way/releases/tag/v9.7.0)
lists the route-lookup crash fixes. Recheck all five records when O1 starts.

**Fix:** explicitly update `@fastify/static` to ≥10.1.2 and resolve the lock
to `find-my-way` ≥9.7.0 and `fast-uri` ≥3.1.4. Verify the v10 plugin API and
Fastify peer range against the installed package, then inspect the lockfile
diff. Use `npm audit fix --dry-run` only as discovery; do not accept a broad
`npm audit fix` mutation without reviewing every changed direct/transitive
version and its dependency path. The regenerated audit reports one low,
Windows-only esbuild development-server advisory, but the latest `tsup` 8.5.1
still declares esbuild `^0.27.0`; do not force 0.28.1 through an unsupported
override. Retain that explicit low residual until `tsup` publishes a compatible
range.

**Likely files:** `packages/server/package.json`, `package-lock.json`,
possibly the static-registration block in `packages/server/src/index.ts`.

**Acceptance:** `npm audit --audit-level=high` reports zero high
vulnerabilities (plain `npm audit` may report the explicit esbuild low
residual above); the built web app serves correctly through the real server
(index, assets, SPA fallback route, traversal/non-canonical probes remain
confined to `webDist`, API/WS 404 behavior); auth gate behavior on `/api` and
`/ws` unchanged; `npm ls` proves the patched resolved versions; full gates
green. Live smoke after deploy: `GET /api/health` ok and the dashboard loads
through Tailscale Serve.

**Fix risk:** low-medium (plugin major bump with a tiny usage surface).

**Status:** completed in
[#182](https://github.com/IngeniousArtist/hoopedorc/pull/182)
(`d03f0a0`). The resolved graph now uses `@fastify/static` 10.1.2,
`find-my-way` 9.7.0, `fast-uri` 3.1.4, `concurrently` 9.2.4,
`shell-quote` 1.9.0, `postcss` 8.5.24, `nanoid` 3.3.16,
`brace-expansion` 5.0.8, and `content-disposition` 2.0.1. A raw-loopback
regression first reproduced the vulnerable plugin serving a denied private
sentinel through non-canonical paths with HTTP 200; the upgraded plugin
confines the same probes with 403/404 responses. `npm audit
--audit-level=high` passed with zero high findings, the production-only audit
reported zero findings, and plain `npm audit` retained only the explicitly
accepted low esbuild development-server finding. Local verification passed
typecheck, build, lint, engine 184/184, adapters 12/12, server 213/213, web
25/25, E2E 16/16, `git diff --check`, the focused static-server regression
2/2, and a real prebuilt-server smoke covering index, hashed asset, SPA
fallback, API/WS auth/404 behavior, and traversal confinement. Linux
`build-and-test` CI passed in 2m13s.

Post-merge deployment on 2026-07-29 used the canonical fail-closed
`scripts/update.sh` path to fast-forward the clean production checkout from
`a96d9c8` to `d03f0a0`, install, build every workspace, and restart the exact
matching `hoopedorc.service`. The deployed checkout was clean, the service was
active, its only project was idle, and `GET /api/health` reported `ok=true`,
`mock=false`, version `0.6.0`, state `running`, and no degraded dependencies.
Both loopback and Tailscale Serve returned HTTP 200 for the
dashboard and its hashed JavaScript asset. A real browser loaded the
production token gate at 390, 768, and 1440 px with no document-level
horizontal overflow or console errors.

### O2. Scheduler tick unhandled rejection can shut down the whole server — HIGH (robustness)

**Problem:** `checkSchedules` runs
`void startProject(...).then(...)` with **no `.catch`**
(`packages/server/src/index.ts:771-790`); the `.then` callback itself calls
`repo.updateProject` and `broadcast`. `installShutdownHandlers` treats any
`unhandledRejection` as fatal and shuts the entire server down with exit 1
(`packages/server/src/shutdown.ts:131-137`). A transient SQLITE_BUSY during a
routine 60-second tick can therefore kill every running project.

**Fix:** make the scheduler tick an explicitly owned background operation:
catch and log schedule/start failures with project and schedule context, and
ensure the tick itself always settles. If multiple startup/timer paths have
the same shape, add one small `runBackground(label, promise)` helper that
registers the promise for shutdown settlement and logs its rejection. Do not
indiscriminately catch correctness-critical persistence or Git promises inside
request/task flows; those failures must continue to propagate to their owner.
Sweep server startup, interval, timeout, and event-listener callbacks for
unowned promises and classify each one as awaited, deliberately owned, or a
bug.

**Implementation decision (2026-07-29):** reuse the existing shutdown-tracked
background-operation set behind one helper that attaches its rejection handler
synchronously, logs a contextual label exactly once, and removes the settled
operation. Use that owner for DB backups, scheduled starts, and resume-on-boot
starts rather than maintaining separate fire-and-forget patterns. Extract the
schedule iteration into `scheduler.ts` with injected start/update/broadcast
boundaries so each rejection point is fault-testable without booting the
server. Shutdown first clears the timers and begins the existing bounded
engine shutdown, then awaits the registered wrappers before closing SQLite.
Do not change request, planning, Git, task-run, Telegram-delivery, or
orchestrator error policy in this item.

**Likely files:** `packages/server/src/index.ts`,
`packages/server/src/scheduler.ts`, and a focused background-operation
module/test; `packages/server/src/shutdown.ts` only if the existing coordinator
cannot await the shared owner cleanly.

**Acceptance:** fault injection proves rejected `startProject`,
`updateProject`, and `broadcast` work is logged once with context and never
becomes an `unhandledRejection`; shutdown waits for any registered background
operation according to the existing shutdown deadline; an audit table in the
PR lists every changed bare promise and its owner (grep alone is not proof);
full gates green.

**Fix risk:** negligible.

**Status:** completed in
[#184](https://github.com/IngeniousArtist/hoopedorc/pull/184)
(`3e4c793`). One background-operation owner now starts work without changing
call ordering, attaches rejection handling synchronously, reports a contextual
failure once, unregisters on settlement, and is awaited during shutdown. DB
backups, per-project schedule starts, and resume-on-boot starts share that
owner. The PR audit classifies the remaining startup, timer, framework, and
fatal-handler callbacks without widening request, Git, task, Telegram, or
orchestrator error policy.

Fault injection covers rejected scheduled Start, expected Start refusal,
`SQLITE_BUSY` while stamping the scheduled run, broadcast failure, success,
immediate ordering, and shutdown settlement. Focused O2/scheduler tests passed
20/20. Full local verification passed typecheck, build, lint, engine 184/184,
adapters 12/12, server 220/220, web 25/25, E2E 16/16, `git diff --check`, and a
real prebuilt-server smoke covering health, dashboard, API auth, and graceful
SIGTERM exit 0. Linux `build-and-test` CI passed in 2m16s.

Post-merge deployment on 2026-07-29 used `scripts/update.sh` to fast-forward
the clean, idle production checkout from `d03f0a0` to `3e4c793`, install,
build, and restart the exact matching `hoopedorc.service`. The deployed
checkout remained clean; health reported running with no degradation; the
dashboard and hashed asset returned HTTP 200 through loopback and Tailscale
Serve. Its one project had no enabled schedule, so the live item-specific check
did not mutate operator configuration: across a complete scheduler interval
the service kept PID 264382, systemd reported zero restarts, health stayed 200,
and the journal contained zero warnings or `unhandledRejection` entries. The
due-project rejection boundary is therefore proven by deterministic fault
injection rather than a fabricated production failure.

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

**Fix:** give each editable planning draft an immutable `revisionId` that is
created when that draft/revision starts and is reused by every retry. Bind the
revision to a canonical hash of the exact PRD, task draft, and generated
guidance so the same token cannot be reused with different content. Add a
`planning_commits` receipt (or equivalently named table) with a database
uniqueness constraint on `(project_id, revision_id)`, state, content hash, and
the created task IDs/result needed to reproduce the successful response.

The commit endpoint carries `revisionId`; this is a real shared-contract
change. Reserve/read the receipt before external effects. If it is already
successful and the hash matches, return the recorded result without touching
Git or tasks. If the hash differs, refuse it. Keep the receipt pending across a
repository/archive failure so the exact saved draft can retry. In the final
SQLite transaction, materialize tasks, mark the project planned, clear scratch,
and mark the receipt successful with the created IDs. Thus a crash rolls back
both tasks and success, while a lost HTTP response replays the receipt. A new
planning iteration always receives a new revision even when its text happens
to match an older iteration; content hash alone is not the idempotency key.

**Likely files:** `packages/types/src/api.ts`, `packages/server/src/db/index.ts`,
`packages/server/src/db/schema.sql`, `packages/server/src/db/repo.ts`,
`packages/server/src/planning-commit.ts`, `packages/server/src/index.ts`,
`packages/server/src/planning-commit.test.ts`,
`apps/web/src/api/client.ts`, planning UI/mock tests, `docs/CONTRACT.md`.

**Acceptance:** migration preserves existing planning sessions and initializes
an active revision safely; successful commit → server restart → identical
resubmit returns the original created task IDs with no new task, archive,
commit, or push; two concurrent submissions of one revision have one owner and
one replayable result; reuse of a revision with changed content is refused; a
new revision with identical content still creates a legitimate second
iteration; failures before Git, after push, and during finalization remain
retryable without duplicates; the existing failed-retry cases stay green;
full API checklist and repository gates green.

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

**Fix:** move the existing serializer into one engine-owned repository lock
module used by both `git-service` and `worktree-manager`. Derive a canonical
lock key from the validated repository/common Git directory (not an
un-normalized caller path), and remove idle chain entries so a long-lived
server does not retain one entry forever per historical project.

Lock every mutation of shared Git metadata as one intentional sequence:
stale remote/local branch cleanup, worktree remove/prune/add, and
`ensureGitExclude` (it writes the common `.git/info/exclude`). Dependency
installation and task work inside the new worktree stay outside the shared
lock. Failure cleanup reacquires the same lock before mutating worktree/branch
metadata and logs a typed cleanup failure; it must not silently report a clean
state. `GitServiceImpl` keeps using the same primitive for primary checkout,
merge, commit, push, and rollback operations.

**Likely files:** a focused module under `packages/engine/src/`,
`packages/engine/src/git-service.ts`,
`packages/engine/src/worktree-manager.ts`, exports/wiring, and real-repository
concurrency tests.

**Acceptance:** a test dispatches N concurrent `create()` calls plus
`syncPrimary` and cleanup against one real temporary repo and proves shared
metadata operations never overlap, with no `index.lock`, orphaned worktree, or
orphaned branch; equivalent paths/symlinks resolve to one lock; cancellation
while queued never later executes the mutation; a failed cleanup is observable
and retryable; different repositories still operate concurrently; the lock
registry returns to its baseline size after settlement; full gates green.

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

**Fix:** replace all eight with one small accessible confirmation primitive,
using the existing inline-confirm visual language. It owns initial focus,
focus containment/return, Escape/cancel, pending/disabled state, and an
actionable inline error while preserving the caller's input. Keep each
action's wording and effect identical and retain at least 40 px phone touch
targets. A shared primitive is justified here because inconsistent keyboard
and duplicate-submit behavior across eight safety controls is itself a
failure risk.

**Likely files:** the eight components above; a small shared inline-confirm
component if extraction avoids duplication; Vitest interaction tests.

**Acceptance:** zero `window.confirm`/`alert(` occurrences in `apps/web/src`;
interaction tests cover confirm, cancel/Escape, focus return, duplicate-click
suppression, and rejected-action error retention for stop, stop-all, rollback,
and discard-settings; keyboard and touch browser checks at all five required
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

**Fix:** (a) use update-or-insert for unknown task IDs, mirroring
App/Notifications. (b) Add an authoritative `cost.snapshot` WebSocket event
containing the current project total. Include it in the synchronous subscribe/
reconnect catch-up snapshot and send that snapshot before any later deltas for
the connection. The Board replaces its total on `cost.snapshot` and applies
only subsequent `cost.updated` deltas. Do not race an asynchronous REST reseed
against newer WebSocket deltas.

This is a shared event-contract change: update `packages/types`, the server
snapshot producer, mock behavior, web consumer, and `docs/CONTRACT.md`
together. Pair the implementation with O12 so a client disconnected for
backpressure always returns through this same full-resynchronization path.

**Likely files:** `packages/types/src/ws.ts`,
`packages/server/src/index.ts`, `packages/server/src/ws-hub.ts`,
`apps/web/src/pages/Board.tsx`, WebSocket mock/tests, `docs/CONTRACT.md`.

**Acceptance:** an unknown `task.updated` appears in the correct column;
connect/reconnect snapshot reports the database total; a delta arriving
immediately after the snapshot is applied exactly once and cannot be
overwritten by an older REST response; a forced O12 slow-client disconnect
reconnects to the right task and cost state; existing drag/optimistic behavior
is unchanged; the full WebSocket contract checklist and repository gates are
green.

**Fix risk:** medium because event ordering is the invariant.

### O7. `mergePr` can fail a genuinely-merged task after restart — MEDIUM-HIGH (correctness)

**Problem:** the already-merged idempotency shortcut depends on a single
`gh pr view ... state` read whose catch swallows the error
(`packages/engine/src/git-service.ts:374-405`). After a crash/restart with the
PR already merged on GitHub, one transient API flap sends the code into
`gh pr merge` retries, which fail on a merged PR, exhaust 3 attempts, and mark
a completed task as failed — then failed-branch cleanup acts on an
already-merged PR.

**Fix:** centralize an authoritative PR-state probe using structured
`gh pr view --json state,mergedAt,mergeCommit` output and bounded retry/backoff.
Probe before merge. After any ambiguous/failed `gh pr merge`, probe again:
only GitHub state `MERGED` with merge evidence is success; `CLOSED` is a
failure; an unavailable/unknown state remains a typed retryable failure. Never
treat `"already merged"`, `"not open"`, or any other CLI error string as
proof. Preserve the existing local sync/verification after confirmed merge.

**Likely files:** `packages/engine/src/git-service.ts`, its tests.

**Acceptance:** state reads fail twice then report `MERGED` → no merge attempt;
the merge command fails but the follow-up probe reports `MERGED` → success;
the same command error followed by `OPEN`, `CLOSED`, malformed JSON, or probe
exhaustion is not success; retry/backoff is bounded and cancellation-aware;
normal merge/local-sync paths are unchanged; full gates green.

**Fix risk:** low.

### O8. Killed/stuck runs report zero cost — MEDIUM (correctness/accounting)

**Problem:** the exceptional stuck-detection abort path fabricates a result with
`costUsd: 0, tokensIn: 0, tokensOut: 0`
(`packages/engine/src/orchestrator.ts:2324-2333`). A model can burn tokens for
up to 30 minutes (`STUCK_DETECTION.maxRunMs`) before SIGKILL and report $0,
violating the "model calls are accounted exactly once" invariant and letting
budget enforcement drift low. The production streaming adapters normally
resolve an aborted managed process with accumulated usage, so first determine
whether this thrown-abort branch can actually follow emitted usage; do not
expand an interface on a hypothetical path.

**Fix:** start with a production-shaped regression test for each adapter:
emit usage, hang, trigger stuck cancellation, and observe the terminal ledger.
If usage already survives, narrow/remove the fabricated-zero fallback without
changing the adapter contract. If the real CLI emits usable partial usage that
is currently lost on a thrown path, attach the last parsed usage to a typed
abort result/error additively. If the upstream CLI emits no usage before
termination, record usage as unavailable/unknown rather than inventing zero;
only introduce that contract distinction with the full types/persistence/
analytics migration it requires.

**Likely files:** initially adapter and orchestrator tests; only then, if
reproduced, `packages/adapters/src/index.ts`,
`packages/adapters/src/managed-process.ts`,
`packages/engine/src/orchestrator.ts`, and possibly shared ledger types/schema.

**Acceptance:** the pre-fix production-shaped test demonstrates the actual
loss before implementation proceeds; every cancelled invocation has exactly
one terminal ledger row; observed partial usage is preserved, while genuinely
unreported usage is never presented as a measured zero; normal and
resolved-abort paths remain byte-for-byte equivalent; full gates green. If the
loss cannot be reproduced, close O8 with the evidence and no production
refactor.

**Fix risk:** medium; evidence gates the interface change.

---

## Workstream 2 — Resource bounds and durability

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

**Fix:** first add a reproducible large-repository fixture/benchmark and
measure event-loop delay plus worktree-preparation wall time under concurrent
dispatch. If the synchronous work is material on the target host, convert the
measured walkers to `fs/promises` with bounded concurrency and streamed
hashing, preserving deterministic path ordering and exact fingerprint bytes.
Limit dependency fingerprints to the package manifests and lockfiles that
actually define installation state; do not recursively hash arbitrary source
content. Do not add a cross-worktree cache unless its invalidation key is a
real Git revision plus the relevant setup inputs.

**Likely files:** `packages/engine/src/worktree-manager.ts`, its tests.

**Acceptance:** the PR records baseline and after measurements from the same
fixture, concurrency, build, and host class; fingerprints are byte-identical
for npm/yarn/pnpm and custom-setup fixtures; concurrency is bounded; no
synchronous traversal remains on the measured hot path; full gates green. If
the baseline does not cause a meaningful event-loop/request-latency impact,
defer O10 with the numbers and make no production change.

**Fix risk:** low-moderate (fingerprint stability is the invariant to test).

### O11. Planner chat/deconstruct have no output-size cap — MEDIUM (robustness)

**Problem:** `runPlannerChat` (`packages/server/src/planner.ts:1679-1688`) and
`runPlannerDeconstruct` (`:1759-1767`) call `runPlannerJson` with no `limits`,
so `maxOutputBytes` is undefined; only the Figma probe caps output
(`:1214-1218`, 1 MiB). A runaway CLI turn grows buffered stdout for up to the
5-minute timeout — an OOM/GC-pressure risk on the main server process.

**Fix:** measure the largest representative stored planner/deconstruct outputs
and choose an explicit cap with a documented generous margin (including
multibyte JSON), subject to the target-host memory budget. Reuse the managed
process byte cap and return a typed, actionable limit error; do not silently
truncate JSON into a misleading parser failure.

**Likely files:** `packages/server/src/planner.ts`, planner tests.

**Acceptance:** the chosen byte value and observed maximum are recorded in the
PR; exact-boundary, one-byte-over, multibyte, normal-plan, and retry cases are
tested; cap termination settles the whole process group and reports the limit;
normal plans are unaffected; full gates green.

**Fix risk:** low (set the cap comfortably above real deconstruct output).

### O12. WebSocket broadcast has no backpressure bound — MEDIUM (robustness)

**Problem:** `broadcast` sends to every client with no `bufferedAmount` check
and no per-send error observation (`packages/server/src/ws-hub.ts:86-100`). A
stalled dashboard tab during a chatty run buffers indefinitely, growing server
memory per stuck client with no drop/close policy.

**Fix:** set a documented per-client `bufferedAmount` ceiling and terminate
the slow client with a distinct application close code; never skip an event
while leaving that connection open, because it would silently diverge.
Observe/catch failure per socket so one broken client cannot abort delivery to
healthy clients. The browser reconnects with bounded backoff and receives the
O6 authoritative snapshot before later deltas.

**Likely files:** `packages/server/src/ws-hub.ts`, its tests.

**Acceptance:** an inflated client is closed once with the documented code
before the event is skipped; other clients receive the same broadcast even
when one `send` throws; reconnect restores authoritative task and cost state;
the ceiling has a measured/documented memory rationale; full gates green.

**Fix risk:** low (only affects clients already failing).

### O13. Missing SQLite indexes on hot, ever-growing tables + orphaned rows — MEDIUM (efficiency)

**Problem:** (a) `getGlobalMonthlyCost` filters only on `started_at`
(`packages/server/src/db/repo.ts:1244-1251`), while the current indexes lead
with `model` or `project_id`; the `(model, started_at)` index already covers
the model-month query and should not be duplicated. (b) `merge_decisions`
has no index for `WHERE task_id = ? ORDER BY ts DESC`. (c) notifications need
different support for newest global/project lists, the old-pending-approval
UNION, and the task-scoped capability lookup. (d) `deleteProject` misses
`budget_alerts` with `scope = 'project:<id>'` and can miss project-level logs
whose `task_id` is empty even though `logs.project_id` identifies them.

**Fix:** capture `EXPLAIN QUERY PLAN` and representative row counts before
choosing indexes. The expected minimal set is
`model_invocations(started_at)`,
`merge_decisions(task_id, ts DESC)`,
`notifications(created_at DESC)`,
`notifications(project_id, created_at DESC)`, and
`notifications(task_id, created_at DESC)`, plus partial global/project indexes
for `requires_approval = 1 AND responded_with IS NULL` only if the UNION plans
need them. Avoid redundant indexes that increase every insert without serving
a measured query. Delete logs directly by `project_id` and project-scoped
budget alerts inside the existing project-deletion transaction. Do **not**
prune invocation history.

**Likely files:** `packages/server/src/db/index.ts` (migration),
`packages/server/src/db/schema.sql`, `packages/server/src/db/repo.ts`, repo
tests.

**Acceptance:** migration is idempotent on an existing database and fresh
schema matches; before/after `EXPLAIN QUERY PLAN` evidence covers global and
model monthly cost, merge decisions, global/project newest notifications,
pending approvals, and capability lookup; delete-project tests leave no row
for the project in logs or budget alerts (including an empty-task-id log) and
preserve other projects; full gates green.

**Fix risk:** low (additive).

### O14. Multi-write route sequences run outside transactions — LOW-MEDIUM (robustness)

**Problem:** `POST /api/tasks/:id/stop` performs
`markTaskStoppedIfActive` → `updateRun(stopped)` → `createAuditEntry` as
separate writes after requesting process cancellation
(`packages/server/src/index.ts:2149-2178`). `resolveNotification` is more
dangerous: it calls `engine.resolveApproval` first, which can resume a merge,
then records the response/audit (`:886-914`). A persistence failure can
therefore apply a human decision that durable state says never happened.

**Fix:** create focused conditional repository transitions. For Stop, after
the engine accepts cancellation, atomically transition only the still-active
task/run pair and write the audit; broadcasts use rows read after commit.
Document and test the unavoidable crash window between process cancellation
and the transaction: startup recovery must terminalize the orphaned run and
must never revive the killed task.

For approval, use the notification row as a durable inbox/outbox: atomically
claim the still-pending notification, record the choice/audit, and mark the
decision pending delivery; only then resolve the in-memory waiter. Mark it
applied after successful delivery. Startup recovery redelivers a recorded but
unapplied decision to the recovering task, and the engine-side consumer is
idempotent so a crash after delivery but before the applied marker cannot
merge twice. An expired/no-owner response is recorded distinctly and must not
pretend the choice took effect. Do not hold a SQLite transaction open across
engine/process/Git work.

**Likely files:** `packages/server/src/db/index.ts`,
`packages/server/src/db/schema.sql`, `packages/server/src/db/repo.ts`,
`packages/server/src/index.ts`, `packages/server/src/engine-runner.ts`, engine
approval recovery tests, and `docs/CONTRACT.md` if response semantics change.

**Acceptance:** fault injection at every boundary proves atomic DB state;
failed persistence never releases an approval; crash after recorded-before-
delivery and after delivery-before-applied both recover to one applied
decision; two channels racing one notification yield one winner; Stop leaves
task/run/audit consistent and broadcasts only committed rows; no transaction
spans an external side effect; full gates green.

**Fix risk:** medium; the recovery tests are mandatory.

### O15. Telegram poll offset is memory-only; commands can re-execute after restart — MEDIUM (robustness)

**Problem:** the poll offset starts at 0 and only advances in memory
(`packages/server/src/telegram.ts:201,356-381`), so a restart makes Telegram
redeliver unconfirmed updates: approval taps are safe (single-use resolvers)
but slash commands (`/stopall` confirmation, `/start <project>`) can fire
twice. The offset also advances **before** `processUpdate`, so a crash
mid-processing silently drops that update.

**Fix:** add a durable Telegram inbox keyed by Telegram `update_id`, with a
unique constraint, payload/command identity, processing state, and timestamps.
Insert/claim the update before handling it. Database-only command effects and
the processed marker commit together. Commands that trigger engine/external
work use a durable pending-action/outbox row keyed by `update_id`; a
restart resumes that action, and the domain handler accepts the same
idempotency key so replay cannot start/stop/approve twice. Advance the poll
offset only over the contiguous range of durably processed updates; on boot,
finish claimed/pending rows before requesting newer updates. Retain/prune old
completed inbox rows with a documented window while preserving the high-water
mark.

Persisting an offset after side effects is only at-least-once and is not
sufficient: a crash between those two operations duplicates the command.
Marking it first merely changes the bug into a lost command.

**Go/no-go resolution (original-author follow-up, 2026-07-29):** build the
durable inbox/outbox design. A persisted offset advanced after processing
still leaves a crash window after the domain side effect and before the offset
write. Refusing `/start` only while a run is active does not close that window:
the first run can finish or recovery can settle before the same update is
replayed. A memory-only or merely single-use `/stopall` nonce also does not
survive restart. The inbound mutation surface is broader than the two commands
named in the earlier question: `/retry`, project start/pause callbacks, and
settings-changing commands must all be classified and proven idempotent too.
A smaller implementation is acceptable only if it retains a durable
per-`update_id` receipt and passes the same crash/concurrency tests; that is the
same safety invariant as this inbox, not an offset-only alternative.

**Likely files:** `packages/server/src/telegram.ts`,
`packages/server/src/db/index.ts`, `packages/server/src/db/schema.sql`,
`packages/server/src/db/repo.ts`, command/engine entry points that receive the
idempotency key, and restart tests.

**Acceptance:** crash injection before claim, after claim, after side effect,
and before offset advance results in exactly one domain action and eventual
processed state; out-of-order updates do not advance the contiguous offset
past a gap; two poll loops cannot own one update; approval and confirmation
single-use behavior remains; migration/retention are idempotent; full gates
green.

**Fix risk:** medium; this is a durable inbox/outbox, not an offset-only patch.

### O16. Human-approval waits are not abort-aware — MEDIUM (robustness)

**Problem:** two halves of one gap. Engine: `EngineEvents.requestApproval`
takes no signal (`packages/engine/src/index.ts:101-106`), and the awaits at
`orchestrator.ts:1921,1970,2015,2122,2136` only check stop *after* the human
answers. The user-facing hard **Stop** (`drain: false`) aborts the task
controller, but the approval promise stays pending; if the human answers
later, the subsequent `mergePr(..., signal)` throws on the already-aborted
signal and silently discards the choice. The graceful **Pause**
(`drain: true`) deliberately does not abort active controllers and may keep
waiting for that approval. Server: the non-rollback resolver is a bare promise
kept in `pendingApprovals` forever
(`packages/server/src/engine-runner.ts:793`) — unlike
`requestRollbackApproval` (`:906-921`), which correctly rejects and cleans up
on abort — so a hard Stop leaks the resolver and its async frame until process
exit.

**Fix:** thread the task's hard-stop abort signal into `requestApproval`
end-to-end, mirroring the rollback-approval wiring. A hard Stop settles/removes
the pending resolver and transitions its notification to an explicit
cancelled/expired outcome, so a late UI/Telegram choice cannot claim it was
recorded or resume a merge. A `drain: true` Pause does **not** abort the signal:
the approval remains live, and after resolution the active pipeline may finish
normally as part of the drain. Preserve this distinction through O14's later
durable decision-delivery work.

**Likely files:** `packages/engine/src/index.ts`,
`packages/engine/src/orchestrator.ts`,
`packages/server/src/engine-runner.ts`, the focused notification transition in
`packages/server/src/db/repo.ts`, and tests in both packages.

**Acceptance:** tests: hard Stop during a pending approval settles the wait,
removes the resolver, marks the notification non-pending, and never merges;
a late choice gets an honest expired/cancelled response. A `drain: true` Pause
keeps the same approval live, applies one answer, and lets the drain settle
normally. Rollback-approval behavior is unchanged; full gates green.

**Fix risk:** low-medium (must respect the pause-vs-stop semantic split).

### O17. Self-update can wedge "in progress" for 2 h after an early death — MEDIUM-LOW (robustness)

**Problem:** `start()` persists `state:"queued"` before launching
`systemd-run` (`packages/server/src/self-update.ts:433-440`); the stale window
is a flat 2 h (`STALE_UPDATE_MS`, `:30,236-253`); `buildStatus` refuses new
updates while ACTIVE (`:366-367`). A crash in the pre-launch window, or
`update.sh` dying before its first progress write, blocks updates for 2 hours.

**Fix:** use state-specific persisted deadlines: `queued`/`checking` expire
after five minutes without a progress timestamp; `pulling`/`installing`/
`building`/`restarting` retain the existing two-hour allowance. On expiry
persist a typed failed result explaining the last state, so the next request
is unblocked. Do not add a `systemctl` probe to normal status reads: that would
couple tests and non-systemd deployments to a host command while still
leaving race windows. If production evidence shows five minutes is too short,
adjust it from measured update-script transitions.

**Likely files:** `packages/server/src/self-update.ts`, its tests.

**Acceptance:** tests cover every state's deadline boundary, clock skew, and
restart; early stale state becomes an explanatory failure and permits retry;
fresh early state and long-running build remain active; a live EC2 smoke
records observed state transition times and successful recovery from a
deliberately stale fixture; full gates green.

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

**Fix:** parse `.env` with a small Node helper using the already-installed
`dotenv` parser (or an equally strict non-executing parser) and return only the
two named values to `update.sh`. Never `source`, `eval`, or execute `.env`
content. Preserve whitespace, `#`, quotes, and `=` inside values correctly and
avoid printing the token in logs/errors. Extend the canonical updater rather
than adding a second update path.

**Likely files:** `scripts/update.sh`, a focused helper/test under `scripts/`.

**Acceptance:** automated cases cover unquoted, single/double quoted,
`export`-prefixed, whitespace, comments, embedded `#`/`=`, empty, malformed,
and command-substitution-looking values; no input is executed and no token is
logged; interactive and non-interactive paths still fail closed when the
server is genuinely unreachable; live EC2 UI-update smoke recorded.

**Fix risk:** low.

### O20. Silent log-flush failures and a lost-cost planner edge — LOW (robustness)

**Problem:** (a) `flushLogs` swallows every SQLite error
(`packages/server/src/engine-runner.ts:216-218`) — a full disk drops all run
logs invisibly; the flush timer is also not `unref()`ed. (b) in
`runPlannerJson`, the terminal `onInvocation({outcome:"completed"})` sits
inside the try (`packages/server/src/planner.ts:917-926`); if that sink write
throws, the catch re-records the same invocation as failed/$0 and surfaces a
successful, paid turn as a failure (`:928-940`).

**Fix:** (a) keep the run-never-breaks guarantee but emit a rate-limited,
operator-visible error on repeated flush failure; retain failed buffered logs
for a bounded retry instead of discarding them, and `unref()`/settle the timer
during shutdown. (b) separate model execution/parsing from the single terminal
accounting callback. Once the model result exists, call the completed sink
outside the execution catch. A sink failure becomes a typed, fail-closed
accounting-persistence failure: do not invoke the model again, do not emit a
second failed/$0 terminal, and do not report the invocation as durably
complete.

**Likely files:** `packages/server/src/engine-runner.ts`,
`packages/server/src/planner.ts`, tests.

**Acceptance:** repeated flush failures keep a bounded batch for retry and
produce a rate-limited signal; recovery flushes it once; shutdown settles the
timer. A completed-sink failure produces one model execution, one terminal
callback attempt, no fabricated failed/$0 callback, and a typed failure that
halts the owning planner flow; exactly-once ledger tests remain green; full
gates green.

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

**Fix:** (a) clear stale conflict counts at the start of a genuinely new
project run and when a task reaches a terminal/clean merge outcome. Do **not**
delete the counter in `executeTask.finally`: a conflict path requeues and then
runs `finally`, so that would reset every attempt and make the retry cap
unreachable. Preserve the count across conflict requeues within one run.

(b) funnel transient stage writes through one synchronous
`publishActiveStage(task, status)` helper that checks paused state and current
task ownership immediately adjacent to the update, with no `await` gap.
Hard `pause(..., { drain: false })` first sets the paused state, then
aborts/settles the active pipelines, and finally persists backlog only for
tasks that remain non-terminal and owned by that orchestrator. Graceful
`drain: true` behavior remains unchanged: it does not set `paused`, abort
controllers, or rewrite active status. Terminal writes use their existing
explicit paths. This avoids a check-then-await TOCTOU without adding a new
persistence protocol.

**Likely files:** `packages/engine/src/orchestrator.ts`, tests.

**Acceptance:** O29 lands first. Tests prove conflict 1 → requeue → conflict 2
reaches the cap; a later new run starts fresh; terminal/clean tasks leave no
counter. Barrier-controlled tests pause immediately before every transient
stage publication and prove no task remains in a stage status without a live
run; drain semantics and approval waits remain unchanged; full gates green.

**Fix risk:** very low / low.

---

## Workstream 3 — Web live-run smoothness

### O22. Board re-renders and refetches on every streamed log line — HIGH (efficiency)

**Problem:** the live-run hot path re-renders the whole board per event:
`markActivity` creates a new object per `log` event
(`apps/web/src/pages/Board.tsx:191-193,247-255`), `TaskCard` is unmemoized
with fresh inline closures per card (`components/TaskCard.tsx:50`,
`Board.tsx:564-576`), `fetchEstimates()` fires on **every** `task.updated`
(`Board.tsx:224`), and a 1 s `setNowTick` re-renders everything while running
(`:268-272`). Sustained CPU/GC churn on exactly the screen an operator
watches during a run, plus redundant estimate requests server-side.

**Fix:** instrument a representative board fixture with React render counts,
estimate request counts, and browser main-thread timing during a fixed log
burst. Then fix only the measured sources: coalesce activity state with a
bounded trailing update, invalidate estimates only on task fields that affect
them, and isolate the one-second clock into the smallest consumer. Add
`React.memo`/stable callbacks only where the profiler proves prop identity is
causing repeated card renders; blanket memoization adds comparison and
dependency complexity without proof.

**Likely files:** `apps/web/src/pages/Board.tsx`,
`apps/web/src/components/TaskCard.tsx`, Vitest interaction tests.

**Acceptance:** the same scripted fixture records before/after board/card
renders, request count, and browser main-thread time; a burst of N log events
causes a bounded number of activity publications and estimate requests while
the final activity/estimate state is never lost; visible heartbeat lag stays
within the documented interval; interaction behavior is unchanged; full gates
and a real live-run browser check pass. If the baseline is immaterial, defer
the relevant sub-change rather than landing speculative memoization.

**Fix risk:** low.

### O23. CostView/AuditView unconditionally refetch on high-frequency events — MEDIUM (efficiency)

**Problem:** `CostView` refetches two endpoints on every `cost.updated` *or*
`task.updated` (`apps/web/src/pages/CostView.tsx:37-45`); `AuditView` refetches
on four event types (`apps/web/src/pages/AuditView.tsx:131-146`). No debounce,
no in-flight dedup — an open Costs/Audit tab streams full-table requests
during a run.

**Fix:** use one small trailing coalescer per view with three states:
`inFlight`, monotonic `requestedGeneration`, and
`completedGeneration`. Events increment the requested generation. If a fetch
is active, schedule exactly one trailing fetch after it settles; never simply
skip an event while in flight, which can lose the final state. Pair with O24's
abort/ownership guard so a stale response cannot win after project/unmount.

**Likely files:** `apps/web/src/pages/CostView.tsx`,
`apps/web/src/pages/AuditView.tsx`, shared debounce hook if useful, tests.

**Acceptance:** deterministic tests cover a burst before a fetch, during an
in-flight fetch, and immediately as it settles; requests are bounded, the last
generation is always fetched, stale responses cannot overwrite it, and UI
freshness lag is ≤ the documented interval; full gates green.

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

**Fix:** keep the latest 1,000 lines in Board state, matching the current
default `taskLogs` response bound. Apply the same trim after initial load and
every streamed append, and show an honest "showing latest 1,000" note once
older lines were omitted. The database remains the durable history; do not add
a virtualization dependency for a list that is now bounded.

**Likely files:** `apps/web/src/pages/Board.tsx`,
`apps/web/src/components/LogPanel.tsx`, tests.

**Acceptance:** initial responses and live bursts retain exactly the newest
1,000 in order, with no boundary duplicate; the omission note is accurate;
task switching cannot mix logs; autoscroll/filtering and O24 cancellation are
unchanged; full gates green.

**Fix risk:** low.

### O26. Web minor robustness/a11y follow-ups — LOW-MEDIUM

These are independently reviewable follow-ups, not a mandatory mixed-purpose
PR. Land each with its owning item where noted:

- **Toast timers never cleared** (`apps/web/src/hooks/useToast.tsx:37-39`):
  track and clear on unmount.
- **Dialog semantics** (pair with O5; `components/TaskDrawer.tsx:116`,
  `components/TokenGate.tsx:44`): add `role="dialog"`, `aria-modal`, Escape
  handling, focus containment, and initial/return focus via the shared dialog
  primitive.
- **LogPanel autoscroll** (pair with O25;
  `components/LogPanel.tsx:40-42`): respect
  `prefers-reduced-motion` and scroll the container explicitly (as
  `PlanView.tsx:265-274` already does).
- **Dead "New Project" button** (`pages/PlanView.tsx:455-465`,
  `onClick={() => {}}`): wire it to the New Project page or remove the
  misleading control.
- **`useWS` project ownership** (pair with O6/O12;
  `hooks/useWS.ts:161-166`): replace the warning-only invariant with a
  reference-counted connection manager keyed by project ID, still sharing one
  socket among same-project subscribers. A dev-only throw would leave
  production silently wrong and is not a fix.

**Acceptance:** timers are cleared; dialog interaction tests cover
Escape/focus containment/return; reduced-motion scrolling is non-animated;
New Project has one real outcome; simultaneous different-project subscribers
receive only their own events while same-project subscribers share one socket;
keyboard walkthrough and full gates green for each owning PR.

**Fix risk:** minimal.

---

## Workstream 4 — Verification depth (tests, CI, lint, docs)

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

**Fix:** first create an explicit `buildApp`/`createApp` seam that accepts
dependencies and returns a Fastify instance without listening, installing
process-global handlers, or starting unowned timers. Keep `main()` as the
small production composition root that builds, starts background services,
listens, and closes them through one lifecycle owner. This is a behavior-
sensitive refactor because `index.ts` currently defines and invokes `main()`;
do not fake `app.inject` around the live singleton.

Then extract the pure path/config/token validators into
`project-validation.ts` and add unit tests plus an injected-route suite for
auth on/off, 401 and loopback behavior, project create/delete refusals, and
O18 validation. Injected apps must close cleanly with no Telegram, scheduler,
backup, pruning, WebSocket, or self-update timer left running.

**Implementation decision (2026-07-29):** keep this as one O27 PR with two
reviewable commits (app/lifecycle seam first, validator extraction and coverage
second). `buildApp` receives the SQLite/engine/hub/self-update dependencies and
an explicit environment snapshot; it only registers plugins, hooks, and
routes. An internal production assembly owns the existing pruning, backup,
scheduler, Telegram, shutdown-handler, listen, and resume-on-boot boundaries,
and `main()` is the only caller that starts them. Importing the app module or
closing an injected app therefore cannot install process handlers or leave a
maintenance timer behind.

The reproduced failure is architectural rather than a new route response:
importing the only server module immediately runs `main()`, so route injection
is impossible without opening the operator database and starting global
lifecycle work. No new durable state, timer, queue, cache, retry, or migration
is introduced. Existing startup ordering and shutdown settlement remain
authoritative, and a child-process start/SIGTERM smoke guards that boundary.
Validator extraction stays in the server layer. Destructive clone cleanup is
tightened to preserve dirty clones and refuse symlinked, non-repository,
wrong-origin, and nested-repository paths; the project row is still removed
and the untouched path is logged for manual cleanup. Concurrent delete
semantics and every external Git/GitHub effect outside that cleanup guard are
unchanged. The smallest rollback is the two O27 commits in reverse order; no
stored data needs conversion. Pre-fix evidence is the absence of any
`app.inject` seam/test plus focused tests that demonstrate the old cleanup
predicate accepts a dirty matching-origin clone.

**Likely files:** `packages/server/src/index.ts`, a small app/lifecycle module,
new `packages/server/src/project-validation.ts`, and focused tests.

**Acceptance:** all listed helpers have success/refusal/error coverage;
delete refusal covers dirty, wrong, non-managed, symlink, and nested-repository
paths; `app.inject` can build/close repeatedly without open handles or
process-handler accumulation; a real `main()` smoke still starts and shuts
down gracefully; extraction preserves route behavior; full gates green.

**Fix risk:** medium; land the app seam separately from validator behavior if
the diff ceases to be easily reviewable.

**Status:** implementation completed in
[#186](https://github.com/IngeniousArtist/hoopedorc/pull/186)
(`5f6e2ee`). `buildApp` now accepts caller-owned DB/engine/hub/self-update
dependencies and an environment snapshot, registers the complete app, and
does not listen, install process handlers, or start maintenance, Telegram,
scheduler, backup, or resume work. The guarded `main()` entrypoint remains the
only production composition root and retains the coordinated shutdown path.
Project/config/token/path validation now lives in
`project-validation.ts`. Disk cleanup additionally refuses dirty,
wrong-origin, unmanaged, symlinked, nested-repository, and unsafe sibling
worktree paths; refusal still removes the project row while preserving every
file for explicit operator cleanup.

The pre-fix matching-origin predicate was replayed against the dirty-clone
regression and failed with `true !== false`; restoring the clean-status proof
made it pass. Sixteen focused O27 checks cover repeated construction/closure,
process-handler counts, auth off/on/401/health bypass and non-loopback startup,
project create/delete success and refusals, validator success/error shapes,
settings redaction, token comparison, log age/count pruning, and a child
process running the real `main()` through listen → SIGTERM → exit 0. Full local
verification passed typecheck, build, lint, engine 184/184, adapters 12/12,
server 236/236, web 25/25, E2E 16/16 at 360/390/768/1280/1440 px, and
`git diff --check`. Linux `build-and-test` CI passed in 2m19s.

The post-merge EC2 update/health smoke remains outstanding: the current
execution environment has no SSH identity, Tailscale CLI, or configured
production endpoint with which to identify the authorized box safely. Run
`scripts/update.sh` from that known production checkout, then record the exact
checkout commit, clean/idle preconditions, matching `hoopedorc.service`
restart, `GET /api/health`, and loopback/Tailscale dashboard results.

### O28. Deterministic fixes for local-only test failures — MEDIUM (testing)

**Problem:** two tests can fail locally while Linux CI stays green:

(a) The known adapters flake in
`packages/adapters/src/managed-process.test.ts:21-60` ("abort terminates a
SIGTERM-resistant parent and its child") infers process death from
`process.kill(pid, 0)` under fixed 2 s wall-clock deadlines (`:5-19,40,56-58`).
`kill(pid, 0)` treats an **unreaped zombie as alive**; on GitHub CI orphans are
reaped promptly, but in a local/sandboxed environment the orphaned
grandchild's PID entry can outlive the deadline even though it was killed.

(b) `packages/engine/src/sandbox.test.ts` creates a certificate below
`tmpdir()` and expects Docker's read-only mount source to equal that lexical
path. On macOS, `tmpdir()` can return `/var/folders/...` while production
`certificateMount()` deliberately uses `realpathSync`, yielding
`/private/var/folders/...`; the mount is correct but the string assertion
fails. This was reproduced on 2026-07-29 by the plan-review gate: 183/184
engine tests passed, and the focused test failed identically; the same commit's
Linux CI was green.

**Fix:** for (a), observe death via fd closure instead of PID-table absence —
have the grandchild hold an inherited pipe and await pipe EOF (or assert a
heartbeat *stops*); remove the fixed wall-clock deadlines and let the runner's
per-test timeout be the only backstop. For (b), assert the canonical
`realpathSync(certificatePath)` mount source while retaining the container
target and read-only assertions. Production code is unchanged.

**Likely files:** `packages/adapters/src/managed-process.test.ts`,
`packages/engine/src/sandbox.test.ts`.

**Acceptance:** the adapters suite passes ≥20 consecutive local runs including
under CPU load; the engine certificate test passes on macOS with a canonical
source and still rejects non-files; both suites pass on Linux CI; no production
changes; full gates green.

**Fix risk:** low (test-only).

**Status:** completed in
[#180](https://github.com/IngeniousArtist/hoopedorc/pull/180)
(`0e9d0e5`). The process-tree test now uses inherited stdout closure as the
descendant-exit proof and asserts the intended SIGKILL escalation; the sandbox
fixture assertion uses its canonical real path. Production code was unchanged.
Local verification passed 20 consecutive adapter-suite runs under one-core CPU
load, typecheck, build, lint, engine 184/184, adapters 12/12, server 211/211,
web 25/25, E2E 16/16, and `git diff --check`. Linux `build-and-test` CI passed
in 2m05s, and the merged commit was independently confirmed as local and
`origin/main` at `0e9d0e52db604c7f5f1d5febb7d0f8d096bfb701`.

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

**Implementation decision (2026-07-29):** keep O29 test-only. Add three
orchestrator fixtures around the existing `syncBranchWithMain` seam: one
conflict followed by a clean retry must author again, open a new PR, and merge
only that new PR; three consecutive conflicts must requeue twice, then request
the reject-only manual-resolution decision and fail without merging; and a
restarted `in_review` task with a persisted current decision plus an existing
worktree must recover the old merge tail, requeue on conflict, remove the
stale worktree, then create a fresh attempt and merge its new PR.

The reproduced risk is an unguarded idempotency path rather than a known live
failure: removing the conflict branch's `prNumber = undefined` must make the
new conflict→clean and restart fixtures fail by reusing the stale PR. The
engine owns the invariant and no production source, durable state, timer,
queue, cache, retry policy, migration, external side effect, or concurrency
outcome changes. The fixtures use deterministic fake Git/worktree boundaries;
crash recovery is represented by constructing a new `Orchestrator` around the
persisted task/decision/worktree shape. The smallest rollback is the O29 test
commit, old data is untouched, and no live EC2 check is required for this
test-only item.

**Status:** completed in
[#190](https://github.com/IngeniousArtist/hoopedorc/pull/190)
(`e6b0d33`). Three deterministic orchestrator regressions now cover
conflict→clean requeue through a fresh worktree/PR, three conflicts reaching
the two-retry cap and reject-only manual resolution, and restart recovery from
a persisted decision plus stale worktree. Deliberately removing
`prNumber = undefined` made all three focused O29 tests fail through stale-PR
reuse; restoring it passed 3/3. No production source changed.

Local verification passed typecheck, build, lint, engine 187/187, adapters
12/12, server 238/238, web 25/25, E2E 16/16 at 360/390/768/1280/1440px, and
`git diff --check`. Linux `build-and-test` CI passed at the reviewed head
`60f23c2` in 2m24s. After merge, local `main` and `origin/main` independently
matched `e6b0d3324aee6fe77f41032d8308d63c212944e9`, and the merged engine suite
passed 187/187. No EC2 check was required because O29 changed only tests and
roadmap evidence.

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

**Status:** completed with O33 in
[#188](https://github.com/IngeniousArtist/hoopedorc/pull/188)
(`fab7175`). The shared verification evidence is recorded under O33.

### O31. ESLint covers only `apps/web` — the backend is unlinted — MEDIUM (maintainability)

**Problem:** the root `lint` script is `npm run lint -w @orc/web` and every
`eslint.config.js` block scopes to `apps/web/**` (`eslint.config.js:6`).
Adapters/engine/server/types — the bulk of the runtime logic — get no
`no-floating-promises`-class checks (exactly the O2 bug class).

**Fix:** extend `eslint.config.js` to backend/types sources with a type-aware
Node configuration and update the root script. Capture the existing violation
baseline by rule/workspace in a checked, reviewable form and make CI fail if
the count increases; warnings with no baseline/ratchet merely accumulate.
Promote safety-critical rules such as unhandled/floating promises to errors in
new or touched code immediately, then pay down the recorded legacy backlog in
small mechanical PRs before turning the rule globally to error. Exclude
generated/build output explicitly.

**Likely files:** `eslint.config.js`, root `package.json`, hoisted
typescript-eslint dev deps, then targeted fixes.

**Acceptance:** `npm run lint` covers all five workspaces; a newly introduced
floating promise fails CI; the checked baseline cannot increase and reaches
zero before global promotion; config/test files receive the correct
Node/browser globals without blanket disables; CI runs the same root command;
full gates green.

**Fix risk:** low-medium (staged rollout controls the blast radius).

**Implementation decision (2026-07-29):** keep O31 to lint policy and its
regression harness; do not mix in production cleanup. After removing one stale
disable for the deleted `ban-types` rule, the measured
`recommendedTypeChecked` backend/types baseline is 341 findings across 14 rule
IDs: adapters 8, engine 210, server 123, and types 0. Store those exact
workspace+rule counts in a reviewed baseline. The root lint runner must fail
when current counts differ in either direction, so a reduction requires the
same PR to lower the checked baseline and cannot leave future regression
headroom. On pull requests it must also compare the checked file with the base
commit and refuse any raised count or new nonzero key.

The initial scan also reported 434 `no-floating-promises` findings, all from
top-level calls to the promise-returning `test` function imported from
`node:test`; production code had zero, and `no-misused-promises` had zero.
Configure the rule's typed `allowForKnownSafeCalls` option for exactly that
package export rather than blanket-disabling tests. Keep real floating and
misused promises at error severity globally, with an executable lint-text
regression proving a newly introduced production float fails. Preserve the
existing web rules, give browser source browser globals, give web tooling/E2E
the required browser+Node globals, and give backend tests/runtime Node globals.
Move shared ESLint tooling ownership to the root because the root configuration
and gate now serve every workspace. No runtime state, migration, API,
persistence, deployment, or external side effect changes; rollback is the O31
lint-policy commit, and no live EC2 check is required.

**Status:** completed in
[#192](https://github.com/IngeniousArtist/hoopedorc/pull/192)
(`beda0db`). The root gate now lints 140 files across all five workspaces with
seven policy regressions, type-aware backend/types rules, scoped
browser/Node/type-only globals, error-level real floating/misused promises, and
an exact 341-finding workspace+rule baseline. Pull-request checkout retains
both parents, and the runner refuses any baseline increase relative to the base
commit. A typed exception covers only the promise-returning `test` export from
`node:test`.

Deliberately adding a production `Promise.resolve` failed
`@typescript-eslint/no-floating-promises`; deliberately raising server
`require-await` from 58 to 59 failed because the current count no longer
matched. Both restored cleanly. Local verification passed typecheck, build,
lint policy 7/7, engine 187/187, adapters 12/12, server 238/238, web 25/25,
E2E 16/16 at 360/390/768/1280/1440px, the original web-workspace lint command,
pull-request-mode lint, and `git diff --check`. The first sandboxed server run
denied three loopback listeners with `EPERM`; the required permissioned rerun
passed 238/238. Linux `build-and-test` CI passed at reviewed head `c01e31e` in
2m19s, including the new root lint step in 14 seconds. After merge, local
`main` and `origin/main` matched
`beda0dbda83eb62a217eb1edbfca4d0d36527b8e`, and merged-main lint again passed
7/7 across 140 files. No EC2 check was required because runtime behavior did
not change.

### O32. CI omissions: `git diff --check`, audit signal, Playwright cache — LOW (testing/efficiency)

**Problem:** `.github/workflows/ci.yml` omits `git diff --check` (a declared
repository gate), has no `npm audit` signal, re-downloads the Playwright
browser every run (`:24`, `~/.cache/ms-playwright` never cached), duplicates
type-package builds between the `typecheck` and `build` steps, and has no
`concurrency` group to cancel superseded PR runs.

**Fix:** add `git diff --check` as a required deterministic gate. Add PR-only
concurrency keyed by workflow+PR/branch with `cancel-in-progress: true`; do not
let a new main run cancel verification of a different merged commit. Cache
Playwright browsers with a key derived from OS plus the lockfile/installed
Playwright version and retain the normal install fallback on a cache miss.

Keep registry-backed `npm audit --audit-level=high` as a scheduled/advisory
security job initially, with its report artifact and a named owner. Registry
availability and mutable advisory data make it a poor deterministic merge
gate. Promote it only after an explicit policy defines lockfile exceptions,
outage behavior, and a reproducible failure decision. O1 remains responsible
for resolving the known high findings.

**Likely files:** `.github/workflows/ci.yml`.

**Acceptance:** CI enforces every deterministic documented gate and a
whitespace error fails it; superseded PR runs cancel while separate main runs
do not; a warm run proves browser cache restoration and a miss still installs;
the audit job publishes a visible high-severity result without making network
failure indistinguishable from vulnerability failure; workflow lint plus full
repository gates green.

**Fix risk:** none/low.

### O33. `docs/CONTRACT.md` is missing 13 of 49 live routes — MEDIUM (docs)

**Problem:** these registered, typed, client-consumed routes have zero
mention in the contract doc: `updateProject`, `deleteProject`,
`planSessionArchives`, `retryTask`, `taskDiff`, `costAnalytics`,
`estimatePlan`, `telegramTest`, `auditLog`, `rollbackTask`, `taskRollback`,
`setupHealth`, `testModels`. The start-of-item exact check found that
`deleteProject` and `setupHealth` had also drifted since the original 11-route
audit. AGENTS.md names CONTRACT.md a source of truth; agents planning changes
to diff/retry/rollback/analytics work from an incomplete contract.

**Fix:** document the 13 endpoints from their shared request/response types.
Add a machine-readable route marker/table row for every `ROUTES` key and test
that exact keys/methods/paths are covered. Do not use a loose substring search
that can pass on prose, examples, or similarly named routes. Pair this with
O30 after O27 provides the app seam.

**Likely files:** `docs/CONTRACT.md`, the O30 test file.

**Acceptance:** every route in `ROUTES` is documented; the coverage test
fails when a route is added undocumented; full gates green.

**Fix risk:** none.

**Implementation decision (2026-07-29):** land O30 and O33 together because
they enforce the same canonical `ROUTES` manifest at its two downstream
boundaries. A focused server test will construct the injected Fastify app and
ask Fastify's route table whether every manifest method/path is registered; a
deliberately changed method/path fixture must be refused by that assertion.
The REST contract table will carry one exact, machine-readable row per
`ROUTES` key, bounded by dedicated markers, and the same test will parse those
rows into key → method/path pairs and compare them exactly with the manifest.
Duplicate keys or signatures are failures; prose, examples, and similarly
named routes cannot satisfy the check.

The reproduced failure is documentation drift: the current exact comparison
reports 36 documented routes against 49 manifest entries and names the 13
missing keys above. The server route-table half currently passes, which
establishes that this PR closes a regression gap rather than changing a live
endpoint. Documenting the rollback pair also exposed that the web used local
response shapes omitted from `api.ts`; this PR names
`RollbackTaskResponse`/`TaskRollbackResponse` in the shared contract and makes
the existing client consume them without changing the runtime payload.

The shared type manifest owns the invariant and the implementation stays in
the shared contract, its server test, the existing web consumer, and
`docs/CONTRACT.md`. No state, timer, queue, cache, retry, migration, external
side effect, crash window, or concurrency outcome is added. The smallest
rollback is this contract-test-and-documentation commit; stored data and
mixed-version startup are unaffected. Focused pre-fix evidence is the 13-key
documentation failure, and the mutation assertion proves a server registration
rename is detected. No live EC2 check is required because deployed behavior is
unchanged.

**Status:** completed with O30 in
[#188](https://github.com/IngeniousArtist/hoopedorc/pull/188)
(`fab7175`). The REST table now has one exact key/method/path row for all 49
`ROUTES` entries, and the server suite enforces both manifest → Fastify
registration and manifest ↔ contract documentation. Mutation fixtures prove a
renamed server path and a newly added undocumented route are both rejected.
The start-of-item documentation test failed with the reproduced 13 missing
keys before the rows were added. The rollback endpoints now expose
`RollbackTaskResponse` and `TaskRollbackResponse` through the shared contract,
and the existing board client consumes those names without changing payloads.

Full local verification passed typecheck, build, lint, engine 184/184,
adapters 12/12, server 238/238, web 25/25, E2E 16/16 at
360/390/768/1280/1440 px, and `git diff --check`. The first full server run
had one unrelated F44 timing miss at 237/238; that test passed immediately in
isolation and the full rerun passed 238/238. Linux `build-and-test` CI passed
in 2m21s. The merged commit was independently confirmed as local and
`origin/main` at `fab7175`, and both O30/O33 focused checks passed again on
that commit. No EC2 smoke is required because runtime and deployment behavior
are unchanged.

---

## Workstream 5 — Structural maintainability and efficiency

These are behavior-sensitive and proceed only after the relevant regression
rails and measurements in the execution sequence below.

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

**Fix:** split this into two decisions/PRs after O29:

1. Extract a pure `escalateOrFail(...)` result helper used by all four sites,
   with no persistence or retry-semantic change. Golden/table tests cover
   every stage, fallback available/exhausted, and status reason.
2. Separately specify retry accounting. Do not move persisted bookkeeping to
   memory: restart recovery must know the attempt budget already consumed.
   Keep `maxAttempts` as the immutable user policy, and add/repurpose an
   explicitly named durable counter for effective attempts/escalations scoped
   to the logical task run. Update it transactionally with the requeue/fallback
   decision and reset it only at the documented new-run boundary. If the
   current schema can express that unambiguously, demonstrate it; otherwise
   add an idempotent migration and focused design note before code.

**Likely files:** the extraction PR stays in
`packages/engine/src/orchestrator.ts` and orchestrator tests. The accounting
PR additionally touches the canonical `Task` contract in
`packages/types/src/domain.ts`, the SQLite schema/migration/repository under
`packages/server/src/db/`, engine/server wiring, the board/task attempt labels,
and `docs/CONTRACT.md`; do not introduce a UI-only counter shape.

**Acceptance:** the extraction PR produces byte-identical persisted
transitions and messages. The accounting PR proves stop/restart at every
fallback boundary resumes with the same remaining budget, concurrent retry
requests cannot double-increment, `maxAttempts` never mutates, and a genuine
new logical run resets only the intended counter; board/API labels distinguish
policy maximum from consumed effective attempts; full gates green for each PR.

**Fix risk:** medium — behavior-sensitive; the test suite is the rail.

### O35. Scheduler busy-poll efficiency — MEDIUM (efficiency; careful)

**Problem:** the dispatch loop re-fetches and rebuilds all task state every
250 ms per active project (`packages/engine/src/orchestrator.ts:753-1046`,
`reconcileTasks` at `:635-658`, idle delay `:1037`) — ~4 full task-table reads
plus map rebuilds per second even when nothing changes. The poll also drives
cooldown/quota re-checks and mid-run task pickup, so it cannot be naively
slowed.

**Fix:** measure steady idle DB reads, CPU, and task-pickup latency with
realistic project/task counts first. If material, replace full reconciliation
polling with a monotonic task-generation value incremented in the same
transaction as every task mutation. The scheduler remembers the last seen
generation and waits on a same-process notification **plus a deadline** for
cooldown/quota/time-based wakeups; after any wake/restart it compares the
persisted generation before reconciling. Never use a boolean dirty flag:
clear-vs-write races lose wakeups. Every task write path, including planning,
retry, recovery, and manual edits, must use the generation-owning repository
helper.

**Likely files:** `packages/engine/src/orchestrator.ts`,
`packages/engine/src/index.ts` (deps), `packages/server/src/engine-runner.ts`
(signal source), tests.

**Acceptance:** before/after results use the same task counts/host; steady
full-table reads materially drop without increasing p95 dispatch latency
beyond the documented bound. Tests cover a write immediately before wait,
during waiter registration, during reconciliation, multiple writes collapsed
to one latest generation, restart, manual dispatch, cooldown, quota, pause,
and drain; no wakeup is lost and time-based deadlines still fire; full gates
green. If baseline CPU/latency is immaterial, defer O35 with evidence and add
no signaling protocol.

**Fix risk:** medium — wake-up semantics are the invariant; do not merge
without the cooldown tests passing untouched.

### O36. Server and engine measured micro-efficiency follow-ups — LOW-MEDIUM

These are independent candidates, not one mixed PR. Re-verify and measure
each, then land it with the owning work:

- **`liveSettings()` re-read per event** — read once per handler invocation
  instead of multiple times (`packages/server/src/engine-runner.ts:514-601,698`);
  keeps per-event freshness (no cross-event caching).
- **WS catch-up snapshot N+1** (pair with O6/O13) — add
  `getRunsForProject(projectId)` (one
  indexed query + group in memory) replacing per-task `getRuns`
  (`packages/server/src/index.ts:2617-2622`), but only after `EXPLAIN` verifies
  the existing run indexes and a counting test reproduces N+1.
- **Settings-save full scan** — replace the projects×tasks warning loop
  (`packages/server/src/index.ts:2406-2420`) with one indexed existence/join
  query if measured at realistic scale.
- **Redundant git diffs per merge decision** — reuse the
  `changedFilesWithStatus` result only when tests prove the compared refs,
  rename/deletion semantics, and timing are identical; otherwise keep the
  separate safety inspection. Never trade destructive-change accuracy for a
  subprocess reduction.

**Acceptance:** each PR contains its own counting/timing baseline and removes
only duplicated work demonstrated by that evidence; settings freshness,
snapshot completeness/order, and destructive-change inspection remain
identical; full gates green. Unmeasured or immaterial candidates are closed as
deferred without code.

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

The workstreams above are ownership groupings. This dependency-aware sequence
is authoritative. Default to one item per PR; combine only the pairs named
below because they share one invariant and would be unsafe to split.

1. **Plan baseline — merged:** the safety revision merged in
   [#177](https://github.com/IngeniousArtist/hoopedorc/pull/177)
   (`a24e637`), and the original-author response merged in
   [#178](https://github.com/IngeniousArtist/hoopedorc/pull/178)
   (`cb226e6`), both with green Linux CI. The 2026-07-29 follow-up local gate
   found and recorded O28(b)'s macOS-only canonical-path assertion. O28 then
   merged in [#180](https://github.com/IngeniousArtist/hoopedorc/pull/180)
   (`0e9d0e5`) with green Linux CI and restored the complete local gate without
   production changes.
2. **Immediate exposure and fatal-path stability — merged:** O1 merged in
   [#182](https://github.com/IngeniousArtist/hoopedorc/pull/182)
   (`d03f0a0`) and O2 merged in
   [#184](https://github.com/IngeniousArtist/hoopedorc/pull/184)
   (`3e4c793`), both with green CI and live EC2/Tailscale verification.
3. **Regression rails before behavior-sensitive work — O27, O29, O30 + O33,
   and O31 merged; O32 is next:**
   - O27 merged in
     [#186](https://github.com/IngeniousArtist/hoopedorc/pull/186)
     (`5f6e2ee`) with the app-construction seam, validator/route refusal
     coverage, and green Linux CI. Its authorized EC2 update/health smoke is
     still outstanding as recorded above.
   - O30 + O33 merged together in
     [#188](https://github.com/IngeniousArtist/hoopedorc/pull/188)
     (`fab7175`) with exact Fastify/manifest/documentation enforcement and
     green Linux CI.
   - O29 merged in
     [#190](https://github.com/IngeniousArtist/hoopedorc/pull/190)
     (`e6b0d33`) with conflict/retry-cap/restart rails and green Linux CI,
     satisfying the prerequisite for O21 and O34.
   - O31 merged in
     [#192](https://github.com/IngeniousArtist/hoopedorc/pull/192)
     (`beda0db`) with an exact all-workspace ESLint ratchet and green Linux CI.
   - O32 is next and remains a separate CI-policy PR with no production
     behavior changes.
4. **Durable correctness and recovery:**
   - O3 planning revision receipts.
   - O4 shared Git serialization.
   - O7 authoritative PR merge confirmation.
   - O13 query/delete migration.
   - O16 abort-aware approval ownership → O14 durable approval/Stop
     transitions → O15 Telegram inbox/outbox. This order gives Telegram a
     durable, idempotent approval consumer to call.
   - O18 route validation (using O27's injection rails).
   - O20 accounting/log persistence.
   - O21 lifecycle cleanup only after O29.
   - O17 and O19 updater hardening, each followed by the required live EC2
     smoke.
5. **Bounded resources and safe UI:**
   - O9 and O11 independently bound process memory.
   - O5 + O26 dialog semantics may share one accessible-confirmation PR.
   - O6 + O12 + O26 WebSocket ownership form one contract/snapshot/
     backpressure PR; partial delivery of that trio would preserve a
     divergence window.
   - O24 request ownership before O23 request coalescing.
   - O25 + O26 reduced-motion log behavior may share one bounded-log PR.
   - O8 starts as a reproduction/evidence PR and changes production only if
     the usage-loss path is demonstrated.
6. **Measured optimization only:** benchmark O10, O22, O35, and each O36
   candidate. Implement only candidates with material evidence. O36's
   WebSocket query candidate is evaluated with O6/O13; its Git candidate
   waits for the relevant engine rails. Record immaterial candidates as
   deferred rather than adding signaling, caching, or memoization machinery.
7. **Structural cleanup:** O34 helper extraction after O29/O21, followed by
   its separate durable-accounting design/PR if still justified.
8. **After every merge:** update the item with status, PR, merge commit, exact
   gate/test counts, and outstanding live evidence. After each numbered wave,
   independently run the complete gate on merged `main`; deploy-affecting
   waves also use `scripts/update.sh` and record `GET /api/health` plus the
   item-specific smoke.

## Per-PR go/no-go review

Before implementation starts, the PR description or roadmap update must answer
all of these:

- What exact failure, unsafe state, or measured bottleneck is reproduced?
- Which layer owns the invariant, and can the fix stay entirely there?
- What new state, timer, queue, cache, retry, or migration is introduced?
  Who owns cleanup, bounds, cancellation, restart recovery, and observability?
- What happens if the process crashes immediately before and after every
  external side effect or durable write?
- Which concurrent calls can race, and what database constraint, generation,
  serializer, or idempotency key selects one outcome?
- What is the smallest safe rollback? Can old data and mixed pre/post-migration
  rows still start?
- Which acceptance test fails before the fix, and which live check cannot be
  represented locally?

Stop or defer an item when the answer requires a broader protocol than the
measured/reproduced problem justifies. A smaller explicit failure is preferable
to a complex path that can silently claim success.

## Definition of done (whole plan)

- All items merged with recorded evidence, or explicitly moved to the
  deferred section with a reason.
- `npm audit` reports zero high-severity vulnerabilities.
- Every repository gate green on `main`, including the new route tests,
  backend lint, the de-flaked adapters suite (20 consecutive local runs), and
  the canonical-path engine sandbox test on macOS and Linux.
- Every performance item has reproducible before/after evidence or an explicit
  no-change deferral; no optimization is accepted on render/CPU/DB assumptions
  alone.
- Feature-parity spot-check on the deployed instance: plan → commit →
  autorun → gates → validate → merge; Telegram approval; rollback; settings
  save; self-update from the UI; dashboard live during a run at phone width.
- No operator data lost: existing projects, tasks, cost history, and settings
  from the pre-optimization database still load and behave identically.
