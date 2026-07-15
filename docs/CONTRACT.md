# The Contract

Everything below lives in code in `@orc/types`. This doc is the human-readable
summary. **If you need to change the contract, change `@orc/types` and announce
it — all three modules depend on it.**

## Domain types (`@orc/types/domain.ts`)
`ModelId`, `Role`, `RunnerKind`, `ModelConfig`, `Difficulty`, `TaskStatus`,
`Task`, `Project`, `ProjectConfig`, `ModelInvocation`, `Run`, `LogEvent`,
`GateResult`, `MergeDecision`, `Notification`, `CostRecord`, `RoutingPolicy`, `Settings`, and the
`pickAssignedModel(routing, difficulty, role?)` helper. Read the file — it is the
source of truth. `Settings.routing` is what the Settings UI exposes as per-job
model selectors (planner, by-difficulty, by-role, validator).

`Task.dispatchRequestedAt` (B34, optional ISO timestamp) is durable manual-
dispatch intent. Manual Dispatch/Retry sets it while leaving the task in its
real `ready`/`backlog` state; the project's single scheduler prioritizes these
tasks and clears the field only when execution actually begins. This replaces
the old one-off manual Orchestrator path, lets multiple requests obey the same
scope/model-cap rules as autonomous work, and preserves a queued request across
a process restart.

B39 makes plan approval a durability boundary. The server first saves the
exact submitted PRD/task/AGENTS draft and sets the project to `planning`; it
then awaits one repository commit/push containing PRD, AGENTS.md, and the
conditional CLAUDE.md pointer, followed by the readable session archive. Only
after those succeed does one SQLite transaction create tasks, publish
`Project.prd`, clear planning scratch, and set `planned`. Every Start path
rejects a `planning` project. Repository, archive, or finalization failure
leaves the scratch intact for an idempotent retry.

`GitOperationError.stage` identifies `inspect`, `fetch`, `checkout`, `merge`,
`write`, `stage`, `commit`, `push`, or `cleanup`. `commitAll()` treats only a
confirmed empty porcelain status as a no-op; other failures propagate.
Cosmetic changelog publication and disposable worktree/branch cleanup remain
best-effort, but their callers emit warnings instead of hiding failures.

`Project.config` (`ProjectConfig`, F9) holds per-project overrides — gate
script names (or `false` to skip a gate), a free-form `testCommand` for
non-npm stacks (run via `execFile`, no shell), a `maxAttempts` default applied
to tasks created in that project, and a `mergePolicy` override. All fields
optional; an unset project behaves exactly as it did before F9. Set via
`config` on `CreateProjectRequest`/`UpdateProjectRequest` (`null` on update
clears it). F15 adds `requireGithubChecks` (boolean, opt-in) and
`githubChecksTimeoutMin` (integer 1–120, default 15 when unset): when set,
the orchestrator holds the auto-merge decision until the PR's own GitHub
checks (the target repo's CI, distinct from this app's local gates) report
`"passed"` or `"none"` (no checks configured); `"failed"`/`"timeout"`
escalate to a human approval instead of merging.

`ProjectConfig.setupCommand` (B38) is `{ command: string; args: string[] }`.
The engine passes that exact argument array to a managed process—never an
implicit shell—before authoring and again only when a recognized dependency
manifest changes. It shares the gate sandbox/host policy, ten-minute timeout,
and task cancellation signal. The API bounds the command to 200 characters
and the array to 100 literal arguments of at most 1000 characters each.

B38's Node setup selects `package.json#packageManager` first, otherwise one
unambiguous root lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`,
`bun.lock`, or `bun.lockb`). It runs npm `ci`, pnpm/Bun
`install --frozen-lockfile`, Yarn 2+ `install --immutable`, or Yarn 1
`install --frozen-lockfile`. The immutable cache key covers all monorepo
`package.json` files, the selected lock, declared and detected manager
versions, Node version, platform, and architecture. A cache entry becomes
visible only by atomic rename after a successful install; worktrees receive
independent materializations, and primary-clone manifests are never rewritten.

`ModelConfig.quota` (F16) declares a subscription's rolling usage window —
`windowHours` plus at least one of `maxRuns`/`maxCostUsd` (enforced on
`PUT /api/settings`, a quota with neither set means nothing). When
configured, the scheduler skips dispatching that model once its window's
run count or spend is reached — cross-project, since a subscription's cap
belongs to the model's API key/plan, not any one project — the same
skip-don't-fail treatment as budget/cooldown checks.

`ModelConfig.enabled` is an execution boundary, not just a health-screen
filter: every saved routing target must name an enabled model, and disabled
models receive no new author, fallback, validator, planner, documenter, or
health invocation. Disabling a model does not abort a call already in flight.
`ModelConfig.effort` (F48, optional string) is resolved with the rest of that
attempt-stable invocation: Claude Code accepts `low|medium|high|xhigh|max`
through `--effort`; Codex accepts `low|medium|high|xhigh|max|ultra` through
`-c model_reasoning_effort=…`; OpenCode accepts a safe provider variant through
`--variant`. Unset means the CLI default. The same field applies in planning,
deconstruction, authoring, validation, per-task documentation, and health
tests. `Run.effort` records the resolved value (`"default"` when unset).

`ModelInvocation` (B40) is the authoritative accounting row for every CLI
model call. It records project/task/run correlation where applicable, stage
(`planner`, `deconstructor`, `author`, `validator`, `docs`, or `health`),
logical model, runner, effort, start/end, terminal outcome/exit reason, tokens,
cached tokens, and cost. The row is written as `running` before the process is
spawned and accepts one terminal transition; that transition and its legacy
`CostRecord` projection share one SQLite transaction. `Run` remains the task-
attempt/history and WebSocket compatibility view for author/docs calls, while
`CostRecord.invocationId` links a positive project-cost projection back to the
ledger. Startup marks a prior process's still-running rows `interrupted`, and
the migration backfills historical runs, unlinked costs, and model checks.
Rolling quotas, model health statistics, planning totals, budgets, and cost
analytics read the ledger, so zero-dollar subscription calls and non-author
stages consume run-count quota even when they add no visible dollar spend.

Settings pass through one server-side normalizer on defaults, boot migration,
repository reads/writes, HTTP updates, and Telegram command updates. It deep-
fills historical fields and rejects invalid runners, efforts, routing targets,
model concurrency, budgets, quotas, confidence, policies, and booleans with a
field path. Runtimes read operational policy live: dispatch/fallback routing,
budgets, quotas, approval holds, merge policy, notifications, and manual
pricing can change without restarting a project. A model/runner/effort already
selected for an active CLI call remains stable until that call settles.

`ProjectConfig.schedule` (`ProjectSchedule`, F19) is a deliberately simple
cron-style auto-start — not real cron syntax. `enabled: boolean` plus
`mode: "interval" | "daily"`: `"interval"` needs `intervalHours` (1–720,
runs every N hours since the last scheduled start); `"daily"` needs `hour`
(0–23) and `minute` (0–59), server-local time, runs once a day at that
clock time. A background check (~once a minute) calls the same
`EngineRunner.start()` the UI's Start button uses — no new dispatch path.
`Project.lastScheduledRunAt` (top-level, system-managed, **not** part of
`config`) tracks when the scheduler last actually kicked off a run, kept
separate from the user-edited `config` blob so a Settings save and the
scheduler's own write can never race each other.

`ProjectConfig.perTaskDocs` (F30, boolean, default true when unset) gates a
docs stage the orchestrator runs after validator approval and before merge:
a docs-role-routed model (`routing.byRole.updates ?? routing.byRole.docs`)
works in the same worktree to update CHANGELOG.md (and README.md/`docs/**`
only if this change makes them wrong), then commits + pushes so the docs
ride the same PR as the code they describe. Scope is hard-enforced, not just
prompted — `WorktreeManager.revertOutOfScope` reverts any uncommitted edit
outside `CHANGELOG.md`/`README.md`/`docs/**` before the commit. Strictly
best-effort: no documenter routed, an errored/timed-out run (5 min cap), or
a failed commit/push all warn-log and fall through to the normal merge
unchanged — a docs failure never blocks a validated merge. Set
`perTaskDocs: false` to opt a project out entirely.

`EngineEvents.onModelTrouble` (F32, optional) fires when a task's author
model hits trouble: the *first* rate-limit wait for a task (not every
wait — one ping, not spam), every fallback-model switch, and a terminal
failure with no fallback left (`event: "rate_limit_wait" | "fallback" |
"exhausted"`). A rate-limited author run (F6's `classifyFailure`) now
waits and retries the SAME model up to `RATE_LIMIT_RETRIES` (2) times
before falling back — a 5-minute rate limit is often not a
this-model-can't-do-it problem — via `SchedulerDeps.rateLimitWaitMs`
(overridable; production uses the real `RATE_LIMIT_WAIT_MS`, 5 min).
Each wait bumps `task.maxAttempts` in lockstep so it never consumes the
task's real attempt budget; a Pause or Stop press mid-wait bails
promptly instead of sleeping it out. `stuck`/`error` exit reasons are
unaffected — they still escalate to the next fallback model immediately,
same as before F32. `EngineRunner` forwards every `onModelTrouble` event
to both an audit-log entry (`kind: "model_trouble"`) and — gated by the
new `Settings.telegram.modelAlerts` (boolean, default true when unset,
independent of `digest`) — a short Telegram push via the new
`ServerNotifier.modelTrouble`.

`Notification.context` (F22) is `{ prUrl?: string; reasons?: string[] }` —
the same PR link + top validator reasons Telegram's approval message
already carries (`ApprovalContext` in `packages/server/src/telegram.ts`),
computed once in `EngineRunner`'s `requestApproval` and persisted onto the
notification so the web UI can render it too, not just Telegram. Optional
and only ever set on an `action_required` approval notification that has
at least a PR or a reason to show; absent on every other notification kind
and on any row that predates this field.

`POST /api/engine/stop-all` (F23) — the global panic button, one confirmed
tap from anywhere in the app rather than Projects page → per-row action →
repeat. Hard-stops (`drain: false` equivalent) every currently running
project, both the autonomous loop and any in-flight manual dispatch
(`EngineRunner.stopAll`), writes one `"stopped"` audit entry *per* affected
project (not a single global entry — `AuditEntry.projectId` is required
and the Audit tab is per-project, so every affected project's own trail
should show the event; each entry's `detail.affectedProjectIds` lists all
of them), and returns `StopAllResponse.projectIds` — the ones that actually
had something to stop.

Process shutdown (B41) is one idempotent transaction for `SIGTERM`, `SIGINT`,
uncaught exceptions, and unhandled rejections. Admission closes before the
first await; all project runtimes and rollback subprocess signals are stopped
in parallel under one 15-second settlement deadline. Telegram polling and
buffered logs stop next, shutdown audit rows are written, live sockets/HTTP
close, SQLite's WAL is checkpointed, and the DB closes before exit. Signals
exit zero; fatal errors exit nonzero so systemd restarts the service. A
persisted `model_cooldowns` row keeps a rate-limit expiry across restarts.

Telegram control (F49) uses the same `startProject`, `pauseProject`, retry,
stop-all, and settings actions as HTTP. Project arguments resolve only on a
unique case-insensitive name/id prefix. Messages and callbacks require a private
chat whose chat id and callback/message user id both equal the configured id.
Bot API calls have per-request deadlines, bounded retry with capped
`retry_after`, and 4000-character chunking. `HealthResponse.dependencies.telegram`
contains only delivery state/timestamps and a token-redacted last error. A
terminal approval-delivery failure creates a non-blocking web notification; the
original approval remains pending and is eligible for `/pending`/restart resend.

`PlanAttachment` (F27) — `{ name, size, mtime }` for a file uploaded from
PlanView as planning context. Stored on disk at
`<project.localPath>/context/attachments/<name>` (`packages/server/src/
attachments.ts`); `name` is the sanitized, on-disk filename (charset
`[A-Za-z0-9._-]`, extension allowlist `png jpg jpeg gif webp pdf md txt csv
json`, 25MB cap, `-2`/`-3`… suffix on a name collision) — not necessarily
identical to what the user picked. The planner's own prompt gains an
"Attached context files" block listing these paths (relative to its cwd,
which is the project's clone) so it reads them with its own file tools;
empty when there are no attachments. `ENV.mock` roots attachments in a
scratch tmp dir instead of the seed project's real (and here, misleading)
`localPath: "."`, so `npm run mock` stays exercisable without writing into
this repo.

`Settings.guidelines` (F31) — `{ coding?, ux?, security? }`, each a free-text
string capped at 4000 chars on `PUT /api/settings`. Rendered by
`packages/engine/src/guidelines.ts`'s `buildEngineeringStandardsBlock` into
a `## Engineering standards` prompt block used by **both**
`orchestrator.ts`'s author prompt and `validator.ts`'s review prompt — the
same text on both sides, so "meets the standards" is checkable rather than
vibes. `coding`/`security` are always included when set; `ux` only when the
task looks UI-flavored (`task.role === "frontend"`). The validator's prompt
additionally gets one instruction: flag clear violations as reasons (and
lean toward `request_changes` for a substantive one), but don't nitpick
style the standards don't mention. `defaultSettings()` ships real defaults
for all three; blanking a field in Settings removes just that section from
every future prompt. Global only — no per-project override (a future hook,
not built).

F28: every planning session (the existing `planning_messages`/
`planning_prd`/`planning_draft_tasks` DB fields — starts empty, ends when
`/plan/commit` clears it) is also archived as a human-readable markdown
file at `context/plan-sessions/<YYYY-MM-DD-HHmm>.md` (`planning_session_file`
DB column, minted on the first chat turn; suffixed `-2` etc. on a same-
minute collision). Each of the three planning routes rewrites the whole
file from current state — chat appends `## User`/`## Assistant` turns,
deconstruct appends a `## Deconstructed plan` section, commit appends a
final `## Committed` line and clears `planning_session_file` (alongside the
existing messages/prd/draftTasks clear) so the next chat turn starts a
genuinely new file. A failed write never fails the underlying request
(warn-logged and swallowed, same posture as F17's DB backups).

F38: `/plan/deconstruct` also produces `agentsMd` — generated `AGENTS.md`
content (project summary, stack/platform, directory structure, the real
dev/test/build/lint commands matching the scaffold task's actual
`package.json` scripts, stack-specific conventions, "how to work here"
notes — capped ~120 lines, entirely about the project, never about
Hoopedorc's own worktree/PR machinery). Persisted alongside the other
planning_* scratch fields (`planning_agents_md` DB column) so a reload
mid-planning keeps it, and shown in PlanView as an editable textarea next
to the (read-only) PRD preview. At `/plan/commit`, a non-empty `agentsMd`
is committed to the repo root via the same `gitForPlanning.commitFile`
mechanism as the PRD, plus a one-line `CLAUDE.md` containing exactly
`@AGENTS.md` — written only when no `CLAUDE.md` already exists, never
clobbering a hand-maintained one. Rationale: Codex CLI and opencode read
`AGENTS.md` natively; Claude Code only reads `CLAUDE.md`, and `@AGENTS.md`
is its official import syntax for pulling in another file's content — so
every runner ends up seeing the same content with no duplication to drift.
`orchestrator.ts`'s author prompt (`guidelines.ts`'s `buildAgentsMdBlock`)
adds a one-line nudge to read `AGENTS.md` at the repo root whenever the
task's worktree actually has one; F30's per-task documenter is also
allowed to touch `AGENTS.md` (added to `DOCS_ALLOWED_SCOPE`), only when a
merged change actually alters the project's structure/commands/conventions.

## REST API (`@orc/types/api.ts`, `ROUTES`)
Base: `/api`. JSON in/out. Errors use `ApiError`.

| Route | Body → Response |
|---|---|
| `GET /api/health` | → `HealthResponse` (`ok`, version, lifecycle state, safe degraded reasons, Docker availability/requirement) |
| `POST /api/projects` | `CreateProjectRequest` → `CreateProjectResponse` |
| `GET /api/projects` | → `ListProjectsResponse` |
| `GET /api/projects/:id` | → `GetProjectResponse` |
| `POST /api/projects/:id/plan` | `PlanProjectRequest` → `PlanProjectResponse` |
| `POST /api/projects/:id/plan/chat` | `PlanChatRequest` → `PlanChatResponse` |
| `POST /api/projects/:id/plan/deconstruct` | `PlanDeconstructRequest` → `PlanDeconstructResponse` (incl. F38's `agentsMd`) |
| `POST /api/projects/:id/plan/save-draft` | `SaveDraftRequest` → `SaveDraftResponse` |
| `GET /api/projects/:id/plan/session` | → `PlanningSessionResponse` (incl. F38's `agentsMd`) |
| `POST /api/projects/:id/plan/commit` | `PlanCommitRequest` → `PlanCommitResponse` |
| `GET /api/projects/:id/plan/attachments` | (F27) → `ListPlanAttachmentsResponse` |
| `POST /api/projects/:id/plan/attachments` | (F27) multipart file upload → `ListPlanAttachmentsResponse` |
| `DELETE /api/projects/:id/plan/attachments/:name` | (F27) → `ListPlanAttachmentsResponse` |
| `POST /api/projects/:id/start` | → `{ ok }` |
| `POST /api/projects/:id/pause` | `PauseProjectRequest` (optional) → `{ ok }` |
| `POST /api/engine/stop-all` | (F23 — global panic button) → `StopAllResponse` |
| `GET /api/projects/:id/tasks` | → `ListTasksResponse` |
| `POST /api/projects/:id/tasks` | `AddTaskRequest` → `AddTaskResponse` |
| `GET /api/tasks/:id` | → `GetTaskResponse` |
| `PATCH /api/tasks/:id` | `UpdateTaskRequest` → `UpdateTaskResponse` |
| `POST /api/tasks/:id/dispatch` | → `DispatchTaskResponse` |
| `POST /api/tasks/:id/stop` | → `{ ok }` |
| `GET /api/tasks/:id/runs` | → `ListRunsResponse` |
| `GET /api/tasks/:id/decisions` | → `TaskDecisionsResponse` |
| `GET /api/runs/:id/logs` | → `RunLogsResponse` |
| `GET /api/tasks/:id/logs` | `?after=<ISO ts>&limit=<n>` → `TaskLogsResponse` |
| `GET /api/projects/:id/costs` | → `CostsResponse` |
| `GET /api/settings` | → `GetSettingsResponse` |
| `PUT /api/settings` | `UpdateSettingsRequest` → `UpdateSettingsResponse` |
| `GET /api/notifications` | → `ListNotificationsResponse` |
| `POST /api/notifications/:id/respond` | `RespondNotificationRequest` → `{ ok }` |
| `GET /api/setup/models` | → `ModelRosterResponse` |
| `GET /api/setup/model-health` | → `ModelHealthResponse` |

## WebSocket (`@orc/types/ws.ts`, `WS_PATH = /ws`)
Server → client `ServerEvent`: `log`, `task.updated`, `run.updated`,
`project.updated`, `merge.decision`, `notification`, `cost.updated`.
Client → server `ClientEvent`: `subscribe`, `unsubscribe`, `ping`.

Broadcast scoping: `log`/`task.updated`/`run.updated`/`merge.decision`/
`cost.updated` only reach clients currently `subscribe`d to that event's
`projectId` (`LogEvent`/`Run`/`MergeDecision` all carry one). `project.updated`,
`project.deleted`, and `notification` are global — every connected client gets
them regardless of subscription.

## Conventions
- IDs are strings; timestamps are ISO 8601 strings.
- Array-ish DB columns are JSON-encoded (`depends_on`, `acceptance_criteria`,
  `scope_paths`, `reasons`, `options`, `gate`).
- Money is USD floats; tokens are integers.
- The mock server (`npm run mock`) implements all GET endpoints + a synthetic
  `log` stream so the UI is buildable before the real backend exists.
