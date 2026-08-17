# Architecture

## One TypeScript monorepo (npm workspaces)

```
@orc/types     shared domain model + REST/WS contract        (the contract)
@orc/adapters  Claude Code + OpenCode + Codex runners        (deepseek-flash)
@orc/engine    scheduler, worktrees, git/PR, gates, validator,
               Docker gate sandbox                            (deepseek-pro)
@orc/server    Fastify REST + WS, SQLite persistence,
               planner, Telegram bot, scheduler               (deepseek-flash)
@orc/web       React kanban UI, live logs, settings           (glm)
```

(The parenthetical model names record which agent originally built each
package in the dogfooded initial rounds — see the README's closing note.)

Dependency rule: every package depends on `@orc/types` and nothing else
horizontal. `engine` may use `adapters`. `server` wires `engine` + `adapters`
together at the edge (Round 2 integration). `web` talks only to the HTTP/WS API.

## Runtime picture

```
                 ┌──────────────┐   WS (logs/board)   ┌──────────────┐
                 │   @orc/web    │◀───────────────────▶│  @orc/server │
                 │  (browser UI) │   REST (/api/*)     │  Fastify+WS  │
                 └──────────────┘                      │   SQLite     │
                                                       └──────┬───────┘
                                                              │ drives
                                                       ┌──────▼───────┐
                                                       │  @orc/engine │
                                                       │ DAG + gates  │
                                                       │ + validator  │
                                                       └──────┬───────┘
                                              creates worktrees, runs models
                     ┌────────────────────────────────────────┼────────────────────────┐
                     ▼                                        ▼                        ▼
             ┌───────────────┐                      ┌──────────────────┐      ┌───────────────┐
             │ ClaudeAdapter │ claude -p            │ OpenCodeAdapter  │      │ CodexAdapter  │
             │ (Claude sub)  │                      │ opencode run     │      │ codex exec    │
             └───────────────┘                      │ (GLM, Deepseek,  │      │ (ChatGPT sub) │
                                                    │  Grok, Nex, …)   │      └───────────────┘
                                                    └──────────────────┘
```

Realtime ownership is project-scoped at both ends of the WebSocket boundary.
`WsHub` keeps one subscribed project per socket and captures a catch-up
sequence beginning with the durable global project list and bounded
`notifications.snapshot` inbox, followed by the selected project's authoritative
`cost.snapshot` and task/run state. This restores approvals that were broadcast
while the socket was offline without replaying browser alerts. The hub validates the whole baseline before
activation and flow-controls it one frame per send completion; matching live
events queue behind the replay and drain afterward in order. A client whose
pending `bufferedAmount` plus the complete outgoing or queued live frame reaches
the documented 1 MiB ceiling is closed with application code `4008`, forcing a
fresh snapshot instead of silently dropping an event. Durable snapshot records
remain source events and permit exactly one in-flight frame, so even a large
static baseline does not fill the transport queue or reconnect forever.
Individual send errors close only the broken socket, including async write-
completion failures. A snapshot-provider or serialization error closes before
the subscription is activated, and a late completion from a removed client
cannot affect a replacement socket.

The web `useWS` hook owns a reference-counted manager keyed by project ID.
Same-project consumers share one socket, while simultaneous projects use
isolated sockets and dispatch registries. Managers defer zero-subscriber
teardown for one tick to tolerate React effect churn and reconnect with
bounded backoff after transport loss. Subscriber exceptions are reported with
the project identifier only and do not stop later subscribers from receiving
the event. Each manager retains the latest authoritative cost total and
advances it with ordered deltas, so a same-project view mounted after the
socket replay receives a synthetic `cost.snapshot` baseline before later live
events. Transport loss invalidates that cached baseline: a view mounted during
reconnect backoff uses its REST seed until the replacement socket supplies a
fresh snapshot. An empty project ID requests the same durable global catch-up
but remains unsubscribed from project-scoped live events, so onboarding and
post-deletion views restore and continue receiving global project/notification
state. Successful approval responses remain locally authoritative over any
older REST or reconnect snapshot captured before the durable response; the
later queued live notification then confirms the same terminal state.

Mock mode emits synthetic logs from one server-owned maintenance timer through
`WsHub.broadcast`, so project isolation and backpressure are identical to live
events; shutdown clears that timer with the other maintenance work.

Gate scripts, dependency installs, and structured project setup run through
`@orc/engine`'s Docker sandbox (`sandbox.ts`) when a daemon is reachable — a
disposable `docker run --rm` per command, mounting only the task's worktree
(rw), with an allowlist env built from scratch. B38 selects npm/pnpm/Yarn/Bun
reproducibly, installs into an isolated staging snapshot, and atomically
publishes only generated dependency artifacts to a fingerprinted sibling
cache. Each worktree receives an independent materialization, so neither the
primary clone nor sibling tasks share mutable `node_modules`. Agents themselves
still run on the host (sandbox phases 2–3 are future work; see
`docs/specs/sandbox.md`).

Git worktrees isolate task files but still share refs, configuration, and the
common Git directory. The engine's repository lock resolves that canonical
common directory for every primary-clone and worktree mutation, so fetch,
branch/worktree lifecycle, commit, push, primary sync, rollback, and the shared
`info/exclude` write cannot overlap within one repository. Different
repositories still run concurrently, queued cancellation never starts later,
and idle lock entries are evicted. Dependency installation and task-local work
remain outside this lock.

Every author, validator, documenter, and planner CLI receives the same
`sanitizedEnv()` boundary: an explicit runtime/config allowlist containing the
same user's HOME/XDG/CLI config roots, locale, PATH, platform requirements, and
non-credential npm registry/proxy settings. Server/provider/GitHub/Telegram
tokens and npm auth/password/config-indirection variables are not forwarded.
This limits accidental environment leakage but does not sandbox host filesystem
or network access; a host-run model can still reach files available to that OS
user.

Settings have two timing classes. Runner/model/effort are snapshotted directly
before each CLI invocation so an in-flight process is never killed or mutated by
a settings save. Operational policy is read from the validated SQLite settings
row at each decision boundary: dispatch and fallback routing, enabled state,
budgets/quotas, approval holds, merge policy, notification gates, and manual
pricing. Defaults, migrations, HTTP/Telegram writes, repository reads, and
runtime access all share the same normalizer, so an active scheduler never sees
a shape that the API would reject.
A billable run event captures one such normalized snapshot and threads it
through pricing, the invocation ledger, and budget alerts; it never caches that
snapshot across separate events.

Task retry state has one durable owner: the SQLite task row. `maxAttempts`
remains immutable policy, while `attempts`, `runExtraAttempts`, current and
exhausted fallback models, rate-limit retry count, and a monotonic logical-run
generation are persisted together at each execution boundary. An author
invocation is reserved before spawn. Restarted runtimes resume the stored model
and remaining effective allowance, and manual Retry conditionally resets that
tuple plus its audit record in one transaction. Generation-qualified run IDs
keep a retried task from overwriting earlier run, invocation, or validator
history.

Scheduler reconciliation has a separate durable owner: each project's
SQLite-only `task_generation`, incremented by database triggers in the same
transaction as every task insert, update, or delete. A runtime performs the
full task-table read/map rebuild only when that generation changes. Repository
writes also advance a monotonic same-process wake version so local changes are
noticed immediately without a lossy boolean edge; a 250 ms deadline still
compares the SQLite generation for out-of-process writes and rechecks
cooldown, quota, capacity, and approval state. Missing a memory notification
can therefore delay discovery only until the deadline—it cannot lose work.

Telegram polling is likewise SQLite-owned. `telegram_updates` durably claims
each inbound `update_id`; `telegram_actions` gives mutating commands a stable
server-derived idempotency key and stores the committed domain result; and
`telegram_poll_state` advances only over contiguous processed rows. On boot,
engine/runtime recovery runs first, then abandoned Telegram claims replay in
order before long polling resumes. This makes the domain action exactly-once
while keeping Bot API replies outside that guarantee because Telegram exposes
no outbound idempotency key.

Hard Stop is an ownership barrier: the orchestrator marks itself paused,
aborts every task controller (including human-approval waits), settles the
pipelines it owned at that boundary, and only then persists remaining
transient tasks back to backlog. Graceful drain does not abort or rewrite
active work. Transient `in_progress`/`in_review` publications synchronously
verify both active ownership and the non-paused state, so a late stage update
cannot recreate an orphan after Stop.

Plan approval crosses an explicit Git/SQLite durability boundary. The submitted
draft is retained in SQLite under `planning` while one serialized primary-clone
operation writes and pushes PRD/AGENTS/CLAUDE together. The session archive is
finalized next; task creation, PRD publication, scratch clearing, and the
`planned` transition then happen in one SQLite transaction. Start is rejected
throughout `planning`, including after a partial failure, so a task worktree can
never branch before its planning context is present on the remote default
branch. A retry always pushes a prior local no-diff commit before finalizing DB
state.

Each editable plan also owns an immutable, server-issued revision UUID. All
planning writes are conditional on that current revision, preventing a stale
tab from overwriting later scratch. `planning_commits` is the durable
idempotency ledger: `(project_id, revision_id)` is unique, `content_hash` binds
the exact PRD/task/AGENTS input, and a successful row stores the created task
IDs plus the public response. The pre-Git transaction reserves `pending`; the
final task/project/scratch transaction publishes `successful`. Same-process
duplicates share the one active owner promise, while a restart can retry a
pending receipt through the idempotent Git/archive path or replay a successful
receipt without repeating external, database, or WebSocket effects. Clearing
the active revision on success separates a legitimate next planning iteration
from a retry, even when the content happens to be identical.

Exact Figma task references also cross one explicit execution boundary.
`EngineRunner` owns the Figma-specific parser, real runner probe, short-lived
model/file cache, invocation accounting, and durable notification dedupe.
`@orc/engine` asks for that proof before worktree creation, blocks only the
affected task on failure, and recognizes one stable mid-author loss marker.
This reuses the existing scheduler, Task `statusReason`, Retry/reassignment,
notification, and invocation-ledger paths; there is no generic capability
registry or second orchestration lifecycle.

Verified Figma planning also has one deterministic downstream consumer:
`packages/server/src/visual-qa-task.ts` assembles a normal frontend
`DraftTask` named `Visual fidelity QA` from the bounded verified-node records
and the self-contained implementation task handoffs. It reindexes the draft
DAG, puts implementation tasks first, then visual QA, then docs, and prefers a
verified author only when that preserves an independent validator. The Plan UI
uses its existing task editor/model picker/removal controls; save and commit
never regenerate the task. Execution is the ordinary B42-protected
author → gates → validator → merge path, not a critic loop.

## Why this split
- **One language (TS)** so the parallel agents share `@orc/types` and can't drift.
- **OpenCode as the single gateway** for all API-billed models — one CLI
  instead of six provider SDKs; Grok's OAuth lives inside OpenCode.
- **Claude Code and Codex headless** as native runners so each subscription
  bills at its flat rate; the planner is swappable between the two
  (`routing.planner` + that model's `runner`).
- **Git worktrees** give each task an isolated working dir on shared history, so
  models work in parallel without colliding; PRs + gates protect `main`.

## Process / deploy
- Local: `npm run dev` (all packages in watch) or `npm run mock` (UI + fake API).
- Production: `npm run build` once, then `npm run start:prebuilt` under the
  provided systemd unit (`deploy/hoopedorc.service`) — one process serves the
  API and the built web app; `npm run update` pulls/rebuilds/restarts in
  place. F50's Setup UI invokes that same fixed script through a separate
  transient `hoopedorc-self-update.service`, after validating clean `main`,
  idle projects, exact unit/checkout ownership, and non-interactive systemd
  capability. The updater runs as the service user and remains outside the
  main unit's control group, so the graceful restart cannot kill it midway.
  The CLIs (`gh`/`claude`/`opencode`, optionally `codex`) must be authenticated
  on the box as the service user. Full ordered walkthrough: USER_GUIDE's
  "Deploying to EC2 — checklist".

## Key decisions (locked)
- Merge policy: **hard gate + flag risky** (`Settings.mergePolicy`; a
  fully-autonomous mode exists but flag-risky is the default).
- Validator: configurable per difficulty (`Settings.validatorByDifficulty`),
  **never the same model as the author** — enforced at settings-save time.
- DB: **SQLite** (single-operator, local-first), with daily online-backup
  rotation.
- One project lives on exactly one instance — nothing deduplicates across
  servers (see USER_GUIDE's "Two boxes" section for the Mac↔EC2 split).
