# The Contract

Everything below lives in code in `@orc/types`. This doc is the human-readable
summary. **If you need to change the contract, change `@orc/types` and announce
it — all three modules depend on it.**

## Domain types (`@orc/types/domain.ts`)
`ModelId`, `Role`, `RunnerKind`, `ModelConfig`, `Difficulty`, `TaskStatus`,
`Task`, `Project`, `ProjectConfig`, `Run`, `LogEvent`, `GateResult`, `MergeDecision`,
`Notification`, `CostRecord`, `RoutingPolicy`, `Settings`, and the
`pickAssignedModel(routing, difficulty, role?)` helper. Read the file — it is the
source of truth. `Settings.routing` is what the Settings UI exposes as per-job
model selectors (planner, by-difficulty, by-role, validator).

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

`ModelConfig.quota` (F16) declares a subscription's rolling usage window —
`windowHours` plus at least one of `maxRuns`/`maxCostUsd` (enforced on
`PUT /api/settings`, a quota with neither set means nothing). When
configured, the scheduler skips dispatching that model once its window's
run count or spend is reached — cross-project, since a subscription's cap
belongs to the model's API key/plan, not any one project — the same
skip-don't-fail treatment as budget/cooldown checks.

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

## REST API (`@orc/types/api.ts`, `ROUTES`)
Base: `/api`. JSON in/out. Errors use `ApiError`.

| Route | Body → Response |
|---|---|
| `GET /api/health` | → `{ ok, mock }` |
| `POST /api/projects` | `CreateProjectRequest` → `CreateProjectResponse` |
| `GET /api/projects` | → `ListProjectsResponse` |
| `GET /api/projects/:id` | → `GetProjectResponse` |
| `POST /api/projects/:id/plan` | `PlanProjectRequest` → `PlanProjectResponse` |
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
