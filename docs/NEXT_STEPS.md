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
