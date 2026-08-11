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

**Continuation handoff (2026-07-30, written after closing O36):** this note
reconciles plan state for the next implementation session and records
observations from the O36 settings-save and merge-decision work
(#208–#211) that affect upcoming items.

*State.* Merged with recorded status and evidence: O1, O2, O16 + O21, O27
(implementation), O28, O29, O30 + O33, O31, O32, O34 (both PRs), O35, and all
four O36 candidates (live settings #204, WebSocket catch-up #206,
settings-save scan #208, merge-decision diff reuse #210, each with a
follow-up verification record). Not started, per this document's own status
trail: O3, O4, O5, O6, O7, O8, O9, O10, O11, O12, O13, O14, O15, O17, O18,
O19, O20, O22, O23, O24, O25, and O26. The execution order below remains
authoritative: the next item is **O3 planning revision receipts**, then the
rest of wave 4. Waves 3, 6, and 7 completed out of listed order without
harm because their prerequisites (O29 for O21/O34; O6/O13 pairing waived by
measuring the WS candidate against the production snapshot directly) were
individually satisfied; wave 4's internal O16 → O14 → O15 ordering still
holds, with O16 already merged.

*Deployment lag.* The production box last deployed `3e4c793` (O2,
2026-07-29). Everything merged since — O27 through O36 — is undeployed;
each of those items individually required no live smoke, but O27's
authorized EC2 update/health smoke is still recorded as outstanding. Before
or alongside starting O3, run one routine `scripts/update.sh` deploy,
record `GET /api/health` plus the dashboard check, and clear O27's
outstanding evidence in its status entry.

*Observations for upcoming items.*

- **Evidence convention:** each implementation PR carries its measurement
  protocol and result in this document; a separate doc-only follow-up PR
  records the status block with post-merge verification on merged `main`
  (#204/#205, #206/#207, #208/#209, #210/#211). Keep that shape.
- **ESLint ratchet trap (O31):** new `async` test-double methods without an
  `await` trip the engine `require-await` baseline (expected exact count;
  found +11 during #210's first draft). Write fakes as plain methods
  returning `Promise.resolve(...)` — do not raise the baseline.
- **SQLite join planning (relevant to O13):** an unpinned
  `projects INNER JOIN tasks` planned as a full `tasks` scan because the
  WHERE clause filtered only task columns; `CROSS JOIN` pins the join order
  so SQLite searches `idx_tasks_project`. Capture `EXPLAIN QUERY PLAN` on a
  seeded fixture, not an empty database, before trusting a plan.
- **Shared refs across worktrees (relevant to O4):** task worktrees share
  the primary clone's common `.git` refs and config. #210 removed the
  one in-decision double-read, but any two git reads at different pipeline
  stages can still straddle a sibling task's fetch; O4's single
  engine-owned repository lock remains the real serialization fix, and its
  lock key should come from the common Git directory for exactly this
  reason.
- **Author-stage listing is not reusable:** the post-author empty-worktree
  guard (`orchestrator.ts` `executeTask`) intentionally keeps its own
  `changedFiles` subprocess — gates and validation run between it and the
  merge decision, so its timing is not identical. Do not "finish" #210 by
  removing it.
- **Ad-hoc measurement scripts are not committed.** Every O35/O36 protocol
  in this document contains enough detail to regenerate its script; committed
  regression tests carry the load-bearing counting assertions.

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

**Security advisory refresh (reopened 2026-08-11):** a fresh registry audit
after #213 found four new high-severity transitive findings and the previously
accepted low esbuild finding. The full baseline is four high and one low; the
production-only baseline is two high. Production paths contain
`brace-expansion` 5.0.8 through `minimatch`/`glob` and `fast-uri` 3.1.4 through
Fastify's Ajv serializers. Development paths additionally contain `nanoid`
3.3.16 through PostCSS and `undici` 7.28.0 through jsdom. The authoritative
fixed minimums from the registry advisory graph are `brace-expansion` 5.0.9
([`GHSA-rgw5-rvv9-x895`](https://github.com/advisories/GHSA-rgw5-rvv9-x895)),
`fast-uri` 3.1.5
([`GHSA-7p8r-x3mc-p8w7`](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7)),
`nanoid` 3.3.17
([`GHSA-2v37-7h3g-55p8`](https://github.com/advisories/GHSA-2v37-7h3g-55p8)),
and `undici` 7.29.0 (including
[`GHSA-4cwx-7wf7-3272`](https://github.com/advisories/GHSA-4cwx-7wf7-3272)).

The smallest remediation is lockfile-only because every fixed release is
inside its current parent's declared range: resolve `brace-expansion` 5.0.9,
`fast-uri` 3.1.5, the current patched nanoid 3.x release, and `undici` 7.29.0
without adding a direct dependency or override. Inspect the generated lock
diff and refuse unrelated package drift. Keep the low Windows-only esbuild
development-server residual explicit: the installed Vite and tsup lines still
declare the vulnerable 0.27 range, while the fixed release is 0.28.1; do not
force an unsupported transitive major through an override.

**Refresh acceptance:** `npm audit --audit-level=high` and
`npm audit --omit=dev --audit-level=high` both report zero vulnerabilities;
plain `npm audit` reports only the already-documented low esbuild residual;
`npm ls` proves the four patched resolutions with no invalid graph; the
lockfile diff contains no unrelated version changes; the focused real static
server regressions and every repository gate are green. Because the runtime
Fastify graph changes, the next production update must record `GET
/api/health`, dashboard, hashed asset, SPA fallback, API/WS auth/404 behavior,
and traversal confinement through loopback and Tailscale Serve.

**Refresh implementation result (2026-08-11, pre-merge):** the reviewed
lockfile-only update resolves `brace-expansion` 5.0.9, `fast-uri` 3.1.5,
`nanoid` 3.3.18, and `undici` 7.29.0, with no direct dependency, override, or
unrelated package change. Both high-severity audit commands exit successfully;
the production-only audit reports zero vulnerabilities, while the full audit
reports only the accepted low esbuild finding. `npm ls --all` reports a valid
graph. The focused real static-server regression passes 2/2. Full local gates
pass typecheck, build, lint at the unchanged 340-finding baseline, engine
214/214, adapters 12/12, server 255/255, web 26/26, E2E 16/16 at
360/390/768/1280/1440 px, and `git diff --check`. CI, merged-main verification,
and the production smoke above remain outstanding until this branch is merged
and deployed; they must be added without rewriting this pre-merge evidence.

**Refresh status:** completed in
[#214](https://github.com/IngeniousArtist/hoopedorc/pull/214)
(`1b367542`). The hosted `build-and-test` check passed in 2m27s. After merge,
local `main` and `origin/main` were independently confirmed clean and equal at
that commit; `npm ls` confirmed all four patched resolutions, both
high-severity audits exited successfully, the production-only audit reported
zero vulnerabilities, and the full audit reported only the accepted low
esbuild finding. The focused real static-server regression again passed 2/2.
The doc-only status follow-up also passed typecheck, build, lint at the
unchanged 340-finding baseline, engine 214/214, adapters 12/12, server 255/255,
web 26/26, E2E 16/16 at 360/390/768/1280/1440 px, and `git diff --check`. No
production deployment was performed as part of this lockfile refresh, so the
live loopback/Tailscale smoke listed above remains outstanding for the next
production update.

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

**Implementation decision (2026-08-11):** SQLite owns the active revision.
`GET /plan/session` lazily creates and returns one server-generated UUID; the
chat, deconstruct, save-draft, and commit requests must echo it, so a stale tab
cannot write into a later session. The migration backfills only projects with
existing planning scratch or `planning` status, preserving all scratch fields;
an empty project receives its revision on first session read. Successful
finalization clears the active revision together with scratch, while the
immutable receipt remains available for an old response retry.

`planning_commits` uses `(project_id, revision_id)` as its primary key and
stores `pending|successful`, a SHA-256 hash over a versioned canonical
serialization of the effective PRD, every materialized draft field, and the
generated AGENTS guidance, plus created task IDs and the successful public
response. Receipt reservation, exact scratch persistence, and the `planning`
transition share the pre-Git SQLite transaction. Task creation, PRD
publication, scratch/revision clearing, and successful receipt publication
share the final transaction. A matching successful receipt replays without
Git, archive, task, or broadcast effects; a hash mismatch fails closed. One
in-process owner promise lets simultaneous matching requests share the result,
while a pending receipt left by a stopped process remains safely retryable
because the existing Git and archive writes are idempotent. Receipts are
retained rather than pruned because they are the long-lived proof for stale
clients. No production plan is mutated for verification; real Git/archive and
crash boundaries are covered with temporary repositories/files and SQLite
fault injection, followed by the full API checklist and repository gates.

**Implementation result (2026-08-11, pre-merge):** the shared API now carries
the server-issued revision through session reads and every planning mutation.
SQLite owns the active revision and the durable receipt; the web client keeps
the same revision across a lost-response retry, while stale or malformed
revisions fail before model, Git, archive, task, or broadcast effects. Focused
verification passed planning-commit 8/8, repository/migration 27/27,
injected-route/lifecycle 11/11, and PlanView interaction 5/5. Those tests cover
database reopen and exact replay, simultaneous matching requests, changed
content refusal, a legitimate identical-content next iteration, rollback
before Git, the existing failure after push, transactional finalization
failure, legacy scratch migration, and a client retry after a lost HTTP
response. Full local gates pass typecheck, build, lint at the unchanged
340-finding baseline, engine 214/214, adapters 12/12, server 263/263, web
27/27, E2E 16/16 at 360/390/768/1280/1440 px, and `git diff --check`. CI and
merged-main verification remain outstanding until this branch is merged and
must be appended without rewriting this pre-merge evidence. No live production
plan was mutated because every external-effect and crash boundary is exercised
against temporary repositories, archives, and databases.

**Status:** completed in
[#216](https://github.com/IngeniousArtist/hoopedorc/pull/216)
(`6a9c7fc`). The hosted Linux `build-and-test` check passed in 2m16s. After
merge, local `main` and `origin/main` were independently confirmed clean and
equal at that commit; the full server suite passed 263/263 and the web suite
passed 27/27 again from the merged tree. This doc-only status follow-up also
passed typecheck, build, lint at the unchanged 340-finding baseline, engine
214/214, adapters 12/12, server 263/263, web 27/27, E2E 16/16 at
360/390/768/1280/1440 px, and `git diff --check`. No production deployment or
live plan mutation was performed for this persistence-only boundary, so the
repeatable temporary-repository/archive/database evidence above remains the
authoritative external-effect and crash verification.

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

**Implementation decision (2026-08-11):** add one engine-owned repository-lock
primitive whose key is the real path of `git rev-parse --git-common-dir`, so
the primary clone, linked worktrees, and symlinked spellings of either all join
the same queue while unrelated repositories remain independent. A missing
clone uses a canonical target-path bootstrap key only for `ensureClone`; every
existing repository must resolve and validate its common Git directory before
the mutation can enter the queue. Queue links check cancellation before their
callback starts, wait for an already-started managed process to settle, and
delete themselves from the registry when the last waiter settles.

`GitServiceImpl` and `WorktreeManagerImpl` share the module singleton by
default, with narrow constructor injection retained for deterministic lock
tests. Worktree creation holds one lock across fetch, deterministic stale
remote/local branch cleanup, worktree remove/prune/add, and the shared
`info/exclude` write, then releases it before dependency setup. Failed setup or
cancellation reacquires a fresh, non-aborted lock for cleanup. Normal removal
uses the same cleanup routine. Missing worktrees/branches are established by
Git inspection rather than swallowed mutation errors; a real cleanup failure
is returned as a typed error carrying both the triggering failure and cleanup
details, so the persisted task can retry. Real temporary-repository tests will
cover concurrent create/primary-sync/remove sequences, symlink identity,
queued cancellation, cross-repository concurrency, observable cleanup failure,
retry, and registry eviction. No API, persistence, UI, deployment, or live
production behavior changes are required for O4.

**Implementation result (2026-08-11, pre-merge):** the engine now owns one
common-Git-directory-keyed lock shared by Git service and worktree manager
instances. Primary-clone persistence, task commits/pushes/sync, rollback
preparation, deterministic worktree/ref cleanup, creation, removal, and the
shared exclude write serialize per repository; dependency installation remains
outside the lock. Cleanup validates both task and rollback worktree shapes,
uses Git inspection to distinguish absence from failure, surfaces typed retry
details, and is audited by the rollback owner instead of swallowed.

Eight focused O4 tests pass for clone-bootstrap identity,
primary/linked-worktree/symlink identity, queued cancellation,
unrelated-repository concurrency, four concurrent real worktree pipelines
interleaved with primary sync and cleanup, typed cleanup failure/repair/retry,
rollback cleanup, and registry eviction. The full local
gates pass typecheck, build, lint at the unchanged 340-finding baseline, engine
222/222, adapters 12/12, server 264/264, web 27/27, E2E 16/16 at
360/390/768/1280/1440 px, and `git diff --check`. During the full gate, the
existing F44 server test's external nonexistent-GitHub clone was replaced with
its existing injected clone-failure seam; this preserves the tested boundary
while removing DNS/network timing from the gate. CI, merge commit, and
independent merged-main verification remain outstanding and must be appended
without rewriting this pre-merge evidence. No live deployment is required for
this engine-only serialization boundary.

**Status:** completed in
[#218](https://github.com/IngeniousArtist/hoopedorc/pull/218)
(`a1609a5`). The hosted Linux `build-and-test` check passed in 2m09s. After
merge, local `main` and `origin/main` were independently confirmed clean and
equal at that squash commit; the engine suite passed 222/222 and the server
suite passed 264/264 again from the merged tree. This doc-only status follow-up
also passed typecheck, build, lint at the unchanged 340-finding baseline,
engine 222/222, adapters 12/12, server 264/264, web 27/27, E2E 16/16 at
360/390/768/1280/1440 px, and `git diff --check`. No live deployment is
required because O4 changes only the engine's local Git serialization and
cleanup boundary; temporary real repositories remain the authoritative
concurrency and failure-recovery verification.

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

**Implementation decision (2026-08-11):** land O5 with only O26's dialog-
semantics sub-item. Add one dependency-free shared dialog foundation that
uses the platform `<dialog>` top layer and `::backdrop`, while explicitly
owning accessible name/description wiring, initial focus, focus containment
and return, Escape dismissal, and a test-environment fallback. Build the
confirmation controller on that foundation so destructive confirmations
start on Cancel, remain open while an action is pending, reject duplicate
submission, and retain an actionable inline error on failure. Migrate exactly
the eight `window.confirm` call sites without changing their route, payload,
or successful effect; the settings guard must also preserve a pending hash or
tab destination until confirmation. Reuse the same foundation for
`TaskDrawer` and `TokenGate`; the token gate remains intentionally non-
dismissible because an authenticated server has no usable background state.

The existing Setup update and Projects deletion inline confirmations already
satisfy the no-browser-dialog rule and remain out of scope, as do the other
independently owned O26 bullets. No API, WebSocket, database, server, engine,
deployment, or dependency change is needed. Regression coverage must prove
confirm, cancel/Escape, initial/contained/returned focus, one-call behavior
under repeated clicks, and retained failure recovery for stop, stop-all,
rollback, and discard-settings. The real mock-backed browser suite will walk
the modal at 360, 390, 768, 1280, and 1440 px, including keyboard operation,
touch targets, fixed-surface containment, and document overflow. No EC2 check
is required because the changed boundary is entirely browser-local and every
network effect remains covered by the real mock HTTP routes.

**Implementation result (2026-08-11, pre-merge):** the shared `Dialog` uses
the native modal top layer with dimmed `::backdrop`, explicit accessible
name/description wiring, initial focus, top-dialog focus containment, Escape,
scroll locking, and focus return. `useConfirmation` captures one immutable
action, focuses Cancel first, blocks dismissal and repeat submission while
pending, and keeps failures inline and retryable. All eight browser-confirm
call sites now use it, and `TaskDrawer` plus `TokenGate` share the same modal
semantics; source contains zero `window.confirm`, `window.alert`, or `alert(`
occurrences. No route, payload, server behavior, or dependency changed.

The pre-fix Projects interaction reproduced 2/2 failures because Stop exposed
no accessible dialog or retained error. Focused component regressions now
cover forward focus wrapping, Escape/cancel and return focus, pending duplicate
suppression, retained caller input, Stop success/failure, Projects Stop-now,
routed-model removal, TaskDrawer, and TokenGate. The complete web suite passes
35/35. The real Playwright gate passes 18/18 at 360, 390, 768, 1280, and 1440
px, including Settings tab and hash destinations, Stop, Stop-all failure/retry,
nested rollback failure/retry, modal touch targets, fixed-surface containment,
and document overflow. That run caught and closed two browser-only gaps: focus
return racing a trigger re-enable and a confirmation click bubbling into its
task card.

Full local verification passes typecheck, build, lint across 154 files at the
unchanged 338-finding baseline, engine 231/231, adapters 15/15, server 309/309,
web 35/35, E2E 18/18, and `git diff --check`. CI, merge commit, and independent
merged-main verification remain outstanding and must be appended without
rewriting this pre-merge evidence. No EC2 check is required for this entirely
browser-local boundary.

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

**Implementation decision (2026-08-11):** keep O7 inside the engine Git
service. Add one structured PR-state parser and an authoritative probe that
attempts `gh pr view --json state,mergedAt,mergeCommit` at most three times
with bounded abortable backoff. `MERGED` is accepted only when both a merge
timestamp and merge-commit OID are present; `OPEN` continues the existing
mergeability/merge path; `CLOSED` fails immediately; malformed, unknown, or
unavailable state exhausts as an exported typed retryable error. Retain three
merge-command attempts and the existing primary-clone refresh. After each
failed merge command, probe again before deciding whether to retry: confirmed
`MERGED` succeeds, `OPEN` permits another bounded merge attempt, and every
other result fails closed. Inject only the existing `gh` command and delay
boundaries for deterministic regression tests. No API, database, UI,
orchestrator, cleanup-policy, or deployment behavior is in scope.

**Implementation result (2026-08-11, pre-merge):** `mergePr` now requires a
bounded structured state probe before issuing a merge and after every failed
merge command. It accepts restart or ambiguous-command success only for
`MERGED` plus non-empty `mergedAt` and `mergeCommit.oid` evidence; `CLOSED`
fails immediately, `OPEN` alone permits the existing bounded merge path, and
unknown, malformed, missing-evidence, or unavailable state becomes a typed
retryable `PullRequestStateError`. No CLI error string is treated as proof.
The installed `gh` 2.96.0 was checked against merged PR #219 and returned the
exact structured shape used by the probe. The normal three merge attempts,
abortable waits, and best-effort locked primary refresh remain intact.

Seven focused O7 scenarios (nine Node test results including table subtests)
pass for two transient reads before restart recovery, ambiguous command
failure followed by a real remote merge and local refresh, misleading
"already merged" text followed by `OPEN`, `CLOSED`, malformed JSON, exhausted
state access, missing merge evidence, and cancellation during probe backoff.
The full local gates pass typecheck, build, lint at the reduced 339-finding
baseline, engine 231/231, adapters 12/12, server 264/264, web 27/27, E2E 16/16
at 360/390/768/1280/1440 px, and `git diff --check`. CI, merge commit, and
independent merged-main verification remain outstanding and must be appended
without rewriting this pre-merge evidence. No live deployment is required for
this engine-only GitHub confirmation boundary.

**Status:** completed in
[#220](https://github.com/IngeniousArtist/hoopedorc/pull/220)
(`4a4dc63`). The first hosted run exposed that the new remote-merge fixture
implicitly depended on the machine's default Git branch; the fixture was made
portable with an explicit `--branch main`, its focused engine/typecheck/lint
checks passed locally, and the replacement hosted Linux `build-and-test` check
passed in 2m16s. After merge, local `main` and `origin/main` were independently
confirmed clean and equal at that squash commit; the engine suite passed
231/231 and the server suite passed 264/264 again from the merged tree. This
doc-only status follow-up also passed typecheck, build, lint at the reduced
339-finding baseline, engine 231/231, adapters 12/12, server 264/264, web
27/27, E2E 16/16 at 360/390/768/1280/1440 px, and `git diff --check`. No live
deployment is required because O7 changes only the engine's GitHub PR-state
confirmation boundary; the read-only live `gh` shape check and real temporary
Git repositories remain the authoritative integration evidence.

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

### O9. Adapters retain up to 64 MiB of captured output they never read — HIGH on small hosts (efficiency)

**Problem:** `spawnManagedProcess` copies every stdout/stderr chunk into
capture arrays up to one shared `DEFAULT_MAX_OUTPUT_BYTES = 64 MiB` ceiling
(`packages/adapters/src/managed-process.ts:7,135-145`), but all three
streaming adapters parse via their own `onData` and discard the settled
result (`packages/adapters/src/index.ts:149,351,547` —
`void managed.settled.catch(() => {})`). Concurrent chatty
`--output-format stream-json` runs each holding an unnecessary duplicate
multi-MB buffer is a
real OOM path on the 1–2 GB EC2 target
(`deploy/hoopedorc.service:29-30` already worries about this). Secondary: the
64 MiB cap SIGTERM-kills a long legitimate session mid-work with an
undistinguished error.

**Fix:** add `captureOutput?: boolean` (default `true`) to
`ManagedProcessOptions`; when `false`, still count bytes toward
`maxOutputBytes` (keeping the runaway-kill rail) but retain nothing. Pass
`captureOutput: false` from the three streaming adapters (OpenCode already
keeps the only required bounded `stderrTail`). Keep the existing shared byte
ceiling and typed `outputLimitExceeded` result unchanged in this PR; changing
cap policy or adapter result semantics without production-size evidence is a
non-goal.

**Implementation decision (2026-08-11):** keep ownership entirely in the
adapter process boundary. The additive option defaults to capture so every
`execManagedProcess` caller remains byte-for-byte compatible. With capture
disabled, the same stdout/stderr listeners and one shared counter remain
active, but chunks are not copied into the settled result. No API, persistence,
timer, queue, retry, CLI flag, parser, or process-termination behavior changes.
Concurrent stdout/stderr callbacks remain serialized by the Node event loop
and share the existing cap counter. Rollback is the option, its three explicit
call-site values, tests, and this documentation. A real Node child process is
the process-boundary acceptance fixture; no authenticated model or deployment
smoke is required because O9 changes neither external CLI arguments nor host
configuration.

Pre-fix evidence is a child that streams stdout and stderr while requesting
non-retention: the option does not exist, so its settled result retains both
streams. A second noisy-child case proves the non-retaining path must still
count both streams and terminate at the existing cap. The default-capture
case guards engine/Git/gate callers that consume settled stdout/stderr.

**Likely files:** `packages/adapters/src/managed-process.ts`,
`packages/adapters/src/index.ts`, adapter tests. `execManagedProcess` callers
(engine git/gh/gates) keep the default and are untouched.

**Acceptance:** tests prove stdout/stderr still reach streaming listeners but
the settled result retains neither with `captureOutput: false`; combined
byte-counting/kill still triggers at the existing shared cap and settles the
whole process group; default-capture callers still receive both streams; all
three streaming adapters opt out explicitly; full gates green.

The two pre-fix non-retention regressions failed because both settled results
still contained captured output; the default-capture guard passed. With the
additive option and three explicit streaming call sites, the complete adapter
suite passes 15/15, including a real SIGTERM-resistant parent/child group that
settles through the existing shared output cap. Full local verification passes
typecheck, build, lint (150 files; the exact 338 legacy findings still match
the non-increasing baseline), engine 231/231, adapters 15/15, server 305/305,
web 28/28, E2E 16/16 at 360/390/768/1280/1440 px, and `git diff --check`.
The socket-restricted sandbox initially refused the server suite's three
loopback listeners with `EPERM`; the exact server gate rerun outside that
restriction passed all 305 tests.

**Status:** completed in
[#236](https://github.com/IngeniousArtist/hoopedorc/pull/236)
(`fbcdc00`). Claude, OpenCode, and Codex now stream through the existing
listeners and shared byte ceiling without retaining a second settled-output
copy. Default capture remains unchanged for engine, Git, gate, planner, and
other exec-style callers. Linux `build-and-test` CI passed at reviewed head
`582fa08` in 2m15s. After merge, clean local `main` and `origin/main` matched
`fbcdc00c25fdfdf42b811a8ba6f1f5a432ef57c5`, and the complete adapter suite
passed 15/15 again on that exact commit, including non-retention, default
capture, shared-cap, and resistant process-group settlement.

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

**Implementation decision (2026-08-11):** a read-only measurement on the
authorized `ubuntu@hooped` deployment emitted byte counts only. Across its
stored production evidence, the largest archived assistant reply was 726
bytes, the largest deconstructed-plan section was 3,883 bytes, the largest
complete planning-session archive was 6,243 bytes, and the committed PRD was
3,008 bytes. No active deconstruction draft remained in SQLite. Choose a 4
MiB inclusive planner-output limit: it is more than 670 times the largest
whole stored session and more than 1,000 times the deconstructed section,
while bounding one captured CLI channel to under one percent of the service
unit's documented optional 512 MiB memory cap. Codex's JSONL stdout and final
message file are separate channels and each receives the same bound.

Keep ownership in `planner.ts`. Every chat, legacy-plan, first deconstruction,
and JSON-repair invocation receives the same fixed limit. Because the shared
managed-process rail terminates when its internal threshold is reached, pass
one guard byte beyond the public limit so exactly 4 MiB succeeds and the first
byte over terminates. Before reading Codex's separately written final-message
file, check its byte size and refuse an oversized file without loading it.
Normalize both process-output and Codex-file violations to one exported
`PlannerOutputLimitError` whose message names the runner and 4 MiB limit; the
existing invocation ledger records one failed terminal and the route returns
an actionable 502 instead of entering JSON repair. A parse-triggered retry
gets a fresh identical cap and cannot bypass the bound.

No API shape, persistence, timer, queue, cache, retry count, model routing,
CLI argument, or output parser changes. Concurrent requests own independent
bounded processes; cancellation and the existing process-group SIGTERM →
SIGKILL settlement remain authoritative. Rollback is the fixed limit, typed
normalization, Codex pre-read check, tests, and this documentation. Real fake
CLI processes cover all three runner boundaries without spending an
authenticated model call; no deployment change is required.

**Likely files:** `packages/server/src/planner.ts`, planner tests.

**Acceptance:** the chosen byte value and observed maximum are recorded in the
PR; exact-boundary, one-byte-over, multibyte, normal-plan, and retry cases are
tested across the process-output and Codex-file paths; cap termination settles
the whole process group, records one failed invocation, and reports the runner
plus 4 MiB limit; normal plans are unaffected; full gates green.

Pre-fix, the exact 4 MiB multibyte response completed normally, while three
regressions failed: a one-byte-over Claude response survived until its
resistant process group exited naturally, Codex loaded and returned a
4-MiB-plus-one final-message file, and a JSON-repair retry accepted an
oversized result. With the fixed bound, the focused planner file passes 45/45,
including all four O11 cases. Full local verification passes typecheck, build,
lint (150 files; the exact 338 legacy findings still match the non-increasing
baseline), engine 231/231, adapters 15/15, server 309/309, web 28/28, E2E
16/16 at 360/390/768/1280/1440 px, and `git diff --check`.

**Status:** completed in
[#238](https://github.com/IngeniousArtist/hoopedorc/pull/238)
(`abdd8a9`). Planner chat, legacy planning, deconstruction, and repair retries
now share the measured 4 MiB inclusive bound; Codex checks its separate final
message before reading, and every violation reaches one typed, actionable
failure after process-group settlement. Linux `build-and-test` CI passed at
reviewed head `c9c2964` in 2m06s. After merge, clean local `main` and
`origin/main` matched `abdd8a94b00dd3bb02e62ab6de304fc36d897659`, and the
complete planner file passed 45/45 again on that exact commit.

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

**Implementation decision (2026-08-11):** keep O13 additive and repository-
owned. A representative in-memory measurement with 20,000 model invocations,
10,000 merge decisions, and 20,000 notifications confirmed full scans plus
temporary ORDER BY B-trees for every uncovered query; the existing
`(model, started_at)` index already served model-month cost. Add only the
seven indexes whose after-plans select them:
`model_invocations(started_at)`, `merge_decisions(task_id, ts DESC)`, global,
project, and task notification chronology, plus global and project partial
pending-approval chronology. Put the same `IF NOT EXISTS` definitions in the
fresh schema and an explicit idempotent migration for existing databases.
Delete logs directly by `project_id` and delete only
`budget_alerts.scope = 'project:' || project_id` inside the existing project
transaction. Preserve every other project's rows and all invocation history.
No REST, WebSocket, UI, engine, deployment, or retention behavior changes.

**Implementation result (2026-08-11, pre-merge):** fresh schema and the
existing-database migration now install the seven measured indexes
idempotently. At 20,000 invocation, 10,000 merge-decision, and 20,000
notification rows, global month cost changed from a table scan to
`idx_model_invocations_started`; model-month cost retained the existing
`idx_model_invocations_model_started`; merge history changed from scan plus
temporary sort to `idx_merge_decisions_task_ts`; global/project newest and
pending UNION branches selected their respective full/partial chronology
indexes; and task capability lookup selected
`idx_notifications_task_created`. A second file-backed database boot is a
no-op, while an independently initialized fresh database exposes the same
index names.

Project deletion now removes logs directly by `project_id`, including empty
or stale task IDs, and removes only the exact `project:<id>` budget-alert
scope in the same transaction. Regression coverage proves other-project logs,
other-project alerts, and global alerts survive. The full local gates pass
typecheck, build, lint at the unchanged 339-finding baseline, engine 231/231,
adapters 12/12, server 267/267, web 27/27, E2E 16/16 at
360/390/768/1280/1440 px, and `git diff --check`. CI, merge commit, and
independent merged-main verification remain outstanding and must be appended
without rewriting this pre-merge evidence. No live deployment is required;
the real file-backed migration/reopen and representative planner evidence
exercise O13's SQLite boundary.

**Status:** completed in
[#222](https://github.com/IngeniousArtist/hoopedorc/pull/222)
(`769e5d2`). Linux `build-and-test` CI passed in 2m10s. After merge, local
`main` and `origin/main` independently matched the squash commit, the engine
suite passed 231/231, and the server suite passed 267/267. The docs-only
evidence branch also passed typecheck, build, lint at the unchanged
339-finding baseline, engine 231/231, adapters 12/12, server 267/267, web
27/27, E2E 16/16 at 360/390/768/1280/1440 px, and `git diff --check`. Its CI
and merge commit remain outstanding and will be recorded by the PR itself
without altering the implementation evidence above.

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

**Implementation decision (2026-08-11):** model approval delivery explicitly
on the notification row as `pending` → `recorded` → `applied`, with distinct
`cancelled` and `expired_no_owner` terminals plus recorded/applied timestamps.
An approval identity derived from its project, task, title, message, and
options is unique only while `pending` or `recorded`: restart recovery reuses
that exact row and choice, while a genuinely later identical prompt may create
a new row after the earlier delivery is terminal. Legacy pending rows have no
recoverable owner identity and migrate once to `expired_restart`; new pending
and recorded rows are never swept merely because the process restarted.

The HTTP and Telegram paths first conditionally record the choice and audit in
one SQLite transaction. Only the winner may call the in-memory resolver; a
resolver-side persistence error keeps both the durable choice and waiter
retryable. Successful delivery is marked `applied` afterward. A recorded row
with a recoverable active task or rollback remains queued for the re-armed
waiter; an actually ownerless row transitions transactionally to
`expired_no_owner` and is never described as applied. Recovery registers the
waiter before replaying a recorded choice. Git merge replay continues through
the existing idempotent PR-state confirmation path, so the crash between
delivery and its applied marker cannot create a second merge effect.

For Stop, persist a conditional `stop_requested_at` intent before asking the
orchestrator to cancel. After cancellation is accepted, one repository
transaction conditionally blocks the still-active task, terminalizes its
running run, clears the intent, and writes the audit; only rows read after
commit are broadcast. If the process exits anywhere after the intent, boot
recovery performs that same transaction before project resume, so orphan
recovery cannot requeue work the operator killed. A refused cancellation
clears the intent without changing task/run/audit state. Tests will inject
SQLite failures into the approval audit, Stop audit, and applied-marker
boundaries; simulate both approval crash windows, same/different-choice races,
legacy migration, Stop interruption/recovery, and committed-only broadcasts.
No SQLite transaction crosses a resolver, process cancellation, Git call, or
WebSocket/Telegram send. The REST notification response exposes delivery
state through the shared contract; no deployment or live external-service
check is required because the change is exercised through file-backed SQLite,
real route injection, and deterministic engine restart boundaries.

**Implementation result (2026-08-11):** the notification contract now exposes
`approvalDelivery`, `responseRecordedAt`, and `responseAppliedAt`, backed by an
idempotent existing-database migration and a partial unique live-approval
identity. Normal and rollback waiters reuse pending/recorded rows, register
before replay, and mark only the exact recorded choice applied after delivery.
HTTP returns 202 for a durable choice queued ahead of owner recovery; the web
UI distinguishes queued and ownerless responses from applied ones. Recorded
rows are excluded from retention pruning. Stop now claims
`stop_requested_at`, crosses cancellation, and commits task/run/audit/intent in
one transaction; boot settles interrupted intents before engine resume.

Thirteen focused O14 regressions cover record-before-delivery and
delivery-before-applied restarts, same-row rollback recovery, different-choice
channel races, queued HTTP semantics, legacy migration/reopen, retention, and
faults in approval audit, applied marker, ownerless-expiry audit, and Stop
audit. The existing O7 merged-PR confirmation suite remains the engine-side
idempotency proof for replay at the Git boundary. Full local gates pass
typecheck, build, lint with the baseline reduced from 339 to 338 findings,
engine 231/231, adapters 12/12, server 279/279, web 28/28, E2E 16/16 at
360/390/768/1280/1440 px, and `git diff --check`. CI, merge commit, and
independent merged-main verification remain outstanding and must be appended
without rewriting this pre-merge evidence. No live deployment is required for
these deterministic SQLite, route-injection, engine-restart, and browser
boundaries.

**Status:** completed in
[#224](https://github.com/IngeniousArtist/hoopedorc/pull/224)
(`ef8e888`). Linux `build-and-test` CI passed in 2m13s. After merge, local
`main` and `origin/main` independently matched the squash commit, the engine
suite passed 231/231, and the server suite passed 279/279. The docs-only
evidence branch also passed typecheck, build, lint at the 338-finding
baseline, engine 231/231, adapters 12/12, server 279/279, web 28/28, E2E
16/16 at 360/390/768/1280/1440 px, and `git diff --check`. Its CI and merge
commit remain outstanding and will be recorded by the PR itself without
altering the implementation evidence above.

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

**Implementation decision (2026-08-11):** add three SQLite-owned surfaces.
`telegram_updates` is the inbox keyed by Telegram `update_id`, preserving the
normalized command/callback identity, full JSON payload, and
`claimed`/`processing`/`processed` timestamps. `telegram_actions` is the
pending-action outbox keyed one-to-one to a mutating update, with a stable
`telegram:<update_id>` idempotency key, classified action kind/payload,
`pending` → `effect_committed` → `completed` state, and a durable result.
`telegram_poll_state` stores the next offset. The first observed update anchors
an empty database; thereafter the offset advances only while the exact next
row is processed, never across an absent or unfinished id. Startup resets
abandoned `processing` claims, drains every unfinished row in update order,
then polls from the persisted offset. A conditional claimed → processing
update makes two loops single-winner.

The bot will classify every authorized mutation before invoking a handler:
approval callbacks, project Start/Pause callbacks, Stop-all confirmation,
`/start`, `/pause`, `/retry`, `/autonomous`, and `/digest`. Read-only commands
and unauthorized/no-op updates still use the durable inbox but need no domain
action. Handlers receive only the server-derived idempotency key. Database
policy/task/project intent and the action's `effect_committed` marker commit
together. Start commits desired `running` state before engine reconciliation;
Pause and Stop-all commit desired `paused` state before cancellation; Retry
reuses O34's conditional reset/dispatch request. On replay, the stored effect
decides whether the engine merely needs reconciliation, so a completed run is
not started again. O14 makes approval replay single-use. No client-supplied
idempotency key, filesystem path, or host command crosses this boundary;
command arguments and project references remain untrusted lookup inputs.

Inbox/action completion and contiguous-offset advancement share one final
transaction after the handler returns. A crash before that transaction
re-enters the outbox with the same idempotency key; a crash after it is skipped.
Completed rows strictly below the high-water offset are retained for 30 days,
then pruned with actions first while `telegram_poll_state` remains permanent.
Telegram replies use bounded retry and may repeat around a crash because Bot
API message sends expose no idempotency key; the exactly-once guarantee is for
Hoopedorc domain effects. Telegram starts after engine/project recovery so
pending action reconciliation sees the single restored runtime owner. Tests
will inject crashes at claim, processing, effect, completion, and offset
boundaries; cover gaps, two-loop ownership, all mutating classifications,
restart reconciliation, legacy/fresh migration, and retention. No live
Telegram token is required because the real SQLite state machine and raw Bot
API transport boundary are exercised with deterministic HTTP fakes.

**Implementation result (2026-08-11, pre-merge):** fresh and existing
databases now install the idempotent `telegram_updates`, `telegram_actions`,
and `telegram_poll_state` schema. The bot claims and conditionally owns every
update before invoking a handler, completes the inbox/action/contiguous offset
in one transaction, retries the oldest failure without claiming newer work,
and drains abandoned rows before its first post-recovery poll. Completed rows
strictly below the permanent high-water mark are pruned after 30 days.

The classifier gives approval, Stop-all confirmation, project Start/Pause,
`/start`, `/pause`, `/retry`, `/autonomous`, and `/digest` one server-derived
action key. Project desired state, Retry generation/dispatch intent, settings,
Stop audits, and each action result commit transactionally; O14 remains the
approval-side single-winner boundary. Engine reconciliation runs only while
the stored desired state still applies, so a Start replay cannot revive an
already-completed run or override a later state. Synchronously refused Start
restores the prior project status and persists the refusal atomically.
Telegram configuration now begins only after rollback, project, and queued
task recovery have re-established runtime ownership.

Sixteen focused O15 regressions cover failure before claim, abandoned claims,
effect-before-completion replay, transactional rollback immediately before
offset advance, out-of-order gaps, two-owner contention, migration/reopen,
retention, startup drain ordering, every mutating classification, completed
Start replay, refused Start, Pause, Retry, Stop-all confirmation, and both
settings writes. The existing O14 race/recovery suite remains the approval
single-use proof. Full local gates pass typecheck, build, lint at the unchanged
338-finding baseline, engine 231/231, adapters 12/12, server 295/295, web
28/28, E2E 16/16 at 360/390/768/1280/1440 px, and `git diff --check`. CI,
merge commit, and independent merged-main verification remain outstanding and
must be appended without rewriting this pre-merge evidence. No live Telegram
token is required; file-backed SQLite and deterministic raw Bot API fakes
exercise the changed persistence and transport boundaries.

**Status:** completed in
[#226](https://github.com/IngeniousArtist/hoopedorc/pull/226)
(`db50bc8`). Linux `build-and-test` CI passed in 2m18s. After merge, local
`main` and `origin/main` independently matched the squash commit, the engine
suite passed 231/231, and the server suite passed 295/295. The docs-only
evidence branch also passed typecheck, build, lint at the unchanged
338-finding baseline, engine 231/231, adapters 12/12, server 295/295, web
28/28, E2E 16/16 at 360/390/768/1280/1440 px, and `git diff --check`. Its CI
and merge commit remain outstanding and will be recorded by the PR itself
without altering the implementation evidence above.

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

**Implementation decision (2026-07-29):** land O16 with O21 because O21's
hard-Stop settlement boundary cannot await an unabortable approval promise.
Add the existing task controller's `AbortSignal` to `EngineEvents.requestApproval`
and every normal/recovery approval call. `EngineRunner` owns resolver cleanup:
on abort it conditionally stamps the still-pending notification
`cancelled_stop`, broadcasts and audits that transition, removes the resolver,
and rejects with `AbortError`; a concurrent human response wins only if it
already removed the resolver. No table or payload migration is needed because
`responded_with` already stores terminal strings and the existing response
route already returns 410 when no live resolver exists. Graceful drain does
not abort the controller, so its approval promise and notification remain
unchanged. The rollback approval implementation is behaviorally unchanged and
serves as the wiring model. Engine and server tests must cover Stop, drain,
late response, persisted notification state, and resolver cleanup.

**Fix risk:** low-medium (must respect the pause-vs-stop semantic split).

**Status:** completed with O21 in
[#196](https://github.com/IngeniousArtist/hoopedorc/pull/196)
(`59c8c7d`). Every normal and restart-recovery approval receives the task
controller signal. Hard Stop now removes the resolver, conditionally persists
and broadcasts `cancelled_stop`, writes its audit entry, rejects the waiter
with `AbortError`, settles the owned pipeline, and leaves no path for a late
answer to resume a merge; the HTTP route returns an explicit 410 without
overwriting cancellation. The conditional SQLite update proves Stop and a
human answer are single-winner. Graceful drain keeps the signal live and
applies its answer normally, and the unchanged rollback-approval tests remain
green.

Full local verification passed typecheck, build, lint (including a downward
engine `require-await` ratchet from 194 to 193), engine 194/194, adapters
12/12, server 241/241, web 25/25, E2E 16/16 at
360/390/768/1280/1440 px, and `git diff --check`. Linux `build-and-test` CI
passed in 2m18s. On merged `59c8c7d`, the shared O16/O21/O29 engine checks
passed 9/9 and the focused server O16 checks passed 3/3. No EC2 smoke is
required because this changes deterministic in-process lifecycle state, not
deployment or host behavior.

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

**Implementation decision (2026-08-11):** keep expiry a pure persisted-state
policy inside `normalizePersistedStatus`; normal status reads continue to use
no updater-unit probe. An explicit deadline table gives `queued` and
`checking` five minutes and `pulling`, `installing`, `building`, and
`restarting` two hours. The deadline is measured from the last valid
`updatedAt`; an exact boundary remains active, one millisecond beyond becomes
`failed`, and a future progress timestamp remains active rather than risking a
second updater during wall-clock rollback. Expiry preserves the original
fields, records `updatedAt`/`finishedAt`, and names the expired state and
deadline in its durable failure message. The existing new-boot proof for a
`restarting` marker remains higher priority than same-process staleness.

One table-driven test covers both sides of all six deadlines without host
commands; another proves future-clock safety plus failed-state survival across
server reconstruction and a successful retry launch. No API, schema, timer,
command, or systemd behavior changes. Rollback is the focused server/test/docs
commit. After merge, deploy through the canonical updater and record real
phase timestamps plus recovery from a deliberately stale early-state fixture.

Pre-fix, both focused O17 regressions failed: an early `queued` marker remained
active one millisecond past five minutes, including after server
reconstruction. With the implementation, the focused suite passes 2/2. Full
local verification passes typecheck, build, lint (150 files; the 338 legacy
findings exactly match the non-increasing baseline), engine 231/231, adapters
12/12, server 300/300, web 28/28, E2E 16/16 at
360/390/768/1280/1440 px, and `git diff --check`. The live EC2 smoke remains a
post-merge requirement so it exercises the canonical deployed updater rather
than an unmerged checkout.

**Fix risk:** low.

**Status:** implementation completed in
[#232](https://github.com/IngeniousArtist/hoopedorc/pull/232)
(`9c6fa8e`). Persisted `queued` and `checking` states now expire after five
minutes while `pulling`, `installing`, `building`, and `restarting` retain the
two-hour deadline. Expiry durably records a retryable failure that names the
last state and deadline; exact-boundary, future-clock, restart, and retry
behavior are covered without adding a normal-status systemd probe.

Pre-fix, both focused O17 regressions failed because a stale `queued` marker
remained active. The implementation passed the focused checks 2/2 and every
local repository gate: typecheck, build, lint (150 files with the exact 338
legacy-finding baseline), engine 231/231, adapters 12/12, server 300/300, web
28/28, E2E 16/16 at 360/390/768/1280/1440 px, and `git diff --check`. Linux
`build-and-test` CI passed at reviewed head `10c2672` in 2m34s. After merge,
local `main` and `origin/main` matched
`9c6fa8e9e203afa409072dbaa59f2ea5349765f3`, and the focused O17 checks passed
2/2 again on that exact commit.

Live EC2 acceptance passed on `ubuntu@hooped` on 2026-08-11. The clean, idle
`/opt/hoopedorc` checkout updated through the fixed UI endpoint from
`3e4c793` to `21254e4`: checking/pull began at 08:29:50 UTC, install at
08:29:52, build at 08:30:00, and restart/success at 08:30:11. A backed-up
`queued` fixture last updated at 08:21:02 normalized at 08:31:15 to an
unblocked durable `failed` result naming `queued` and the five-minute
deadline. Its canonical retry entered checking at 08:31:30, was observed
building at 08:31:39, and succeeded at 08:31:49 with `fromCommit` and
`toCommit` both `21254e4`. The final checkout was clean on `main`, the exact
service was active, loopback health and the Tailscale health/dashboard routes
returned HTTP 200, and the temporary fixture backup was removed.

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

**Implementation decision (2026-08-11):** enforce the existing string-array
fields with one focused parser at the two owning Fastify route boundaries.
This is explicit rather than an Ajv array schema because Fastify's default
scalar-to-array coercion would accept the malformed payload this item must
refuse. Keep unknown properties accepted and retain the handlers' existing
semantic checks and error responses; the guard only rejects a non-object body
or `dependsOn`, `acceptanceCriteria`, and `scopePaths` values that are not
arrays containing only strings. This prevents malformed JSON from reaching
`.find()`, SQLite JSON serialization, or task broadcasts without narrowing any
valid web payload. Injected-route regressions cover each array field on both
owning routes where applicable, useful field-specific 400 errors, and valid
full-shape create/update requests. There is no API path, response, persistence,
timer, retry, or deployment change, so rollback is the single server/test/docs
commit and no live-system smoke is required.

Pre-fix, the focused injected-route regression failed on the first malformed
`dependsOn` payload with `500 !== 400`; after the guard it passed 1/1. Full
local verification passed typecheck, build, lint across 150 files with the
unchanged 338-finding baseline, engine 231/231, adapters 12/12, server 296/296,
web 28/28, E2E 16/16 at 360/390/768/1280/1440 px, and `git diff --check`.
CI, merge commit, and independent merged-main verification remain outstanding
and must be appended without rewriting this pre-merge evidence.

**Status:** completed in
[#228](https://github.com/IngeniousArtist/hoopedorc/pull/228)
(`ec34068`). Linux `build-and-test` CI passed in 1m59s. After merge, clean
local `main` and `origin/main` independently matched the squash commit and the
focused O18 injected-route regression passed 1/1. No live EC2 check is required
because this change only enforces the existing HTTP request contract before
in-process persistence and does not alter deployment or host behavior.

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
logged; the non-interactive UI path still fails closed when the server is
genuinely unreachable, while the interactive recovery path retains its
existing explicit warning and build/restart fallback; live EC2 UI-update smoke
recorded.

**Implementation decision (2026-08-11):** add one dependency-free executable
boundary under `scripts/` that imports the already-installed `dotenv` parser,
accepts only the fixed `PORT` or `API_TOKEN` key, and emits that single value
followed by a NUL delimiter. `update.sh` reads the delimiter without `source`,
`eval`, generated shell, or token-bearing arguments; absence of the delimiter
means the helper itself failed and the update refuses before contacting the
server. Dotenv's non-executing parse result supplies quoted/export-prefixed
values and leaves command-substitution-looking text literal. Missing,
malformed, or empty named entries normalize to an empty value, preserving the
default port and unauthenticated-probe behavior; a real 401/malformed response
continues to fail closed on the UI path.

Direct helper tests cover the complete syntax matrix, the fixed-key allowlist,
literal command-looking input, and credential-free errors. An updater-level
regression proves the parsed port and token reach the existing curl probe
without appearing in stdout/stderr, plus unreachable behavior for both the
non-interactive UI path and the intentionally recoverable interactive path.
No API, schema, service, or second updater path is introduced. Rollback is the
helper/script/test/docs commit; after merge, exercise the canonical UI update
against the deployed host's real `.env` and record its phase/health evidence.

Pre-fix, the focused quoted/export-prefixed updater regression failed because
the project response could not prove every project was idle; the fake server
had received the default port and quoted token instead of the configured
values. With the helper, the focused O19 suite passes 5/5 and the complete
updater-script suite passes 11/11. Full local verification passes typecheck,
build, lint (150 files; the 338 legacy findings exactly match the
non-increasing baseline), engine 231/231, adapters 12/12, server 305/305, web
28/28, E2E 16/16 at 360/390/768/1280/1440 px, and `git diff --check`. CI,
merge, independent merged-main verification, and the live EC2 update using
the new parser remain to be recorded.

**Status:** completed in
[#234](https://github.com/IngeniousArtist/hoopedorc/pull/234)
(`992ea6d`). The fixed-key Node helper uses the installed dotenv parser and a
NUL-delimited handoff; the canonical updater no longer interprets `.env` with
`grep|cut`, never evaluates its content, and keeps credential values out of
diagnostics. Linux `build-and-test` CI passed at reviewed head `c9fb32d` in
2m24s. After merge, clean local `main` and `origin/main` matched
`992ea6d6b04fe22831b0cedd612044d7caed2574`, and the focused O19 checks passed
5/5 again on that exact commit.

Live EC2 acceptance passed on `ubuntu@hooped`. The first fixed UI update
deployed `21254e4` to `992ea6d` from 08:40:45 to 08:41:05 UTC. On the deployed
commit, the new helper read the real `.env`'s `PORT` and `API_TOKEN` as present
without emitting either value. A second UI update then exercised the new
parser inside the canonical updater: checking/pull/install began at 08:41:43,
building at 08:41:51, and restart/success at 08:42:02 with `fromCommit` and
`toCommit` both `992ea6d`. It remained available and unblocked, the checkout
was clean on `main`, `hoopedorc.service` was active, and Tailscale health and
dashboard requests both returned HTTP 200.

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

**Implementation decision (2026-08-11):** keep log buffering in memory and
make its failure mode explicit and bounded: retain the latest 1,000 unsaved
lines, retry a failed SQLite batch after five seconds, and rate-limit the
credential-free stderr/reporter signal to once per minute. The one timer is
always `unref()`ed; a hard threshold may flush a healthy queue immediately,
but new lines cannot bypass a scheduled failure retry and hammer SQLite.
Shutdown clears the timer and makes one final synchronous attempt without
arming work past database close. This does not add a second durable log spool;
the existing SQLite table remains authoritative.

Move only the completed accounting callback outside `runPlannerJson`'s model
execution catch. Any sink exception is normalized to `InvocationLedgerError`,
the completed event is attempted once with the real usage, and the owning
planner exits without a repair/model retry or a fabricated failed/$0 terminal.
Actual model execution failures retain their one failed terminal callback.
Regression tests use a failing SQLite trigger and a real fake CLI, covering
rate limiting, the 1,000-line cap, recovery, timer settlement, one process
execution, one completed callback, and typed propagation. No API, WebSocket,
schema, migration, or deployment behavior changes; rollback is the focused
server/test/docs commit and no live-system smoke is required.

Pre-fix, the focused O20 regressions failed because the flush timer remained
referenced (`true !== false`) and the completed-sink exception was not an
`InvocationLedgerError`; after implementation both passed 2/2. Full local
verification passed typecheck, build, lint across 150 files with the unchanged
338-finding baseline, engine 231/231, adapters 12/12, server 298/298, web
28/28, E2E 16/16 at 360/390/768/1280/1440 px, and `git diff --check`. CI,
merge commit, and independent merged-main verification remain outstanding and
must be appended without rewriting this pre-merge evidence.

**Status:** completed in
[#230](https://github.com/IngeniousArtist/hoopedorc/pull/230)
(`b0e9357`). Linux `build-and-test` CI passed in 2m23s. After merge, clean
local `main` and `origin/main` independently matched the squash commit and the
focused O20 log-retry plus planner-accounting regressions passed 2/2. No live
EC2 check is required because this changes in-process buffering and accounting
failure classification without changing deployment or host behavior.

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

**Implementation decision (2026-07-29):** O29 is complete, and O16 lands in
the same change because hard-Stop settlement would otherwise hang on a bare
approval resolver. Keep conflict accounting owned by the in-memory
orchestrator: reset it once at the beginning of a new `start()` pass, delete a
task's entry after a clean sync outcome, and delete terminal entries only when
that orchestrator releases active ownership.
This deliberately leaves conflict requeues counted inside one pass. Hard pause
will snapshot the tasks owned at the pause boundary, set `paused` before
aborting them, await those exact pipelines, and then persist `backlog` only for
snapshot tasks still in a transient stage. A synchronous
`publishActiveStage()` guard will be the only writer of `in_progress` and
`in_review`; because its ownership/pause check and update contain no await,
JavaScript cannot interleave a pause between them. No API, schema, timer,
deployment, or cross-process state changes are needed. Regression coverage
must hold barriers immediately before the initial/retry `in_progress` and
pre-gate `in_review` publications, retain the existing drain/approval tests,
and inspect counter cleanup at the new-run, clean-sync, and terminal
boundaries. Rollback is the single engine/test/docs change; no live EC2 check
is required because this is deterministic in-process scheduler state.

**Fix risk:** very low / low.

**Status:** completed with O16 in
[#196](https://github.com/IngeniousArtist/hoopedorc/pull/196)
(`59c8c7d`). `publishActiveStage` is now the only transient-stage writer and
synchronously checks pause plus active ownership. Hard Stop snapshots its
owned tasks, marks the orchestrator paused, aborts and settles those exact
pipelines, then persists backlog for any remaining runnable/transient task.
Barrier tests cover initial/retry `in_progress` and pre-gate `in_review`;
drain and approval behavior remain covered. Conflict counts reset at a new
`start()`, disappear immediately after clean sync, and prune when terminal
tasks release ownership, while the O29 same-run conflict → requeue → cap test
still proves the retry budget remains reachable.

Full local verification passed typecheck, build, lint, engine 194/194,
adapters 12/12, server 241/241, web 25/25, E2E 16/16 at
360/390/768/1280/1440 px, and `git diff --check`. Linux `build-and-test` CI
passed in 2m18s. The merged commit was confirmed as local and `origin/main` at
`59c8c7d`; the shared O16/O21/O29 engine checks then passed 9/9 and the focused
server O16 checks passed 3/3. No live EC2 check is required for this
in-process-only lifecycle change.

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

**Implementation decision (2026-08-11, dialog sub-item):** O5 owns the shared
dialog foundation and its migration of `TaskDrawer` and `TokenGate` in this
PR. The toast-timer, LogPanel, dead-button, and multi-project WebSocket bullets
remain paired with their separately ordered owning items as specified above.

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

The post-merge EC2 update/health acceptance was completed on 2026-08-11 using
the subsequently authorized `ubuntu@hooped` host. The clean, idle
`/opt/hoopedorc` checkout updated through the canonical UI updater to
`992ea6d6b04fe22831b0cedd612044d7caed2574`; the fixed
`hoopedorc.service` whose `WorkingDirectory` matches that checkout restarted
and remained active. The final checkout was clean on `main`, and loopback
health plus the Tailscale health/dashboard routes returned HTTP 200. O17 and
O19 record the phase-level and same-commit retry evidence from the same live
acceptance sequence.

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

**Implementation decision (2026-07-29):** keep the deterministic
`build-and-test` job on pull requests and `main` pushes, and run the advisory
security job only on its weekly schedule or an explicit manual dispatch. At
workflow scope, group PRs by workflow plus `github.head_ref` and use the unique
`github.run_id` fallback for every non-PR event; cancel only pull-request runs.
This follows GitHub's defined fallback pattern and prevents both running and
pending `main` verifications from sharing a concurrency group.

Use the two-parent checkout already required by O31. The whitespace step must
compare `HEAD^1...HEAD` for the synthetic PR merge and `HEAD^...HEAD` for a
`main` push; bare `git diff --check` on a clean checkout would be vacuous. Build
once, then use a named prebuilt-workspace typecheck command so CI does not
rebuild types/adapters/engine before the normal build repeats them.

After `npm ci`, resolve the installed `@playwright/test` version into a step
output. Cache Linux's `~/.cache/ms-playwright` with an exact key containing
runner OS, that version, and the lockfile hash. A miss runs
`playwright install --with-deps chromium`; a hit still runs
`playwright install-deps chromium` because Playwright documents OS packages as
uncacheable. Do not use a broad restore key that could pair the wrong browser
binary with the installed package.

The weekly/manual audit is owned by `IngeniousArtist` and invokes
`npm audit --audit-level=high --json` through a checked Node classifier. It
writes raw and normalized artifacts on every outcome and emits distinct
annotations/exit codes for high-or-critical findings versus registry,
execution, or malformed-response failures. It remains outside protected PR
checks until an explicit reproducible exception/outage policy exists. Focused
tests own workflow structure, diff-range failure, concurrency isolation,
cache hit/miss branches, and audit classification. No runtime state, API,
persistence, deployment, or EC2 behavior changes; rollback is the O32
workflow/policy-test commit.

**Status:** completed in
[#194](https://github.com/IngeniousArtist/hoopedorc/pull/194)
(`75e73e5`). CI now checks committed changes for whitespace, cancels only
superseded runs of the same PR, gives every non-PR run a unique concurrency
group, builds once before workspace typechecking, and keeps the scheduled or
manual registry audit outside deterministic PR checks. The Playwright cache
key contains runner OS, installed `@playwright/test` version, and lockfile
hash; a miss installs Chromium plus OS dependencies, while a hit restores only
the browser archive and still verifies host packages. The audit classifier
always archives raw, stderr, and normalized evidence and distinguishes
findings from registry, execution, malformed-response, and unexplained npm
failures.

Local verification passed typecheck, build, the new prebuilt typecheck, lint
with 16/16 policy tests across 140 files and the exact 341-finding baseline,
engine 187/187, adapters 12/12, server 238/238, web 25/25, E2E 16/16 at
360/390/768/1280/1440px, YAML/Node syntax checks, and `git diff --check`. The
first sandboxed server run denied three loopback listeners with `EPERM`; the
required permissioned rerun passed all 238. The committed mutation regression
proved trailing whitespace fails the exact push diff range, and four audit
regressions proved clean, high/critical, registry, malformed, unexplained, and
spawn outcomes remain distinct. A sandboxed live audit produced a correctly
classified registry/DNS failure; after explicit network approval, the same
command was clean at the high/critical threshold and retained one low advisory
in its raw and normalized evidence.

Live PR run `30456746332` at `a90ebe3` was canceled when run `30456768082`
superseded it. Reviewing that completed run caught an empty version output in
the first cache key; `2cf2829` made extraction fail closed and added an exact
regression. Corrected run `30457930771` passed in 2m06s with key
`Linux-playwright-1.61.1-<lockhash>`, a real miss, the normal
`install --with-deps chromium` fallback, 16 E2E passes, and a saved cache.
Merged-main run `30458225663` independently passed in 2m15s and published the
same exact default-branch cache. Concurrently dispatched manual audit run
`30458262638` was preserved and queued instead of canceling the main run,
passed with owner `IngeniousArtist`, and uploaded the 30-day
`npm-audit-30458262638` artifact with no high or critical findings.
Evidence-PR run `30458691543` then restored the exact default-branch
`Linux-playwright-1.61.1-<lockhash>` key, ran only
`playwright install-deps chromium`, skipped the browser-download branch, passed
all 16 E2E tests, and finished green in 2m06s. No live EC2 check was required
because O32 changes only repository CI.

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

**Extraction decision (2026-07-29):** this first PR is deliberately limited to
the pure decision extraction. `escalateOrFail(...)` receives a snapshot of the
stage, current/fallback model, attempt position, and stage-specific failure
context, then returns the exact fallback or terminal decision without mutating
the task or consulting live settings. One shared applicator owns the existing
model-count switch, rate-limit cleanup, `maxAttempts` bump, log/notification,
terminal status, and persistence callbacks. It introduces no new state,
contract, migration, restart behavior, or UI change. Golden table tests must
cover author failure (with and without remaining attempt headroom), no changes
(clean and wrong-primary-clone diagnoses), failed gates, and self-review
collision, each with a fallback and with the chain exhausted. Existing
orchestrator integration tests remain the persisted-transition rail. The
durable retry-accounting redesign stays out of this PR.

**Status (extraction PR 1):** completed in
[#198](https://github.com/IngeniousArtist/hoopedorc/pull/198)
(`784bfa8`). All four `executeTask` escalation sites now snapshot their live
fallback candidate into the pure `escalateOrFail(...)` decision helper and
apply its result through one shared side-effect boundary. The extraction
preserves the original per-stage attempt-budget rules, model concurrency
switch, rate-limit cleanup, log and model-trouble messages, terminal reasons,
task update, and fallback timing. The golden table covers author failure with
and without attempt headroom, clean and wrong-primary-clone no-change
diagnoses, gate failures, and validator/author collisions, with both an
available fallback and an exhausted chain. The focused test failed before the
helper existed and passed after extraction.

Full local verification passed typecheck, build, lint across 140 files with
the exact 340-finding baseline, engine 195/195, adapters 12/12, server 241/241,
web 25/25, E2E 16/16 at 360/390/768/1280/1440 px, and
`git diff --check`. Linux `build-and-test` CI passed at reviewed head
`0a63cb9` in 2m24s. After merge, local `main` and `origin/main` matched
`784bfa83e9095c74b3355c375a6296d1d0cfefe1`; the O34 focused golden check
passed 1/1 and the complete engine suite passed 195/195 again on that commit.
No EC2 smoke is required because no contract, persistence, UI, process, or
deployment behavior changed. O34's second, durable retry-accounting
design/implementation PR remains open and intentionally separate.

**Accounting decision (2026-07-29):** the second PR uses the existing task row
as the atomic restart boundary and keeps `maxAttempts` immutable. `attempts`
continues to count author invocations reserved in the current logical run;
`runExtraAttempts` records only recovery allowance, so the effective limit is
`maxAttempts + runExtraAttempts`. The same row also persists the current
fallback model, exhausted models, and same-model rate-limit retry count because
all three are required to resume the exact boundary after a stop or process
restart. A monotonic `runGeneration` starts at zero and increments exactly once
in the same SQLite transaction as an accepted manual Retry and its audit entry;
that new-run transition alone resets attempts, recovery allowance, fallback
position, and stale execution coordinates. Generation-qualified run IDs keep
new runs from overwriting prior invocations or merge decisions while generation
zero retains legacy IDs for recovery. The idempotent migration preserves every
historical `attempts`/`max_attempts` value rather than guessing whether an old
maximum was policy or runtime inflation. Full semantics, migration behavior,
non-goals, and transition ordering are recorded in
`docs/specs/retry-accounting.md`.

**Status (accounting PR 2):** completed in
[#200](https://github.com/IngeniousArtist/hoopedorc/pull/200)
(`832732d`). The canonical task row now separates immutable `maxAttempts`
policy from consumed author invocations and durable recovery allowance, and
persists the logical-run generation, current fallback, exhausted models, and
same-model rate-limit waits. Every fallback stage resumes from the same model
and effective budget after a fresh Orchestrator starts. Manual HTTP/Telegram
Retry uses one conditional SQLite transaction, so exactly one concurrent
caller increments the generation, resets run state, records durable dispatch
intent, and creates the audit entry. Generation-qualified run IDs preserve
prior invocations and merge decisions, while the board and Telegram describe
policy and recovery allowance separately.

The pre-change engine, migration/repository, and TaskCard regressions failed
without the run-state helper, task columns/atomic reset, and unambiguous label,
then passed with the implementation. Full local verification passed typecheck,
build, lint across 142 files with the exact 340-finding baseline, engine
203/203, adapters 12/12, server 244/244, web 26/26, E2E 16/16, and
`git diff --check`. Real-browser verification at 360, 390, 768, 1280, and
1440 px confirmed the exact policy/recovery label and tooltip, no
document-level overflow, and no browser errors. Linux `build-and-test` CI
passed at reviewed head `24067d8` in 2m12s. After merge, local `main` and
`origin/main` matched `832732d719de33686f28da4778518d58db9e804b`; the
focused O34 engine restart matrix passed 9/9, the server migration/concurrent
Retry checks passed 3/3, and the TaskCard check passed 1/1 again on that
commit.

The required post-merge EC2 update and live health/board smoke remain
outstanding: this execution environment has no SSH identity or configuration,
Tailscale CLI, or configured production endpoint with which to identify the
authorized box safely. Run `scripts/update.sh` from the known clean, idle
production checkout, then record the exact checkout commit, matching
`hoopedorc.service` restart, `GET /api/health`, migration-preserved task data,
and loopback/Tailscale board label.

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

**Measurement protocol and go/no-go threshold (2026-07-29, before any runtime
change):** `npm run bench:scheduler-poll` uses the production schema and
repository mapper against a real in-memory SQLite database. It measures three
three-second steady-state repetitions with 250 task rows per project for one
held runtime (the normal case) and eight concurrent held runtimes (a
deliberately heavy case), subtracts an idle-process CPU control, and records
full-table reads and SQLite wall time per second. Forty task inserts spread
deterministically across the polling phase measure commit-to-reconciliation
p50/p95/max latency. A generation/wakeup protocol is justified only if the
one-project fixture consumes at least 1% of one CPU core or 5 ms of SQLite
wall time per second, or the eight-project fixture consumes at least 5% of one
core after the control subtraction. Any implementation must retain p95 pickup
latency at or below the measured baseline plus 25 ms and must use this exact
fixture before and after. Below those thresholds, record the result and defer
without adding generation state or wakeup ownership.

**Measurement result and implementation decision (2026-07-29):** the baseline
crossed both go thresholds, so O35 proceeds rather than deferring. On the same
Apple M5 Pro / Node 22.23.0 host and exact 250-row fixture, one held project
performed 3.937 full reads/s, spent 8.393 ms/s in SQLite, and used 1.609% of
one core after the idle control; eight projects performed 31.408 reads/s,
spent 45.835 ms/s in SQLite, and used 6.075% of one core. Commit-to-reconcile
latency across 40 inserts was p50 131.059 ms, p95 235.218 ms, max 244.578 ms.

The implemented database-trigger generation plus same-process monotonic wake
version, measured with the unchanged command and fixture, reduced those
figures to 0.330 reads/s, 1.042 ms/s, and 0.308% for one project; 2.641
reads/s, 3.304 ms/s, and 0.971% for eight projects. The SQLite values include
the new lightweight generation reads (7.922/s and 63.384/s respectively), not
only the remaining full reads. Pickup latency improved to p50 2.163 ms, p95
4.975 ms, max 5.053 ms. That is a 91.6% reduction in full-table reads,
87.6%/92.8% less total measured SQLite time, and 80.9%/84.0% less scheduler
CPU for the normal/heavy fixtures, while p95 pickup improved by 230.243 ms
rather than regressing. The 250 ms deadline remains unchanged as the
out-of-process and time-window safety net.

**Acceptance:** before/after results use the same task counts/host; steady
full-table reads materially drop without increasing p95 dispatch latency
beyond the documented bound. Tests cover a write immediately before wait,
during waiter registration, during reconciliation, multiple writes collapsed
to one latest generation, restart, manual dispatch, cooldown, quota, pause,
and drain; no wakeup is lost and time-based deadlines still fire; full gates
green. If baseline CPU/latency is immaterial, defer O35 with evidence and add
no signaling protocol.

**Status:** completed in
[#202](https://github.com/IngeniousArtist/hoopedorc/pull/202)
(`c2b2b5f`). SQLite triggers now own one transactionally incremented
`task_generation` per project, including direct and out-of-process task
writes. Repository writes additionally advance a monotonic same-process wake
version. The scheduler captures that edge, rechecks the durable generation,
and rebuilds its task map only after a generation change; the existing 250 ms
deadline still owns external-write recovery and cooldown, quota, capacity,
approval, pause, and drain progress.

The pre-change benchmark crossed the recorded go thresholds, and the same
fixture after implementation reduced full reads by 91.6%, measured SQLite
time by 87.6%/92.8%, and adjusted scheduler CPU by 80.9%/84.0% for one/eight
held projects while improving pickup p95 by 230.243 ms. Full local
verification passed typecheck, build, lint across 144 files with the exact
340-finding baseline, engine 210/210, adapters 12/12, server 250/250, web
26/26, E2E 16/16, and `git diff --check`. Linux `build-and-test` CI passed at
reviewed head `d4726c3` in 2m27s.

After merge, clean local `main` and `origin/main` matched
`c2b2b5f8d0651f5b7518e496d3076c2a33872b20`. The unchanged benchmark again
measured 0.330/2.641 full reads per second, 0.905/3.386 ms of total SQLite time
per second, 0.275%/0.993% adjusted CPU, and 4.449 ms pickup p95 on the same
Apple M5 Pro/Node 22.23.0 fixture. The focused engine race/deadline matrix
passed 7/7, focused server migration/wake/wiring checks passed 6/6, and the
complete engine suite passed 210/210 on that merged commit. No UI, external
CLI, filesystem-ownership, or deployment/process behavior changed, so no
additional live-system smoke is required.

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

**`liveSettings()` measurement protocol and threshold (2026-07-29, before any
O36 production change):** instrument the real SQLite settings statement while
invoking each affected dependency/event closure from one already-built
`EngineRunner` runtime. Count reads for adapter resolution, budget, quota,
Figma-free preflight, task-status update, run update, and model-trouble
notification, changing persisted settings after runtime construction where
needed to prove freshness. Separately time 10,000 production
`repo.getSettings()` reads/normalizations against the default settings row.
Implement only if one closure invocation performs more than one settings read;
otherwise the suspected duplicate work is absent and this candidate is closed
as deferred without adding caching or changing freshness boundaries.

**`liveSettings()` measurement result and decision (2026-07-29):** the
instrumented baseline found zero reads for a Figma-free preflight, one each for
adapter resolution, budget, quota, task update, and model-trouble handlers, but
three for one billable terminal `onRunUpdated` event: manual run pricing,
invocation-ledger pricing, and the resulting budget-alert check each re-read
and re-normalized the settings row. Five 10,000-read repetitions against the
default settings row took 118.412–147.216 ms, median 121.084 ms (12.108 µs per
read) on the Apple M5 Pro / Node 22.23.0 measurement host. The count threshold
therefore passed. The implementation captures settings once at the event
boundary and threads that snapshot through invocation persistence and budget
alerts; separate events still read live state. The same instrumented billable
event now performs one read, eliminating two reads (about 24.216 µs on this
fixture). Its regression failed at `3 !== 1` before the fix and also proves
that the fresh manual price reaches the run, invocation, cost, and both crossed
budget alerts.

**Acceptance:** each PR contains its own counting/timing baseline and removes
only duplicated work demonstrated by that evidence; settings freshness,
snapshot completeness/order, and destructive-change inspection remain
identical; full gates green. Unmeasured or immaterial candidates are closed as
deferred without code.

**Status (`liveSettings()` candidate):** completed in
[#204](https://github.com/IngeniousArtist/hoopedorc/pull/204)
(`fb58add`). A billable terminal run event now owns one normalized settings
snapshot across manual pricing, invocation-ledger pricing, and budget alerts,
reducing the measured SQLite settings reads from three to one while separate
events retain live reads. Full local verification passed typecheck, build,
lint across 144 files with the exact 340-finding baseline, engine 210/210,
adapters 12/12, server 251/251, web 26/26, E2E 16/16, and
`git diff --check`. Linux `build-and-test` CI passed at reviewed head
`9bab1f9` in 5m23s.

After merge, clean local `main` and `origin/main` matched
`fb58addf4154072e9d9f1425ec75e05074b873f0`. The focused O36 regression passed
1/1, and the independent measurement again counted zero reads for Figma-free
preflight and one each for adapter, budget, quota, task update, run update,
and model-trouble closures. Five 10,000-read repetitions had a 118.797 ms
median (11.880 µs/read), while live task and model-trouble notifications
remained observable. No API, persistence-schema, UI, external CLI,
filesystem-ownership, or deployment/process behavior changed, so no
additional live-system smoke is required.

**WS catch-up snapshot N+1 measurement protocol and threshold (2026-07-30,
before any O36 production change):** seed one project with 250 tasks and three
historical runs per task, then subscribe a real `WsHub` client after
`buildApp()` has registered the production snapshot provider. Instrument the
exact SQLite run-read statements and record five 100-snapshot timing
repetitions. Capture `EXPLAIN QUERY PLAN` for both the current per-task query
and the proposed project-scoped tasks→runs join. The join must search through
the existing `idx_tasks_project` and `idx_runs_task` indexes without a full
`runs` table scan; a temporary sort remains acceptable when needed to preserve
each task's newest-first run order. Implement only if the production snapshot
issues one `getRuns(taskId)` statement per task (250 on this fixture), the
join produces the identical project/task/run event sequence, and one grouped
run query can replace those reads. Otherwise defer this candidate without an
index, cache, or contract change.

**WS catch-up snapshot N+1 measurement result and decision (2026-07-30):** the
real production subscribe path emitted 1,001 project/task/run events per
snapshot for that 250-task/750-run fixture and issued exactly 250
`SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC` statements.
Five 100-snapshot repetitions took 354.640–365.870 ms, median 357.642 ms, on
the Node 22.23.0 local measurement host. The current query plan uses
`idx_runs_task`; the proposed tasks→runs join uses both `idx_tasks_project` and
`idx_runs_task` with no full `runs` scan (each plan needs a temporary sort to
preserve newest-first task history). The threshold therefore passed. The
pre-fix production-snapshot regression failed at `250 !== 1`; implement one
joined repository read and group it in memory without changing the WebSocket
contract, event contents, or project/task/run ordering. On the unchanged
fixture after implementation, each 100-snapshot repetition issued 100 grouped
run statements rather than 25,000 per-task statements, and took
225.055–235.886 ms, median 225.963 ms. That removes 99.6% of snapshot run-read
statements and 131.679 ms per 100 snapshots (36.8%) on this fixture. Focused
tests prove project isolation, newest-first task history, one query for the
production subscribe path, and the full emitted event sequence.

**Status (WS catch-up snapshot candidate):** completed in
[#206](https://github.com/IngeniousArtist/hoopedorc/pull/206)
(`3e461c4`). The catch-up snapshot now fetches runs through one
project-scoped tasks→runs join and groups its newest-first stream in memory,
while preserving the existing project → task → run event sequence. Full local
verification passed typecheck, build, lint across 144 files with the exact
340-finding baseline, engine 210/210, adapters 12/12, server 253/253, web
26/26, E2E 16/16, and `git diff --check`. Linux `build-and-test` CI passed at
reviewed head `a225cde` in 2m21s.

After merge, clean local `main` and `origin/main` matched
`3e461c41d23a728bf3fa127d890cc057a85c9c3f`. The focused production
subscribe-path regression passed 1/1. The unchanged 250-task/750-run fixture
again emitted 1,001 events per snapshot and made 100 grouped run statements
per 100 snapshots (one each), with a 217.042 ms median across five
repetitions. The real query plans still search `idx_tasks_project` and
`idx_runs_task` without a full `runs` scan. No API, WebSocket event,
persistence-schema, UI, external CLI, filesystem-ownership, or
deployment/process behavior changed, so no additional live-system smoke is
required.

**Settings-save full scan measurement protocol and threshold (2026-07-30,
before any O36 production change):** seed 20 projects with 250 tasks each
(5,000 task rows on models that exist in settings, mixed terminal and active
statuses), then drive the real production `PUT /api/settings` route through
`buildApp()`. Instrument the exact SQLite project/task statements one save
issues and record five 100-save timing repetitions. Capture
`EXPLAIN QUERY PLAN` for the current per-project tasks read and for the
proposed single project-join read; the join must search `tasks` through the
existing `idx_tasks_project` index without a full `tasks` scan, with a
temporary sort acceptable to preserve the replaced loop's warning order
(newest project first, oldest task first). Implement only if one production
save issues one tasks statement per project (20 on this fixture) and maps
every task row to warn about the rare dangling few; otherwise defer this
candidate without an index, cache, or contract change.

**Settings-save full scan measurement result and decision (2026-07-30):** the
real production save issued one projects-list read plus exactly 20
`SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC` statements
(25 statements per save in total) and materialized all 5,000 task rows to
produce zero warnings on this clean fixture. Five 100-save repetitions took
1482.405–1517.786 ms, median 1489.405 ms (14.894 ms per save), on the
Node 22.23.0 local measurement host. The threshold therefore passed. The
pre-fix production-save regression failed at `6 !== 1` on its six-project
test fixture; implement one joined repository read that filters status and
assigned model in SQL and pins the project→tasks join order with `CROSS JOIN`
so SQLite searches `idx_tasks_project` instead of scanning `tasks` (an
unpinned join plans as a full `tasks` scan), while keeping the warning text
and order identical. On the unchanged fixture after implementation, one save
issued 5 statements (zero projects-list, zero per-project, one joined read)
and five 100-save repetitions took 46.607–54.019 ms, median 48.554 ms
(0.486 ms per save). That removes 20 of the 21 project/task statements and
96.7% of the median save time (14.408 ms per save) on this fixture. Focused
tests prove terminal and known-model exclusion, the loop's warning order,
warning parity on the production save path, and the one-statement invariant.

**Status (settings-save full scan candidate):** completed in
[#208](https://github.com/IngeniousArtist/hoopedorc/pull/208)
(`c3b3e79`). A settings save now checks dangling task models through one
`CROSS JOIN` repository read that filters status and assigned model in SQL
while keeping the replaced loop's exact warning text and order. Full local
verification passed typecheck, build, lint across 144 files with the exact
340-finding baseline, engine 210/210, adapters 12/12, server 255/255, web
26/26, E2E 16/16, and `git diff --check`. Linux `build-and-test` CI passed at
reviewed head `a9c778f` in 5m30s.

After merge, clean local `main` and `origin/main` matched
`c3b3e7973ddee3b52b4135ea05354797faa0e124`. The focused O36 regressions
passed 2/2, and the independent measurement on the unchanged
20-project/5,000-task fixture again issued one joined dangling-model
statement per save (5 statements total) with a 49.003 ms median across five
100-save repetitions, while the real query plan searched `idx_tasks_project`
with no full `tasks` scan. No API, WebSocket event, persistence-schema, UI,
external CLI, filesystem-ownership, or deployment/process behavior changed,
so no additional live-system smoke is required.

**Merge-decision git diff measurement protocol and threshold (2026-07-30,
before any O36 production change):** drive one complete task pipeline through
the real `Orchestrator` with instrumented worktree dependencies and count the
changed-file/diff acquisitions one `hard_gate_flag_risky` merge decision
issues, then time the candidate-redundant
`git diff --name-only origin/main...HEAD` subprocess (five 100-invocation
repetitions on a real 500-file/10-changed repository). Separately prove the
reuse precondition against real git: `changedFiles` and the path field of
`changedFilesWithStatus` must report identical lists over the same
`origin/<defaultBranch>...HEAD` refs for added, modified, deleted, and
renamed files, under both default rename detection and `diff.renames=false`
(both invocations share one repository config, so they cannot disagree on
that setting). Implement reuse only if the merge decision demonstrably lists
changed files twice with no worktree or ref mutation between the two reads
and the parity proof holds; otherwise keep the separate safety inspection and
defer. The destructive inspection itself must remain byte-identical, and a
disabled `destructiveChanges` rule must keep its own risky-rule listing.

**Merge-decision git diff measurement result and decision (2026-07-30):** one
real merge decision issued one `changedFilesWithStatus`, one `diffText`, and
one additional `changedFiles` — the risky-file rules' own listing over the
exact refs the destructive inspection had just read, launched milliseconds
earlier in the same `canAutoMerge` invocation with no mutation in between.
(The pipeline's other `changedFiles` call, the post-author empty-worktree
guard, runs at a different stage with non-identical timing and stays.) The
redundant subprocess measured a 703.243 ms median per 100 invocations
(7.032 ms per merge decision) on the 500-file fixture, Node 22.23.0
measurement host, git 2.50.1. Real-git parity held: with rename detection
both listings report only the rename's destination path, and with
`diff.renames=false` both decompose it into delete plus add. The threshold
therefore passed. The pre-fix regressions failed at `2 !== 1` for both the
counting and the reused-rule-input cases; implement reuse of the completed
destructive inspection's path list inside `canAutoMerge` only, with a
disabled inspection still performing its own separate listing (proven by a
test that passes unchanged before and after). Reuse also removes the window
in which a sibling task's fetch could advance `origin/<defaultBranch>`
between the two subprocesses of one decision. After implementation the same
instrumented pipeline issued one `changedFilesWithStatus`, one `diffText`,
and one author-stage `changedFiles`, with the merge decision launching no
second listing.

**Status (merge-decision git diff candidate):** completed in
[#210](https://github.com/IngeniousArtist/hoopedorc/pull/210)
(`c883c97`). The risky-file rules now reuse the completed destructive
inspection's path list inside `canAutoMerge`; a disabled
`destructiveChanges` rule keeps its own separate listing, and the
destructive inspection itself is byte-identical. Full local verification
passed typecheck, build, lint across 144 files with the exact 340-finding
baseline, engine 214/214, adapters 12/12, server 255/255, web 26/26,
E2E 16/16, and `git diff --check`. Linux `build-and-test` CI passed at
reviewed head `65c2f0f` in 2m18s.

After merge, clean local `main` and `origin/main` matched
`c883c9702a69e8c1442d84e57529bc5f68d2a3ba`. The focused O36 regressions
passed 4/4, and the independent instrumented pipeline again issued one
`changedFilesWithStatus`, one `diffText`, and only the author-stage
`changedFiles`, while the avoided subprocess re-measured a 712.548 ms median
per 100 invocations (7.125 ms per merge decision) on the unchanged 500-file
fixture. No API, contract, persistence, UI, external CLI,
filesystem-ownership, or deployment/process behavior changed, so no
additional live-system smoke is required. This closes the last of O36's four
candidates: live settings reuse (#204), the WebSocket catch-up join (#206),
the settings-save scan (#208), and this merge-decision reuse (#210).

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
3. **Regression rails before behavior-sensitive work — merged (O27, O29,
   O30 + O33, O31, O32):**
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
   - O32 merged in
     [#194](https://github.com/IngeniousArtist/hoopedorc/pull/194) and
     [#195](https://github.com/IngeniousArtist/hoopedorc/pull/195)
     (`75e73e5`, `bc5e792`) as a separate CI-policy change with no production
     behavior changes.
4. **Durable correctness and recovery:**
   - O3 planning revision receipts.
   - O4 shared Git serialization.
   - O7 authoritative PR merge confirmation.
   - O13 query/delete migration.
   - O16 abort-aware approval ownership (merged with O21 in
     [#196](https://github.com/IngeniousArtist/hoopedorc/pull/196)) →
     O14 durable approval/Stop transitions → O15 Telegram inbox/outbox.
     This order gives Telegram a durable, idempotent approval consumer to
     call.
   - O18 route validation (using O27's injection rails).
   - O20 accounting/log persistence.
   - O21 lifecycle cleanup only after O29 — merged with O16 in
     [#196](https://github.com/IngeniousArtist/hoopedorc/pull/196).
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
   O35 merged in
   [#202](https://github.com/IngeniousArtist/hoopedorc/pull/202)/[#203](https://github.com/IngeniousArtist/hoopedorc/pull/203);
   all four O36 candidates merged with evidence in #204–#211. O10 and O22
   benchmarks remain.
7. **Structural cleanup:** O34 helper extraction after O29/O21, followed by
   its separate durable-accounting design/PR if still justified — merged in
   [#198](https://github.com/IngeniousArtist/hoopedorc/pull/198)–[#201](https://github.com/IngeniousArtist/hoopedorc/pull/201).
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
