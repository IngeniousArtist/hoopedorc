# Hoopedorc contributor guide

This is the short, durable workflow for humans and coding agents working on
Hoopedorc. Read this file first. Use `docs/PRODUCTIZATION_PLAN.md` when you need
an item's full historical specification, acceptance evidence, or roadmap
context; do not reread the entire plan for routine work.

## Sources of truth

- `AGENTS.md` — day-to-day contribution workflow and project invariants.
- `docs/PRODUCTIZATION_PLAN.md` — approved item specs, ordering, decisions, PRs,
  validation evidence, and deferred work.
- `docs/CONTRACT.md` — shared REST/WebSocket contract and persistence
  conventions.
- `docs/ARCHITECTURE.md` — package boundaries and runtime architecture.
- `docs/USER_GUIDE.md` — operator behavior, deployment, updating, and
  troubleshooting.
- `docs/specs/` — focused designs for features too detailed for the roadmap.

When documentation and code disagree, verify the running code and tests, then
fix the stale documentation in the same PR.

## Required workflow

1. Start from a clean, current `main`.
   - Fetch `origin/main` and verify local `main` is not ahead, behind, or dirty.
   - Never implement directly on `main`.
   - Create one descriptive branch for the approved item or tightly coupled
     group of items.
2. Inspect before designing.
   - Read the relevant roadmap item and focused docs.
   - Trace the real contract, server route, persistence, engine, UI, tests, and
     deployment path affected by the change.
   - Check the installed CLI or runtime behavior instead of guessing flags,
     model IDs, process-manager behavior, or platform details.
3. Write explicit acceptance criteria before implementation.
   - Add or refine the item in `docs/PRODUCTIZATION_PLAN.md` for a meaningful
     behavior change.
   - Keep the scope small enough to review and revert safely.
   - Record dependencies, non-goals, and live checks that cannot be completed
     locally.
4. Change contracts first.
   - `packages/types` is the canonical shared contract.
   - Any route or payload change must update `packages/types/src/api.ts`,
     `ROUTES`, `docs/CONTRACT.md`, server behavior, web usage, and mock behavior.
   - Do not create a UI-only shape that silently differs from the server.
5. Implement the smallest reusable fix at the owning layer.
   - Put pure policy/state logic in a focused module and keep I/O at boundaries.
   - Preserve existing operator data, dirty worktrees, settings, tasks, and
     planning drafts.
   - Do not catch and ignore failures that affect correctness or durability.
   - Do not add a dependency when Node, the browser, or an existing package
     already provides the capability.
6. Add regression coverage.
   - For a bug, reproduce the failure in a test before or alongside the fix.
   - Test success, refusal/error, retry/idempotency, and stale/restart behavior
     where relevant.
   - UI work must cover loading, unavailable/empty, error, confirmation, and
     success states.
7. Verify in proportion to risk.
   - Run focused tests while iterating.
   - Before handoff, run every repository gate listed below.
   - Verify UI behavior in a real browser at phone, tablet, and desktop widths.
   - Exercise the real deployment/process boundary when the change depends on
     Git, systemd, Docker, external CLIs, or filesystem ownership.
8. Finish the audit trail.
   - Update user, architecture, contract, deployment, and roadmap docs affected
     by the behavior.
   - Record exact verification evidence in the PR description and roadmap item.
   - Reference the roadmap ID in commit messages.
   - Push the branch, open a PR, wait for green CI, review the diff/checks, then
     merge. Do not bypass a failed required check.
   - After merge, independently verify the merged commit for substantial waves.

## Repository gates

Run all of these before a PR is considered ready:

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

If a gate cannot run in the current environment, state exactly which gate,
why, and what evidence remains outstanding. A typecheck is not a substitute
for browser verification, and a mock is not a substitute for a required live
systemd/EC2/model smoke test.

## Package and dependency boundaries

```text
packages/types
  Shared domain types, API payloads, route manifest, WebSocket events.

packages/adapters
  Claude Code, Codex, and OpenCode process invocation and output parsing.

packages/engine
  Scheduling, task ownership, worktrees, gates, validation, sandboxing,
  retries, cancellation, merge/rollback policy.

packages/server
  Fastify API, SQLite persistence, planner, Telegram, settings, runtime
  lifecycle, deployment-facing operations. Wires engine and adapters.

apps/web
  React control plane. Talks only through the shared API/WebSocket contract.
```

Every package may depend on `@orc/types`. The engine may depend on adapters.
The server composes the system. The web app must not import server, engine, or
adapter internals.

## Load-bearing invariants

- `main` is sacred: branch → PR → required checks → merge.
- The primary project clone is durable state, not scratch space.
- Planning approval is not complete until the exact PRD, task draft, and
  generated guidance are durably committed and pushed; retries must not create
  duplicate tasks or commits.
- Hoopedorc-owned planning session/attachment files may be handled specially,
  but real unrelated repository changes must never be overwritten or silently
  swept into a commit.
- One project has one scheduler/runtime owner. Manual dispatch joins that
  scheduler instead of creating a competing execution path.
- Process cancellation owns the whole child process group and must settle
  before work is considered stopped.
- Gates fail closed. Missing commands, spawn failures, unreadable diffs, and
  incomplete destructive-change inspection are not passes.
- Work happens in task worktrees; cleanup must not damage the primary clone or
  unrelated nested repositories.
- Approval and rollback actions are explicit, persisted, and restart-aware.
- Settings are normalized once on every read/write path. A run snapshots the
  per-invocation values it needs; live runtime policy changes are applied only
  where documented.
- Model calls are accounted exactly once, including subscription-priced calls
  with zero metered cost.
- Agent subprocesses receive a sanitized allowlist environment. Never expose
  unrelated secrets through inherited environment variables or logs.
- Graceful shutdown first refuses new mutations, then cancels/settles managed
  work, flushes state, checkpoints SQLite, and only then exits.
- The deployment updater must refuse dirty/diverged checkouts, use
  `git pull --ff-only`, avoid active project runs, and restart only the
  `hoopedorc.service` whose exact `WorkingDirectory` matches the current
  checkout.

## API and persistence checklist

For a REST change:

1. Add request/response types in `packages/types/src/api.ts`.
2. Add the canonical method/path to `ROUTES`.
3. Register the exact route in `packages/server/src/index.ts`.
4. Implement the mock-safe behavior.
5. Consume it through `apps/web/src/api/client.ts`.
6. Update `docs/CONTRACT.md`.
7. Add server/policy tests and web contract/interaction tests.

For SQLite changes:

- Add an idempotent migration in `packages/server/src/db/index.ts`.
- Update `schema.sql` for fresh databases and migrations for existing ones.
- Keep related state transitions in one SQLite transaction.
- Preserve old rows and make startup recovery idempotent.
- Add indexes/constraints for exactly-once or uniqueness guarantees rather
  than relying only on application timing.

## Engine and Git guidance

- Use argument arrays (`execFile`/spawn), never shell strings containing
  external values.
- Treat branch names, paths, model slugs, task text, and repository content as
  untrusted input at process/filesystem boundaries.
- Reuse `GitServiceImpl` and typed Git results instead of adding ad hoc Git
  shell plumbing in routes.
- Never stash, reset, force-push, delete, or auto-commit unrelated operator
  changes.
- Every retry path must be idempotent and must preserve enough durable state to
  continue after a server restart.
- Keep repository-owned setup/gates separate from host-run authenticated agent
  CLIs; see `docs/specs/sandbox.md` before changing that boundary.

## UI guidance

- Follow the existing neutral visual system unless `brand.md` is activated.
- Use real semantic controls with visible keyboard focus and at least 40px
  touch targets on phone layouts.
- Long actions show immediate in-control progress and prevent duplicate
  submission.
- Dangerous or disruptive actions use an inline confirmation/dialog; never
  `alert()` or `confirm()`.
- Show actionable inline errors and preserve the user's work.
- Do not hide unavailable actions when explaining why they are unavailable is
  useful; disable them and show the reason.
- Check 360, 390, 768, 1280, and 1440px widths. Avoid document-level
  horizontal overflow and keep fixed/sticky surfaces inside the viewport.
- Update or add Vitest interaction tests and Playwright coverage for important
  flows.

## Deployment guidance

- Production runs the prebuilt server through `deploy/hoopedorc.service`;
  Tailscale Serve proxies the same local port.
- Build before restart. Do not make service startup rebuild the workspace.
- Keep the service user identical to the user that owns the checkout and CLI
  authentication.
- `scripts/update.sh` is the canonical update path. Extend its protections
  instead of creating a second update implementation.
- Any UI-triggered update must run outside `hoopedorc.service`'s control group
  so restarting the app cannot kill the updater halfway through.
- Never accept a client-supplied command, branch, path, unit name, or update
  argument.

## Common traps

- Coding on `main` or merging before CI is green.
- Updating only the TypeScript type but not `ROUTES`, docs, mock, and UI.
- Swallowing Git/persistence/cleanup errors and reporting success.
- Starting a second engine path for a convenience endpoint.
- Assuming a CLI model slug or command flag from marketing names.
- Considering generated files in the primary clone disposable.
- Running destructive cleanup against a path that was not revalidated.
- Treating a responsive screenshot as proof that touch targets, focus, and
  interaction states work.
- Editing historical completion notes in the roadmap without preserving the
  evidence trail.
