# The Contract

Everything below lives in code in `@orc/types`. This doc is the human-readable
summary. **If you need to change the contract, change `@orc/types` and announce
it — all three modules depend on it.**

## Domain types (`@orc/types/domain.ts`)
`ModelId`, `Role`, `RunnerKind`, `ModelConfig`, `Difficulty`, `TaskStatus`,
`Task`, `Project`, `Run`, `LogEvent`, `GateResult`, `MergeDecision`,
`Notification`, `CostRecord`, `RoutingPolicy`, `Settings`, and the
`pickAssignedModel(routing, difficulty, role?)` helper. Read the file — it is the
source of truth. `Settings.routing` is what the Settings UI exposes as per-job
model selectors (planner, by-difficulty, by-role, validator).

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
| `POST /api/projects/:id/pause` | → `{ ok }` |
| `GET /api/projects/:id/tasks` | → `ListTasksResponse` |
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
