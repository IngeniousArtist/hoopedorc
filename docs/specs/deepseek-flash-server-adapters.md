# Spec — `@orc/server` + `@orc/adapters` (assigned: Deepseek v4 Flash)

You own two packages: the **backend API + persistence** and the **model runner
adapters**. Work only in `packages/server/` and `packages/adapters/`. Treat
`@orc/types` as a fixed, read-only contract.

## Setup
```bash
git checkout -b feat/server-adapters
npm install
npm run build -w @orc/types
```

## Part A — `@orc/adapters`
Implement the two adapters stubbed in `packages/adapters/src/index.ts`.

1. **ClaudeAdapter** — spawn `claude -p "<prompt>" --output-format stream-json`
   in `opts.cwd`, stream each JSON line to `opts.onLog`, honor `opts.signal`
   (kill the child on abort), and parse final cost/tokens from the result event.
   Uses the existing Claude Code login (Pro sub) — no API key.
   *(Optional upgrade: use `@anthropic-ai/claude-agent-sdk` instead of spawning.)*
2. **OpenCodeAdapter** — POST to the running `opencode serve` HTTP API at
   `this.baseUrl`, selecting `this.opencodeModel`. Stream output to `onLog`,
   honor `signal`, return cost/tokens. Confirm the exact endpoints with
   `opencode serve --help` and the OpenCode docs; isolate them in one client file.
3. Keep `makeAdapter` working as the single entry point.

## Part B — `@orc/server`
Replace the 501 stubs in `packages/server/src/index.ts` with real handlers backed
by SQLite, implementing every route in `ROUTES` (see `docs/CONTRACT.md`).

1. **Persistence** — a repository layer over `better-sqlite3` using the schema in
   `src/db/schema.sql`. Map rows ↔ `@orc/types` objects (JSON-decode the array
   columns). Provide CRUD for projects, tasks, runs, logs, merge_decisions,
   costs, notifications, settings. (`initDb` already applies the schema.)
2. **Endpoints** — implement create/get/list project, plan (calls the planner via
   ClaudeAdapter — can return a stub plan first), start/pause (delegate to the
   engine once wired), tasks list/get/update, dispatch/stop, runs, run logs,
   costs (aggregate the `costs` table), settings get/update, notifications.
3. **WebSocket hub** — a broadcaster that pushes `ServerEvent`s to connected
   clients (`log`, `task.updated`, `run.updated`, `merge.decision`,
   `notification`, `cost.updated`). Persist logs as they stream.
4. **Cost tracking + budget caps** — accumulate `CostRecord`s from adapter
   results; expose via `/api/projects/:id/costs`; emit `cost.updated`; stop a run
   when a model's `monthlyBudgetUsd` or the project `budgetUsd` is exceeded.
5. Keep **MOCK mode working** (it's how the frontend developer builds the UI).
6. For the bundled build, make `schema.sql` resolvable (copy into `dist/db/` via
   a tsup `onSuccess` or `loader`), or inline the SQL as a string.

## Constraints
- Implement endpoints exactly as `ROUTES` declares; do not invent paths.
- All realtime payloads must match `ServerEvent` types exactly.
- Engine wiring (`start`/`pause` → `@orc/engine`) can be a thin call site; if the
  engine PR isn't merged yet, guard it behind a feature check and keep MOCK green.

## Acceptance criteria
- [ ] `npm run typecheck -w @orc/server` and `-w @orc/adapters` pass.
- [ ] `npm run mock` still serves the board + log stream.
- [ ] `npm run db:init` creates all tables; a round-trip test inserts and reads a
      project + task with correct JSON decoding.
- [ ] Real (non-mock) server serves `GET /api/projects` from SQLite.
- [ ] `OpenCodeAdapter.run` streams tokens from a real `opencode serve` for one
      cheap model (e.g. deepseek-flash) and returns cost > 0.
- [ ] No imports from `@orc/engine`'s internals beyond its public exports; no
      imports from `@orc/web`.

## Done
Commit to `feat/server-adapters`, push, open a PR `server+adapters: persistence,
API, model runners`.
