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

`Notification.context` (F22) is `{ prUrl?: string; reasons?: string[] }` —
the same PR link + top validator reasons Telegram's approval message
already carries (`ApprovalContext` in `packages/server/src/telegram.ts`),
computed once in `EngineRunner`'s `requestApproval` and persisted onto the
notification so the web UI can render it too, not just Telegram. Optional
and only ever set on an `action_required` approval notification that has
at least a PR or a reason to show; absent on every other notification kind
and on any row that predates this field.

## REST API (`@orc/types/api.ts`, `ROUTES`)
Base: `/api`. JSON in/out. Errors use `ApiError`.

| Route | Body → Response |
|---|---|
| `GET /api/health` | → `{ ok, mock }` |
| `POST /api/projects` | `CreateProjectRequest` → `CreateProjectResponse` |
| `GET /api/projects` | → `ListProjectsResponse` |
| `GET /api/projects/:id` | → `GetProjectResponse` |
| `POST /api/projects/:id/plan` | `PlanProjectRequest` → `PlanProjectResponse` |
| `POST /api/projects/:id/start` | → `{ ok }` |
| `POST /api/projects/:id/pause` | `PauseProjectRequest` (optional) → `{ ok }` |
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
