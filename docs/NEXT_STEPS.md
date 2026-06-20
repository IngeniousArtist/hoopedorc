# Resume here

## ✅ 2026-06-20/21 — FIRST REAL END-TO-END RUN SUCCEEDED

A true autonomous run with real models, through the actual app, now works. On a throwaway repo
(`IngeniousArtist/hoopedorc-test-run`, private) the orchestrator drove one task all the way:
**author (deepseek-flash) → commit → push → open PR → gates (typecheck/lint/build/tests/
noConflicts/inScope) → validator (deepseek-pro, approve @0.95) → auto-merge → done.** PR #2 was
squash-merged to `main` (commit `3e3ab8e9`), branch auto-deleted. Total cost: **$0.0034**, under
the $2 project budget cap. Getting there required finding + fixing **3 new real bugs** (below) —
the first 3 runs each failed on a different one, which is exactly why a real run mattered.

### New bugs found + fixed this session (all uncommitted)
1. **Agents wrote to the wrong directory** (`packages/adapters/src/index.ts`). `child_process.spawn`'s
   `cwd` option sets the child's real cwd but does NOT update the inherited `$PWD` env var, and
   `opencode run` resolves its working dir from `$PWD`. So every author/validator ran in the
   *server's launch directory* (this repo) instead of the task worktree — writing files here and
   leaving the worktree empty (→ "No commits between main and <branch>" on `gh pr create`).
   Verified by isolating the spawn: file landed in the launcher's cwd, not the spawn cwd; setting
   `env: { ...process.env, PWD: opts.cwd }` fixed it. Applied to BOTH adapters.
2. **`noConflicts` gate always failed for clean branches** (`packages/engine/src/gate-runner.ts`).
   It did `git merge --no-ff origin/main` then `git merge --abort` inside the same try. For a branch
   simply ahead of main, the merge says "Already up to date" (exit 0, no merge state), so the abort
   throws "no merge to abort" → caught → returned false → gate reported a conflict on every clean
   task. Rewritten: merge success = no conflict; abort moved to a tolerant cleanup step.
3. **Clones/worktrees lived inside the orchestrator repo** (`config.ts` + `index.ts`). `localPath`
   defaulted to `.hoopedorc/repos/<id>` (relative, inside this working tree). Now an absolute,
   out-of-tree `ENV.reposDir` (default `~/.hoopedorc/repos`, override `REPOS_DIR`). This is correct
   hygiene regardless of bug #1 (worktrees must not nest inside another git repo).

Plus a defensive guard in `orchestrator.ts`: if the author produces no committed changes, fail
fast with a clear message instead of the cryptic `gh` error (this is how bug #1 surfaced cleanly
on run 2). And the **budget-enforcement gap is now closed** — see the (struck-through) item below.

### Test harness (kept, reusable)
- `packages/server/scripts/seed-e2e.ts` — seeds one project + one tiny "easy" task directly into a
  DB (bypasses the money-costing planner). Run: `DB_PATH=<abs> npx tsx packages/server/scripts/seed-e2e.ts`.
- `.hoopedorc/watch-e2e.sh` (gitignored) — `PID=.. TID=.. bash .hoopedorc/watch-e2e.sh` triggers
  `/start` and polls to a terminal state.
- To re-run: the test repo's `main` now has `src/isEven.js`; reset it (revert the merge) or use a
  different task so the new branch isn't a no-op.

---

# Roadmap / planned features

**Decisions captured 2026-06-21 (from the user):**
- **Planning UX:** chat-to-draft → editable task table → approve (build *both* the chat and the table).
- **Planning models (two-tier):** **Sonnet** drives the conversational planning/chat (many cheap
  turns); **Opus** does the one-shot deconstruction of the agreed plan into the task DAG + model
  assignments (high-leverage, quality-critical). Handoff: Sonnet → natural-language plan/PRD; Opus →
  strict JSON DAG (difficulty, deps, scope, acceptance criteria, assigned model). NOTE: Opus on the
  Pro sub is usage-limited — keeping it to the single deconstruction call (not the chat) stays well
  under the cap; fall back to Sonnet for deconstruction if ever throttled.
- **Telegram:** full scope — remote approvals + status/cost summaries + two-way commands.
- **Deployment target:** always-on server (EC2), reachable **only over Tailscale** (no public
  ingress) — so app-level auth is optional; lock the EC2 security group to the tailnet.
- **Build first:** (1) planning chat in the web UI, (2) GitHub repo creation in New Project +
  verifying the full `npm run dev` UI flow end-to-end.

> Status note: the autonomous engine (author → gates → validator → auto-merge) is **verified
> working** with real models on a throwaway repo. The one path still unverified through the real
> app is the web UI **New Project → Plan → Start** flow, specifically the Claude **planner** step
> (it was deliberately bypassed in testing). Verifying it is folded into P0 #2 below.

## P0 — build first

### 1. Planning: chat with Claude → editable task table → approve
**What:** Replace the one-shot New Project flow with: enter a goal → a **chat panel** where Claude
(the planner model) proposes a plan and you refine it conversationally ("split that task", "add
tests", "don't touch the DB") → the agreed plan renders as an **editable task table** (add / remove /
reorder; edit title, description, difficulty, assigned model, scope paths, acceptance criteria,
dependencies) → **Approve** materializes the Task rows → Start.

**Why:** today's `POST /api/projects/:id/plan` is single-shot and non-deterministic; a non-expert
needs to shape scope (and therefore cost) before spending real money.

**Two-tier model design (see decisions above):** chat turns → **Sonnet**; final deconstruction of
the agreed plan into the JSON task DAG + assignments → **Opus**.

**How (sketch):**
- Backend: add a multi-turn planning endpoint, e.g. `POST /api/projects/:id/plan/chat` taking
  `{ messages[] }` and returning `{ reply, proposedPlan }`. The chat turns use **Sonnet**; when the
  user approves, a final **Opus** call deconstructs the agreed plan into the strict task DAG. Keep
  the proposed plan as a *draft* (new `plan_drafts` table, or `status: "proposed"` tasks not yet
  scheduled). Add `POST /api/projects/:id/plan/commit` to turn the approved draft into real Task
  rows (status `ready`/`backlog` by deps) — reuse the materialization already in `/plan`.
- **Prerequisite — Claude adapter needs model selection.** `ClaudeAdapter` currently spawns
  `claude -p …` with **no `--model` flag**, so it can't target Sonnet vs Opus. Add a model id to the
  claude `ModelConfig` (e.g. `claudeModel: "claude-sonnet-4-6"` / `"claude-opus-4-8"`) and pass
  `--model` in the spawn args. Then define two `runner: claude-code` configs (one Sonnet, one Opus)
  and route planner-chat → Sonnet, planner-deconstruct → Opus. Files: `packages/adapters/src/index.ts`,
  `packages/types` (ModelConfig), `packages/server/src/config.ts` (default roster + routing).
- Show per-turn cost in the chat so refining a plan doesn't quietly add up.
- Frontend: chat panel + editable task table on the New Project page.
- Watch the planner's working dir: `runPlanner` runs in `tmpdir()` and only generates text, but if
  it starts reading the repo for context, set `PWD` like the adapters now do (see fix #1 above).
- Files: `packages/server/src/planner.ts`, `…/index.ts` (routes), `packages/types` (DTOs),
  `apps/web` New Project page.

### 2. Create a GitHub repo from New Project (+ verify full UI flow)
**What:** New Project offers **"use existing repo URL"** *or* **"create a new private repo for me"**
→ backend runs `gh repo create <name> --private --add-readme`, sets it as `project.repoUrl`.

**Why:** user wants to start from nothing and have the project synced to a fresh repo.

**How:** extend `POST /api/projects` with `{ createRepo, repoName }`; on create, shell `gh repo
create` (gh is authed), seed a minimal `package.json` so gates pass on the first task (or let a
scaffold task do it), then proceed as normal. Frontend: a toggle in the New Project form. Then run
the real `npm run dev` UI path (New Project → chat plan → Start → auto-merge) on the throwaway repo
to close the last unverified gap. Files: `…/index.ts` (POST /api/projects), `git-service.ts`
(optional `ensureRepo`), `apps/web`.

## P1

### 3. Telegram — approvals + status/cost + two-way commands
- **Approvals:** when the engine calls `events.requestApproval` (risky merge, escalation, attempts
  exhausted), also push to Telegram with inline Approve/Reject buttons; the bot callback resolves
  the *same* pending approval via `EngineRunner.resolveApproval` (the UI already does this through
  `POST /api/notifications/:id/respond` — Telegram is a second channel into the same resolver).
- **Status/cost:** push on task start/finish/merge/failure + budget alerts; periodic run summaries
  (Grok already has `roles: ["updates"]` in config).
- **Two-way commands:** start/pause a project, add a task, check status/cost by messaging the bot.
- **How:** a bot (telegraf/grammY or raw Bot API) in the server process; `settings.telegram`
  (already exists, `{ enabled: false }`) holds bot token + allowed chat id. Map `notification.id`
  ↔ Telegram message for callback resolution. **Restrict to the configured chat id** — approvals
  merge real code. Files: new `packages/server/src/telegram.ts`, wire into `EngineRunner` events.

### 4. Cost / token analytics + pre-run estimates
**What:** a Costs dashboard — tokens + $ per model, over time, per project/task; budget burn rate +
projection ("at this rate you'll hit your $X cap in ~N tasks"); a **pre-run estimate** for a task or
whole plan. **Why:** user asked for estimates; cost tracking is now accurate (fix #3, prior session).
**How:** the `costs` table already records per-run `costUsd`/`tokensIn`/`tokensOut`/`model`/`ts`. Add
time-series + per-model/per-project aggregation endpoints (build on `getCostSummary` /
`getGlobalMonthlyCost`); estimate from rolling per-model $/token averages × expected task size.
Files: `repo.ts`, `index.ts`, `apps/web` Costs page.

## P2 — suggested (not yet prioritized)
- **Audit log** — persist every merge decision + approval (who/what/when/why) + run; PRD requires
  it. `merge_decisions` holds verdicts today; extend to a full trail + a UI timeline.
- **One-click rollback** — wire the engine's existing `git-service.revertMerge` to a UI button +
  endpoint for when an auto-merge goes wrong.
- **Setup / health check page** — verify `gh`, `claude`, and each `opencode` model's auth show green
  before spending money.
- **Retry / replay a failed task** from the UI; **PR diff viewer** (gh pr diff / GitHub API).
- **Optional "wait for GitHub Actions/CI"** gate before merge (gates currently run locally only).
- **Custom gates per project** — configure which npm scripts count as gates (repos vary).
- **Scheduled / cron runs** — recurring maintenance or timed runs (enabled by always-on EC2).

## Always-on (EC2) deployment notes
Target is a 24/7 box reachable **only over Tailscale**, so plan for: process supervision
(systemd/pm2) + restart-on-crash; persistent SQLite (back it up, or move to a managed DB);
provisioning `gh` / `claude` / `opencode` auth on the box; env for ports. The budget rail added this
session matters most here (unattended spend). Telegram is genuinely useful once the server is always
up.

**Networking (Tailscale):** the EC2 sits on the tailnet, so **no public ingress** — app-level auth is
optional. Lock it down: the EC2 **security group must NOT open the app/web ports to `0.0.0.0`** —
allow only the tailnet (and SSH over Tailscale). Bind the server to the tailscale interface / `100.x`
address (or rely on the SG). Anyone on one of your tailnet devices can reach it; for a solo dev that's
acceptable, so app auth stays optional rather than required.

---

# Earlier (verification session, 2026-06-19/20)

You asked me to check whether the orchestrator actually works. Summary: build/typecheck/tests
all pass, and the web UI was fully broken (black screen) due to a real bug — now fixed. Found
and fixed 3 real bugs. A true end-to-end run with real models has **not** been done yet — that's
the next step, and it costs real money + touches a real GitHub repo, so I stopped to confirm
how you want to run it before going further.

## Bugs found + fixed this session (uncommitted — review and commit when ready)

1. **Web UI black screen** (`apps/web/src/hooks/useWS.ts`) — the `useWS` cleanup called
   `ws.send(...)` unconditionally on unmount. In React StrictMode (dev), effects double-fire and
   the cleanup ran while the WebSocket was still `CONNECTING`, throwing `InvalidStateError`
   uncaught → React unmounted the whole tree → black screen, on every page load. Fixed by only
   sending if `ws.readyState === WebSocket.OPEN`. Verified via agent-browser: Board/Settings/
   Costs/Notifications/New Project all render cleanly now with zero console errors.

2. **Hard tasks could never merge** (`packages/server/src/config.ts`) — the default routing had
   `byDifficulty.hard = "deepseek-pro"` (author) and `validatorByDifficulty.hard = "deepseek-pro"`
   (validator) — the same model. `validator.ts` correctly throws "self-review is forbidden" when
   author === validator, so every hard-difficulty task with no role override would fail on its
   first validation attempt, every time. This mirrors a real contradiction in `docs/PRD.md`'s
   model table, which lists Deepseek Pro as both "Hard tasks" implementer AND "primary
   validator/merger" — those can't be the same task. Fixed by setting
   `validatorByDifficulty.hard = "glm"` (GLM already has the `validator` role). Confirmed via the
   Settings UI that Hard/Author now shows Deepseek v4 Pro and Hard/Validator shows GLM 5.1.

3. **Cost/token tracking was always $0** (`packages/adapters/src/index.ts`,
   `OpenCodeAdapter.handleEvent`) — it read `obj.cost`/`obj.usage` at the top level of each
   `opencode run --format json` event, but real output nests everything under `obj.part`
   (`part.cost`, `part.tokens.{input,output}`), and each `step-finish` part is **per-step**, not
   cumulative. Verified directly: ran `opencode run -m deepseek/deepseek-v4-flash --format json`
   with both a single-turn and a tool-using multi-step prompt and inspected the real JSON. Fixed
   to read from `part` and **accumulate** cost/tokens across steps instead of overwriting. This
   matters because cost tracking + budget caps is explicit v1 PRD scope and was silently
   reporting $0 for every OpenCode-run task.

   I also separately verified the **Claude adapter's** stream-json parsing
   (`ClaudeAdapter.handleEvent`) against real `claude -p --output-format stream-json` output —
   that one was already correct (`obj.message.content[].text`, `obj.total_cost_usd`,
   `obj.usage.input_tokens/output_tokens` all match real output exactly). No change needed there.

All three fixes are rebuilt (`npm run build`) and the engine unit tests still pass
(`npm test -w @orc/engine`, 2/2 green). Changes are **uncommitted** — `git status` will show:
- `apps/web/src/hooks/useWS.ts`
- `packages/server/src/config.ts`
- `packages/adapters/src/index.ts`

## What's verified working

- `npm run build` — clean across all 5 workspaces
- `npm run typecheck` — clean
- `npm test -w @orc/engine` — 2/2 (DAG→merge ordering; risky-change→escalate)
- Mock mode (`npm run mock`): server boots, web UI loads and renders Board/Settings/Costs/
  Notifications/New Project with no console errors (verified visually via agent-browser
  screenshots)
- CLIs present & authenticated: `gh` (logged in as IngeniousArtist), `claude` (Pro sub, logged
  in), `opencode` (5 credentials: OpenRouter, Z.AI, DeepSeek, xAI, OpenCode Zen)
- `opencode models` confirms all 5 `opencodeModel` ids in `config.ts` are real, exact matches —
  they were marked "PLACEHOLDER" in a stale comment but were actually already correct. Comment
  fixed.
- Real model smoke tests (outside the app, via raw CLI in a scratch dir) confirm both adapters'
  event-parsing assumptions, as described above.

## What's NOT verified — the actual next step

**A true end-to-end run with real models, through the actual app (not raw CLI), has not been
done.** This is what's left to "try out a test project." Doing this for real means:

- The engine needs an actual GitHub repo to push branches to and open/merge PRs on
  (`packages/engine/src/git-service.ts` uses `gh pr create` / `gh pr merge` — no repo, no PRs).
- Real model runs cost real money. A trivial single "hello world" Claude call alone cost ~$0.22
  in my smoke test (mostly cache-creation tokens from loaded context/skills) — a real coding task
  with multiple attempts + a validator pass will cost more per task.
- Once you call `/api/projects/:id/start`, the engine's autonomous scheduling loop takes over and
  can auto-merge to that repo's `main` without asking, per the "hard gate + flag-risky" policy —
  that's by design (see `[[project-hoopedorc]]` memory), but worth knowing going in.

When you're ready, here's the concrete path:

1. **Pick/create a throwaway repo.** Either tell me a repo URL you already have, or have me run
   `gh repo create hoopedorc-test-run --private --clone` to make a fresh one.
2. **Start the real (non-mock) app:**
   ```bash
   npm run dev   # types, adapters, engine, server, web all in watch mode, server on :4317 real mode
   ```
   (no `.env` needed — `DEEPSEEK_API_KEY`/`GLM_API_KEY`/`OPENROUTER_API_KEY` in `.env.example` are
   unused by the code; all model auth goes through `opencode auth` / `claude` login, both already
   set up on this machine.)
3. Open `http://localhost:5173`, go to **New Project**, point it at the test repo, give it a small
   first task (e.g. "add a one-line utility function + a test for it") so cost stays near-zero on
   this first real run.
4. **Plan** → **Start**, and watch the Board + live logs as it dispatches to a worktree, runs
   gates, runs the validator, and (if it passes) opens + auto-merges a PR.

## Known gaps vs. `docs/PRD.md` v1 scope (found while reading the code, not yet fixed)

- ~~**Budget caps / auto-stop is not enforced in the autonomous run loop.**~~ **FIXED
  (2026-06-20).** `checkBudget()` was extracted into a shared `packages/server/src/budget.ts`
  (single source of truth) and wired into the engine via a new optional `SchedulerDeps.checkBudget`
  hook. The autonomous loop (`orchestrator.ts`) now consults it (a) before dispatching each ready
  task — once every ready task is budget-blocked and nothing is in flight, the run winds down — and
  (b) before each retry attempt, so a multi-attempt task stops mid-flight and is left in `backlog`
  to resume once budget is raised. Also fixed a real bug in the old global-monthly check: it called
  `getCostSummary(db, projectId)` (single-project, all-time), so the "global monthly budget" was
  neither global nor monthly — now uses a new month-scoped, all-projects `getGlobalMonthlyCost()`.
  Covered by a new engine unit test ("a budget cap stops the autonomous loop…"); 3/3 engine tests
  green, build + typecheck clean.
- **No audit log.** PRD says "Report: costs, audit log, and status summaries." Costs ✓ (now
  actually accurate, see fix #3 above). Audit log: no table, no endpoint — nothing persists a
  trail of merge decisions/approvals beyond what's in task/run rows. Status summaries (Grok) are
  also not wired up yet (expected — that's Round 3/Telegram territory per
  `[[project-hoopedorc]]` memory, not urgent).
- Stuck-task detection **does** exist and looks correct (`STUCK_DETECTION.idleMs` timeout in
  `orchestrator.ts`), so that part of the v1 safety story is fine.

## If you want me to just pick this up autonomously tomorrow

Tell me which repo to use (or say "create one") and I'll run the real end-to-end test, watch it
closely, and report back — I won't leave it running unattended on a real repo without checking in
first, given the budget-enforcement gap above.
