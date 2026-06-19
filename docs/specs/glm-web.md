# Spec — `@orc/web` (assigned: GLM 5.1)

You own the **frontend**: the operator's window into the orchestrator. Work only
in `apps/web/`. Treat `@orc/types` as a fixed, read-only contract, and the API in
`docs/CONTRACT.md` as your backend. You can build entirely against MOCK mode — no
real models needed.

## Setup
```bash
git checkout -b feat/web
npm install
npm run build -w @orc/types
npm run mock          # starts the mock API on :4317 AND the web app on :5173
```
Open http://localhost:5173 — the Round 0 placeholder board is already wired to the
mock API. Build it out.

## What to build
1. **DAG-aware kanban board** — columns by `TaskStatus`
   (Backlog → Ready → In Progress → In Review → Done; plus surface
   `changes_requested`, `blocked`, `failed`). Each card shows title, assigned
   model, difficulty, attempts, and dependency badges. Show dependency links /
   ordering (a small graph or "blocked by" chips). Drag-to-reassign status calls
   `PATCH /api/tasks/:id`.
2. **Live logs** — open the WebSocket at `/ws`, handle `ServerEvent`s, and show a
   streaming per-task / per-run log panel (click a card → live logs). Auto-scroll,
   level coloring.
3. **Settings page** — edit `Settings`: model→role mapping, validator by
   difficulty, merge policy, risky-change rules, budgets, Telegram on/off.
   `GET/PUT /api/settings`.
4. **Cost view** — `GET /api/projects/:id/costs`: total + per-model spend, live
   updates from `cost.updated`.
5. **Notifications / approvals** — list `Notification`s; for `requiresApproval`
   ones, render the `options` as buttons → `POST /api/notifications/:id/respond`.
6. **New project + plan** — form to create a project and trigger planning
   (`POST /api/projects`, `POST /api/projects/:id/plan`); render the returned PRD
   + task list.

## Stack & conventions
- React + Vite + **Tailwind v4** (already configured via `@tailwindcss/vite`).
- Use the types from `@orc/types` for every API payload — no `any` on the wire.
- Centralize fetch + WS in a small `src/api/` client keyed off `ROUTES`.
- Keep it dark, dense, and fast — this is a control room, not a marketing site.
- Suggested libs (your call): `@tanstack/react-query`, `@dnd-kit/core`,
  `zustand`, `react-router-dom`.

## Constraints
- Do not change `@orc/types` or any backend package.
- Everything must work in MOCK mode (degrade gracefully when endpoints 501).
- Match `ServerEvent` / DTO shapes exactly.

## Acceptance criteria
- [ ] `npm run typecheck -w @orc/web` and `npm run build -w @orc/web` pass.
- [ ] Board renders all columns from the API and updates live on `task.updated`.
- [ ] Clicking a task streams its logs over the WebSocket.
- [ ] Settings page loads and round-trips (PUT path can no-op against 501 stub
      but the form must be wired to the real DTO).
- [ ] Approval notification renders its options and posts the choice.
- [ ] No imports from backend package internals (only `@orc/types`).

## Done
Commit to `feat/web`, push, open a PR `web: kanban + live logs + settings`.
