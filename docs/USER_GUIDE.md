# User Guide

This doc is for using Hoopedorc, not building it — see the main
[README](../README.md) and [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) if you
want the contributor/internals view instead.

## What it is

Hoopedorc is a self-hosted orchestrator that runs a small team of AI coding
models against one of your GitHub repos at a time. You describe what you
want in a planning chat; Claude turns that into a dependency-ordered list of
tasks; then specialist models (whichever you've configured — by default GLM,
Deepseek Pro/Flash, Grok, Nex) implement each task in its own isolated git
worktree and branch, in parallel where the tasks don't overlap.

Before anything merges to `main`, it has to clear objective gates
(typecheck/lint/build/tests/no-conflicts/in-scope) and a review from a
separate validator model that never authored the change it's reviewing. If
everything passes and nothing looks risky, it auto-merges without asking
you. If something looks risky — a DB migration, a new dependency, a change
outside the task's declared scope — it stops and asks, over the web UI and
(optionally) Telegram, instead of merging blind.

It's built for one specific kind of user: someone who already pays for
several of these model subscriptions and wants to point a team of them at a
real repo and let it run unattended for a while, with real safety rails and
a way to step in — pause, stop a task, add a task mid-run, roll back a
merge — rather than either babysitting every diff or trusting a black box.

## Install & prerequisites

- **Node >= 20** (22 recommended), and a GitHub account with the
  [`gh` CLI](https://cli.github.com/) installed and logged in
  (`gh auth login`, then confirm with `gh auth status`).
- **Claude** — Hoopedorc drives `claude` (Claude Code) directly, so it uses
  whatever you're already logged into (Pro/Max subscription, or an API key
  via `claude`'s own config). It plans every project and reviews every
  merge by default, so it's not optional the way the specialist models are.
- **The specialist models** all run through [OpenCode](https://opencode.ai)
  (`opencode` CLI), so you only need to authenticate once per provider, not
  once per app:
  ```bash
  opencode auth login
  ```
  and follow the prompts for whichever of these you actually hold a
  subscription/API credits for — the default roster is Z.AI (GLM), DeepSeek
  (Deepseek Pro/Flash), xAI (Grok), and OpenRouter (Nex, a free-tier model —
  no paid account needed for that one specifically). You don't need all of
  them: disable whichever you don't have from Settings → Models, and
  re-point the routing at what's left (Settings → Routing, or the
  onboarding wizard's routing step).
- **Codex (optional)** — if you'd rather have a model run through OpenAI's
  own [Codex CLI](https://developers.openai.com/codex) than pay per-token
  through OpenCode, install it and log in with your ChatGPT plan:
  ```bash
  npm i -g @openai/codex
  codex login
  ```
  then in Settings → Models add (or edit) a model with runner `codex` and
  an optional `codex exec -m` id (blank uses the CLI's default model).
  Codex is subscription-billed the same way Claude is — Hoopedorc can't see
  into that spend, so codex-runner tasks always show **$0.0000** in cost
  views (real token counts still show; they're just not priced). Use the
  model's **quota** (max runs per window) rather than a cost cap to keep it
  in check, since a dollar cap can never trigger for a run that costs $0.
- Run `npm install && npm run setup` from the repo root — `setup` creates
  `.env` from `.env.example` if you don't have one yet, and checks all
  three CLIs (`gh`/`claude`/`opencode`) for you.

Then `npm run dev` (all packages in watch mode) or `npm run start`
(production-style: build everything, run one server that also serves the
web UI). See [`deploy/`](../deploy/) for systemd/Docker notes if this is
going on a always-on box.

## Your first project

1. Open the web UI (`http://localhost:5173` in dev, or wherever `npm run
   start` is listening). A brand-new install routes you into a short
   onboarding wizard first (tool checks, model roster, routing defaults,
   optional budget/Telegram) — finish that once, then **New Project**.
2. Either point it at an existing repo URL, or let it create a fresh
   private GitHub repo for you.
3. **Plan**: describe what you want in the chat panel. The planner model
   (Sonnet by default) will ask clarifying questions and propose a plan —
   refine it conversationally ("split that into two tasks", "don't touch
   the database", "add tests"). When you're happy, approving it runs one
   more call on the same planner model that deconstructs the agreed plan
   into a real task list: each task's
   description, difficulty, which model will author it, its acceptance
   criteria, its allowed file scope, and its dependencies on other tasks.
4. **Review the table.** Every field is editable before you commit —
   reassign a task to a different model, tighten its scope paths, add or
   remove acceptance criteria, reorder dependencies. Nothing runs yet.
5. **Start.** The Board fills with cards moving through
   Backlog → Ready → In Progress → In Review → Done (or Blocked/Failed).
   Click any card for the full detail drawer: logs, gate results, the
   validator's verdict and reasons, the PR link. The mission-control strip
   above the board shows every currently-active agent, budget burn, and any
   pending approvals at a glance.
6. **Approvals**, if any come up (a risky change, or the merge policy is set
   to always ask), show up as `action_required` in Notifications, and — if
   you've set up Telegram (Settings → Telegram, needs a bot token from
   [BotFather](https://t.me/BotFather) and your chat id) — as a message with
   inline Approve/Reject buttons, the PR link, and the validator's top
   reasons, so you can decide from your phone without opening the app.
   Settings also offers **browser notifications** (Settings → Browser
   Notifications) — these only work over HTTPS or `localhost` (a browser
   security requirement) and on some mobile browsers can't fire at all even
   with permission granted; Telegram is the reliable channel for phones and
   for the recommended remote setup (see below).
7. When a task finishes, its PR is already merged (or waiting on you, per
   the above). You can **Retry** a failed task, **Rollback** a merged one
   (reverts the merge commit), or **Stop** a task that's still running.

## The safety model

- **Gates.** Every task's change must pass typecheck, lint, build, and
  tests (whichever your repo has — see below on "vacuous" gates), plus two
  Hoopedorc-specific checks: no merge conflicts with the current default
  branch, and no files touched outside the task's declared scope paths.
  Per-project overrides (different script names, a non-npm test command, or
  skipping a gate) are available under **New Project → Advanced** or a
  project's header — see `docs/PRODUCTIZATION_PLAN.md`'s F9 entry.
- **The validator.** A separate model (never the one that authored the
  change) reviews the diff against the task's acceptance criteria and
  returns approve / request changes / escalate, with a confidence score.
  Below `Settings.confidenceThreshold` (0.7 by default) always escalates to
  you, regardless of the merge policy.
- **Risky-change rules.** Even with clean gates and a confident approval,
  a change gets flagged for your approval instead of auto-merging if it
  touches: DB/schema files, `package.json` (new dependencies), anything
  that looks like auth/secrets/tokens, or files outside the task's declared
  scope. Toggle these independently in Settings → Merge Policy.
- **Destructive-change rail (non-bypassable).** Mass file deletions,
  deleted migration/schema/`.env`/CI/lockfile files, destructive SQL
  (`DROP TABLE`/`DROP DATABASE`/`TRUNCATE`, a `DELETE` with no `WHERE`, an
  empty-filter `deleteMany()`), or an `rm -rf` targeting somewhere outside
  the repo/tmp always force your approval before merging — **even under
  `fully_autonomous`**. Unlike the other risky-change rules, this one isn't
  something merge policy can bypass; it's the floor. The validator model is
  separately instructed to escalate (never approve) anything in this same
  category it spots in the diff, and every author prompt carries a fixed
  safety instruction not to delete unrelated files or write destructive
  migrations/data-wipes unless the task explicitly requires it. Toggle it
  off in Settings → Merge Policy → Risky Change Rules → "Destructive
  changes" if you genuinely want to disable the mechanical check (the
  validator's own judgment and the author's prompt instruction still apply
  either way).
- **Merge policy** (global in Settings, optionally overridden per-project):
  `hard_gate_flag_risky` (default — auto-merge unless something above
  trips), `fully_autonomous` (never asks except for a destructive-change
  trip, which always asks regardless), or `always_ask` (every merge needs
  a human tap, even a clean one).
- **GitHub checks gate (opt-in, per-project).** If the target repo has its
  own CI, enable **"Wait for the PR's own GitHub checks"** in the project's
  Advanced settings — the auto-merge then also waits for the PR's GitHub
  checks to pass (default timeout 15 minutes; configurable). Checks failing
  or timing out escalates to you instead of merging. Repos with no checks
  configured are unaffected.
- **"Vacuous" gates.** A brand-new repo with no `test`/`build`/etc. scripts
  yet would otherwise "pass" every gate by doing nothing — Hoopedorc detects
  this (`GateResult.vacuous`) and treats it as risky (escalates) unless you
  explicitly opt into `Settings.allowVacuousGates`.
- **Budgets.** A per-project cap and a global monthly cap (Settings), soft
  warnings at 50%/80% of either, and a hard stop once a cap is hit — the
  autonomous run winds down cleanly rather than erroring out.
- **Subscription quotas.** Model plans with usage windows (Claude Pro's
  rolling cap being the motivating case) can be declared per model in
  Settings → Models: a window in hours plus a max run count and/or max
  spend. Once a model's window is exhausted the scheduler routes around it
  (skips dispatching, retries once the window rolls) instead of burning
  attempts on rate-limit failures. This complements the automatic cooldown
  that already kicks in *after* a rate-limited failure.
- **Rollback.** Any merged task has a one-click Rollback (reverts the merge
  commit on `main` via `git revert`) if something merged that shouldn't
  have.
- **Gate sandbox (Docker, opt-in via `Settings.sandboxGates`).** Gate
  scripts (typecheck/lint/build/test/`testCommand`) and the dependency
  install (`npm ci`/`install`) can run inside a disposable Docker container
  instead of directly on the host — see "Gate sandbox" below.
- **What's NOT sandboxed (yet).** Every model's own tool use — the *author
  agent* that actually edits your code — still runs **directly on the host
  machine** with your real `gh`/`claude`/`opencode` auth, regardless of the
  gate sandbox setting above. Its environment is stripped of anything
  secret-shaped before it runs, but it still has real filesystem/network
  access. Don't point this at a repo you don't trust. Sandboxing the author
  agent itself is tracked as future work (F13 phases 2/3 in
  `docs/specs/sandbox.md`), not built yet.

## Notifications

Three channels surface different things — none of them shows everything, so
it's worth knowing which to check for what:

| Event | Web bell (Notifications) | Telegram |
|---|---|---|
| Approval needed (risky change, escalation, `always_ask`) | ✅ always | ✅ always, with inline Approve/Reject buttons |
| Model trouble — rate-limit wait, fallback switch, exhausted chain, or a run-wide cooldown/quota stall (`quota_wait`) | ✅ always, one entry per task+event type per run | ✅ if Settings → Telegram → "Alert me when a model hits trouble" is checked (default on) |
| A run ends without finishing (`paused`/`failed`, not `completed`) | ✅ one entry naming the blocked tasks and why | ✅ as part of the end-of-run digest |
| Budget threshold crossed (50%/80%) | ✅ | ✅ |
| Task status changes (in progress → in review → done, etc.) | — (see the Board itself) | Only if `Settings → Telegram → Digest` is `"all"` (default `"terminal"`, which is done/failed only) |

If you want to watch a run's step-by-step progress — including "a task is
now being validated" — from your phone rather than the app, set
`Settings → Telegram → Digest` to **"all"**; the web UI doesn't need this
setting since you can just watch the Board directly. Browser notifications
(see above) mirror a subset of the bell's entries while the tab is hidden;
Telegram is still the reliable channel for phones.

## Fallbacks, pricing, and cleanup

- **Fallback models (Settings → Routing → Fallback 1/2).** When a task's
  assigned model keeps failing (author errors, failing gates, rate limits),
  the engine retries with Fallback 1, then Fallback 2 — swap the two
  dropdowns any time to change the order. Leave both empty to use the old
  behavior (escalating through the by-difficulty tiers).
- **Manual model pricing (Settings → Models).** Each model has three
  optional price fields — input, cached input, and output, in **USD per 1M
  tokens** (the unit provider pricing pages use). When any is set, every
  recorded run/validator cost for that model is recomputed from its real
  token counts using your prices, instead of trusting the CLI's own pricing
  table (OpenCode's goes stale; Codex reports no cost at all). Budgets,
  quotas, and the Costs tab all use the corrected numbers going forward.
- **The docs task runs last.** Every plan gets one documentation task that
  depends on all the others — even if the planner writes its own docs task,
  its dependencies are extended so it can't run against a half-built repo.
  If some earlier task failed, the docs task still runs at the end and
  documents whatever was actually built (it only stays blocked when
  *nothing* landed).
- **Branch cleanup.** A merged task's PR branch is deleted on merge. A task
  that terminally fails (exhausted attempts, or you rejected it) now also
  gets its PR closed — with a comment carrying the failure reason — and its
  `orc/*` branch deleted, so dead branches don't pile up in your repo. The
  failure reason is preserved on the Audit page and the task's drawer
  ("Outcome").

## Telegram commands

Beyond approve/reject buttons and the status digest, the bot understands a
small command set (chat-id restricted, same as everything else Telegram —
see "The safety model" above). Send `/help` any time for the live list.

| Command | Does |
|---|---|
| `/status` | Every project's status and done/failed task counts. |
| `/cost` | Spend this month, total and per project. |
| `/projects` | Project ids (for the commands below that need one). |
| `/start <projectId>` | Start a project's autonomous run. |
| `/pause <projectId>` | Pause a project (finishes active tasks first). |
| `/autonomous [on\|off]` | View, or flip, the merge policy between `fully_autonomous` (nothing ever asks) and `hard_gate_flag_risky` (the default — risky changes still ask). Bare `/autonomous` reports the current policy without changing it. |
| `/pending` | Re-sends every still-open approval with its buttons — recovers a push you missed or dismissed. |
| `/stopall` | Stops every running project. Two-step on purpose (the highest-blast-radius command here): replies with a Yes/No confirmation naming how many projects/tasks it'll hit; nothing stops until you tap Yes. |
| `/retry <taskId-or-prefix>` | Retries a `failed`/`changes_requested`/`blocked` task. A short unique prefix of the id works — no need to type the full id on a phone keyboard; an ambiguous prefix lists every match instead of guessing. |
| `/digest [off\|terminal\|all]` | View, or set, the status-digest level (mirrors Settings → Telegram → Digest). |
| `/health` | One line per model: cooldown state, subscription-quota window usage, and the last "Test models" result. |

`/autonomous` and `/digest` change the same `Settings` fields the web UI's
Settings page does, so either surface reflects the other's changes. Flipping
to `/autonomous on` means **no approval prompts at all** until you turn it
back off — including for risky changes (DB migrations, new dependencies,
auth/secret files, out-of-scope edits) — so treat it as a deliberate,
temporary "trust everything" mode, not a default to leave on.

## Gate sandbox

Gate scripts run the target repo's own `typecheck`/`lint`/`build`/`test` (or
a project's `testCommand` override) — and `npm ci`/`install` runs whatever
`postinstall` hooks the repo's `package.json` declares. Both are repo-owned
code, not Hoopedorc's, so by default (`Settings.sandboxGates: "auto"`) they
run inside a disposable `docker run --rm` container instead of directly on
the host whenever a Docker daemon is reachable: the container sees only the
one task's git worktree (bind-mounted read-write) plus, read-only, the
project's shared `node_modules` install — not your home directory, not
Hoopedorc's own database, not any other task's worktree, and none of your
CLI credentials. No daemon reachable => it transparently falls back to
running on the host exactly as before, with a one-time log line noting the
fallback.

Three modes (`Settings.sandboxGates`, a select in Settings → Gate Sandbox):

- **`"auto"` (default).** Sandbox when Docker responds to `docker version`,
  host otherwise. Safe to leave alone either way.
- **`"off"`.** Always host — byte-identical to pre-sandbox behavior.
- **`"required"`.** No daemon => the gate fails loudly instead of silently
  running unsandboxed. Recommended once you've confirmed Docker is actually
  installed and working on a given box (see the EC2 section below for the
  deploy target), so a Docker outage there can't quietly downgrade every
  gate run to unsandboxed without you noticing.

Check **Setup & Health**'s "Gate sandbox" line to see which mode a given box
is actually running in. A non-Node stack needs a different
`ProjectConfig.gateImage` (Advanced accordion on the project, default
`"node:22"`) — e.g. a Python repo's `testCommand: "pytest -q"` needs an
image that actually has `pytest` installed, or it'll fail the same way
running `pytest` on a machine that never installed it would.

## Scheduled runs

A project can auto-start on a schedule — useful for a nightly maintenance
backlog. Enable it under the project's **Advanced** settings: either
**every N hours** or **daily at HH:MM** (the *server's* local clock). The
schedule triggers the exact same Start as the button — all the safety
rails above (gates, validator, budgets, quotas, approvals) apply
unchanged, and a schedule never piles onto a run that's already active. A
daily run fires within a few minutes of its set time; if the server was
*down* at that time, the missed run is skipped, not fired retroactively on
boot — an unattended machine starting a paid model run at an unexpected
hour would be worse than skipping a night.

## Using skills with your agents

"Skills" are a **Claude Code** feature — a folder of instructions (and
optionally scripts) that Claude Code discovers on its own and reaches for
when a task matches the skill's description. They come from two places:

- **User-level** (`~/.claude/skills/` on the machine running Hoopedorc) —
  available to every project on that box. Install here anything you want
  *every* agent, on *every* repo, to have access to (e.g. a general code
  review or security-audit skill). This is a one-time setup step on the
  deployment machine, not something Hoopedorc manages.
- **Repo-level** (`<target repo>/.claude/skills/`) — committed to the
  project's own repository, like code. Use this for anything specific to
  that project (its own design system, its own release process). Anyone —
  human or agent — running Claude Code in that repo gets it.

**`opencode` models have no skills mechanism.** They don't discover
`.claude/skills/` at all — the equivalent lever is plain instructions in the
prompt (or that project's own `AGENTS.md`, if it has one — see the next
section).

Discovery alone isn't reliable for a headless agent: it only reaches for a
skill when the task at hand clearly matches the skill's description.
Hoopedorc's job is to **nudge** — a project's **Advanced** settings has a
**"Skill hints for the author model"** textarea (one per line, `skill name —
when to use it`, e.g. `frontend-design-guidelines — read before building any
UI component`). Every hint is appended to the author's prompt under a
`## Skills` heading: Claude Code treats it as a strong signal to invoke the
named skill; other runners just see it as ordinary instructions (harmless,
often still useful). Hints are per-project because relevant skills vary by
repo — a design-heavy frontend and a backend service need different nudges.

## AGENTS.md — the project context file

When you deconstruct a plan, Hoopedorc generates an `AGENTS.md` alongside
the PRD and task table: what the project is, its stack and target
platform, the intended directory structure, the real dev/test/build/lint
commands (matching whatever the scaffold task actually sets up in
`package.json`), coding conventions for that specific stack, and brief
notes on how to work in that codebase. It's about the *project*, not
Hoopedorc's own worktree/PR machinery.

It shows up in the Plan tab as an editable text box next to the PRD —
review and adjust it before you approve, the same as you'd tweak a task's
scope or acceptance criteria. Once you commit the plan, it's written to
the repo root as a real, permanent file (not something Hoopedorc manages
afterward) — from then on it's just a normal committed file: agents,
teammates, and later documentation tasks (F30's per-task documenter is
allowed to touch it when a change actually alters the project's structure)
can all read and edit it like any other file in the repo.

All three runners end up seeing the same content, but not identically:
**Codex CLI and `opencode` read `AGENTS.md` natively** — it's a
cross-tool convention both discover on their own. **Claude Code does not**
— it only reads `CLAUDE.md`. So Hoopedorc also commits a one-line
`CLAUDE.md` containing exactly `@AGENTS.md`, which is Claude Code's own
import syntax for pulling in another file's content. This file is written
once, only when the repo doesn't already have a `CLAUDE.md` — if you have
a hand-maintained one, Hoopedorc leaves it alone. The author prompt also
gets a one-line nudge to read `AGENTS.md` when the task's worktree has one,
as a belt-and-suspenders reminder for whichever runner needs prompting to
actually look at it.

## Backups & data

Everything lives in two places: the SQLite DB (`DB_PATH`, default
`./hoopedorc.db`) and the cloned repos (`REPOS_DIR`, default
`~/.hoopedorc/repos`). The server backs the DB up automatically on boot
and daily via SQLite's online-backup API into `DB_BACKUP_DIR` (default: a
`backups/` directory next to the DB), keeping the newest `DB_BACKUP_KEEP`
(default 7). The repos directory is just git clones — everything in it is
recoverable from GitHub, so the DB backups are the part that matters.

## Updating

From the repo root on the deployed box:

```bash
npm run update
```

This runs `scripts/update.sh`, which: refuses if the working tree has
uncommitted changes (commit/stash first); warns and asks for confirmation
if any project is currently running (`GET /api/projects` against
`127.0.0.1` — updating restarts the process, aborting anything active);
then `git pull --ff-only && npm ci && npm run build`; then restarts
`hoopedorc.service` via `systemctl` if that unit is installed (the
[EC2 / headless Linux](#ec2--headless-linux) native+systemd path above),
or otherwise prints a reminder to restart the process yourself (however
you're actually running it — a process manager, a `screen`/`tmux`
session, etc). Check `GET /api/health`'s `version` field (also shown at
the top of the Setup & Health page) to confirm the update actually took.

## Remote setup (Tailscale)

The server binds to `127.0.0.1` and is unauthenticated by default — fine
for solo localhost use, but this app can spend real money and push real
code, so don't casually widen it. To reach it from another device (a
laptop, your phone) without exposing it to the open internet, there are two
paths — try the first one before falling back to the second.

### Recommended: `tailscale serve` (real HTTPS, no non-loopback bind)

[Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve) proxies a
real HTTPS endpoint on your tailnet (`https://<machine>.<your-tailnet>.ts.net`)
straight through to a `localhost` port on the box — the server itself never
needs to bind beyond loopback, and you get a browser-trusted TLS cert for
free (no self-signed-cert warnings, and it's what makes the Notification
API and other secure-context-only browser features actually work over the
tailnet — see B24 in `docs/PRODUCTIZATION_PLAN.md`).

1. Put the box on your [Tailscale](https://tailscale.com/) tailnet and make
   sure `tailscale` is installed and logged in there (`tailscale status`).
2. Leave `HOST` at its default (`127.0.0.1`) in `.env` — `tailscale serve`
   is what makes the app reachable, not a wider bind.
3. Run (as the same user hosting the app, or via a systemd drop-in if you
   want this to survive reboots):
   ```bash
   tailscale serve --bg 4317
   ```
   (replace `4317` with whatever `PORT` you've configured — `4317` is this
   app's own default). This was **not
   run against a live tailnet while writing this doc** — the exact flags
   can drift between Tailscale versions, so run `tailscale serve --help` and
   `tailscale serve status` once on your box to confirm the invocation
   before relying on it.
4. Still set `API_TOKEN` (below) as defense in depth — Tailscale Serve
   controls *who can reach the port*, not application-level auth.
5. **Never** use `tailscale funnel` for this — Funnel exposes the endpoint
   to the public internet, not just your tailnet, which defeats the entire
   point of gating a code-spending, GitHub-pushing app behind Tailscale.

### Fallback: `HOST` + `API_TOKEN`

If Tailscale Serve isn't available (older Tailscale version, or you're on
a different private network entirely — a home LAN, a VPN), fall back to
binding the server itself:

1. Set `HOST=0.0.0.0` (or the tailnet interface's own address) in `.env` —
   the server **refuses to start** with a non-loopback `HOST` unless you
   also set one of the next two things.
2. Set `API_TOKEN` in `.env` to a random string. Every `/api/*` request and
   the WebSocket connection then need the token; the web UI shows an in-app
   login screen the first time it hits a 401 and stores what you enter in
   the browser's `localStorage` after that. This is the normal path — do
   this, don't skip it.
3. (Escape hatch, not recommended) `ALLOW_UNAUTHENTICATED=1` starts the
   server on a non-loopback `HOST` with no token at all — only reasonable
   for a genuinely locked-down throwaway sandbox.
4. At the network layer: if this also sits behind a cloud security group
   (e.g. EC2), don't open the app port to `0.0.0.0/0` — restrict it to the
   tailnet, and rely on Tailscale for the actual access control. Anyone on
   your tailnet can reach the app once it's up; for a solo setup that's the
   right tradeoff (app-level auth becomes a second layer, not the only one).
5. Unlike the `tailscale serve` path, this one is still plain HTTP unless
   you separately terminate TLS yourself — secure-context browser features
   (the Notification API; see B24) won't work over it from another machine.

### Applies to both paths

One thing the token does **not** cover: the static SPA shell itself (the
HTML/JS/CSS bundle) is served without auth even when `API_TOKEN` is set —
only `/api/*` and the WebSocket upgrade are gated. This is intentional
(the shell has no data in it, just code), but it means anyone who can
reach the port can load the login screen and see that Hoopedorc is
running there, even without a valid token. Tailscale is still the real
access-control boundary; the token protects the data, not the app's
existence.

## EC2 / headless Linux

The most likely real deployment target: an always-on Linux box with no
display, reached only over Tailscale, running the app close to unattended.
The three CLIs Hoopedorc shells out to (`gh`, `claude`, `opencode`) all
expect an interactive login *once* — here's how to get each one working
without a browser on the box itself. Everything below was checked against
the actual installed CLIs' own `--help` output on this project's dev
machine (not run end-to-end through a real OAuth flow, since that needs a
live account) — verify the exact interactive prompts once for real during
your own setup, per the note on each step.

- **Prereqs**: Node >= 20 (22 recommended), `git`, and the three CLIs
  installed (`gh`, `claude`, `opencode`) — same as local install
  (`npm run setup` checks all three either way).
- **Docker (optional, for the gate sandbox)**: install it via your distro's
  package manager or
  [Docker's own install docs](https://docs.docker.com/engine/install/), then
  confirm `docker version` succeeds as the OS user that will run Hoopedorc
  (add that user to the `docker` group if needed). Without it, gate
  sandboxing (`Settings.sandboxGates`, see above) just falls back to host
  execution — nothing else is affected. See
  [Deploying to EC2 — checklist](#deploying-to-ec2--checklist) below for the
  full ordered setup, including the systemd unit.
- **`gh`**: the easiest of the three headlessly — it natively supports
  `GH_TOKEN` (confirmed via `gh help environment`: "an authentication token
  that will be used when a command targets github.com... takes precedence
  over previously stored credentials"). Generate a fine-grained personal
  access token scoped to the repos you'll point Hoopedorc at, and set
  `GH_TOKEN=<token>` in `.env` — no interactive `gh auth login` needed at
  all on the server itself.
- **`opencode`**: `opencode auth login` is interactive (it walks you
  through picking a provider and a login method). Its credentials land in
  a plain file (`~/.local/share/opencode/auth.json` — confirmed by
  `deploy/README.md`'s Docker section, verified there on macOS; the exact
  path can differ by OS/install method, check `opencode auth list` if it
  doesn't match). Two options: run `opencode auth login` directly over SSH
  on the box (many CLI OAuth flows print a URL to open in *any* browser —
  your laptop's, not the headless box's — rather than needing a local
  display; confirm this is how it behaves for your chosen provider before
  relying on it), or run it once on a machine that does have a browser and
  copy the resulting `auth.json` over to the server under the same OS user
  that will run Hoopedorc.
- **`claude`**: two real paths, confirmed via `claude --help`/`claude auth
  --help`:
  - **`claude setup-token`** — documented by the CLI itself as "Set up a
    long-lived authentication token (requires Claude subscription)". This
    is the headless-friendly path that still bills at your Pro/Max
    subscription's flat rate rather than pay-per-token — run it once
    (likely via a URL-based flow you complete in a browser elsewhere, the
    same pattern as `gh auth login`'s device flow) and it should leave a
    durable credential behind. **Not run end-to-end while writing this** —
    confirm the exact prompts once on your box.
  - **`ANTHROPIC_API_KEY`** — the documented escape hatch (`claude --help`
    on `--bare` mode: "Anthropic auth is strictly `ANTHROPIC_API_KEY` or
    `apiKeyHelper`... OAuth and keychain are never read"). Set it in `.env`
    if `setup-token` doesn't fit your setup. **Caveat, already noted in
    `deploy/README.md`**: this bills pay-per-token via the Anthropic
    Console, not your subscription's flat rate — a real cost-model
    difference, not just a config difference.
  - Note this Linux-native path is a different situation from
    `deploy/README.md`'s Docker section, which is specifically about **why
    a container** can't reach `claude`'s macOS-Keychain-based login — that
    problem is macOS/container-specific and doesn't apply to a normal
    (non-containerized) Linux systemd deployment, which is what this
    section assumes.
- **`codex`** (only if you've configured a model with runner `codex` —
  otherwise skip this entirely, the Setup page won't even check for it):
  same shape as `opencode`'s pattern above. `codex login` is an interactive
  ChatGPT OAuth flow, so run it once on a machine with a browser and copy
  the resulting credential file (`~/.codex/auth.json`, or wherever
  `$CODEX_HOME` points) over to the server under the same OS user that will
  run Hoopedorc — **treat it like a password**, same as any other CLI
  credential file in this section. `CODEX_API_KEY` in `.env` is the
  non-interactive alternative if you'd rather not seed a credential file at
  all, at the cost of per-token billing instead of the subscription's flat
  rate.
- Once all three check out (`npm run setup` re-runs the same checks Setup
  page does), follow `deploy/README.md`'s "Native + systemd" steps for the
  actual service setup, see **Backups & data** above for where the DB and
  its backups live on disk, and **Updating** below for keeping this box
  current afterward (`npm run update` restarts the same systemd unit). Or
  just work through the ordered checklist below, which sequences all of the
  above into one pass.

## Deploying to EC2 — checklist

Everything above (CLI auth, Tailscale, backups, updates) exists as its own
section; this is the single ordered path through all of them for a first
deploy, so you don't have to hop between five sections to do it. Each step
links back to the section with the full detail if something doesn't go as
expected.

**`deploy/ec2-bootstrap.sh` automates steps 1–2 and 6** (the non-interactive
ones — OS packages, swap, clone, `npm install`/`setup`/`build`, and the
systemd unit) on Amazon Linux 2023 or Ubuntu LTS. Clone straight to its
default install path so its own clone step is a no-op, then run it from
there:
```bash
sudo git clone https://github.com/IngeniousArtist/hoopedorc.git /opt/hoopedorc
sudo chown -R "$(whoami)": /opt/hoopedorc
cd /opt/hoopedorc
bash deploy/ec2-bootstrap.sh --dry-run   # preview first
bash deploy/ec2-bootstrap.sh             # then run for real
```
It stops there and prints steps 3–5 (CLI logins, `.env`, `tailscale serve`)
for you to do by hand — genuinely interactive, so it doesn't try to guess
at them. Safe to re-run; every step checks the box's current state first.
`--no-docker` skips Docker if you don't want the gate sandbox; `--dir`/
`--repo` override the install path/source (if you didn't clone to
`/opt/hoopedorc`, or you're deploying from a fork). See the script's own
`--help` for the full flag list. Skip it and follow the numbered steps
below by hand on any other distro.

1. **Size the instance.** ≥2GB RAM (or a smaller instance plus swap — the
   *build* step, not the running server, is what needs the headroom; see
   the swap snippet in `deploy/hoopedorc.service`'s comments). Install
   **Node 22** (`engines.node` requires ≥20; 22 is what this project is
   developed against), **git**, and, if you want the [gate
   sandbox](#gate-sandbox) instead of host-run gates, **Docker** (confirm
   `docker version` works as the OS user that will run Hoopedorc).
2. **Clone + install.**
   ```bash
   git clone <your fork/repo url> /opt/hoopedorc
   cd /opt/hoopedorc
   npm install
   npm run setup
   ```
   `setup` creates `.env` from `.env.example` if missing and checks
   `gh`/`claude`/`opencode` auth (and `codex`, if you've configured a
   `codex`-runner model) — it'll tell you which of the next step's auths
   are still outstanding.
3. **Authenticate the CLIs, in this order** (cheapest/least-interactive
   first) — do this as the **same OS user** the systemd service will run
   as in step 6, since all of these store credentials under that user's
   home directory. Full detail in [EC2 / headless
   Linux](#ec2--headless-linux) above:
   1. `GH_TOKEN` — set a fine-grained PAT in `.env`; no interactive login
      needed for `gh` at all.
   2. `claude setup-token` — bills your Pro/Max subscription flat rate
      rather than per-token; run once, completes via a browser (yours,
      not the headless box's).
   3. `opencode` — run `opencode auth login` directly over SSH if its
      OAuth flow prints a URL you can open elsewhere, or run it once on a
      machine with a browser and copy the resulting `auth.json` over.
   4. `codex` (only if a model uses runner `codex`) — same pattern as
      `opencode`: run `codex login` on a machine with a browser, copy the
      credential file over.
4. **Configure `.env`.** At minimum: `PORT` (default `4317`), leave `HOST`
   at `127.0.0.1` (Tailscale Serve, next step, is what makes it reachable —
   don't widen `HOST` for this), `DB_PATH` if you want the DB somewhere
   other than the working directory, `API_TOKEN` (required once anything
   *does* bind non-loopback — set it regardless, as defense in depth), and
   `DB_BACKUP_DIR` if you want backups somewhere other than the default
   `backups/` next to the DB. See **Backups & data** above and
   `.env.example`'s comments for the rest.
5. **`tailscale serve --bg 4317`** (your `PORT`, if different) — see
   [Remote setup (Tailscale)](#remote-setup-tailscale) for the fallback
   path and why Funnel is never the right choice here.
6. **Build once, install the unit, enable it:**
   ```bash
   npm run build
   sudo cp deploy/hoopedorc.service /etc/systemd/system/hoopedorc.service
   sudo $EDITOR /etc/systemd/system/hoopedorc.service   # set User=, WorkingDirectory=
   sudo systemctl daemon-reload
   sudo systemctl enable --now hoopedorc
   ```
   The unit runs `npm run start:prebuilt` (serve only — see the unit's own
   comments for why it doesn't rebuild on every restart). Future deploys
   rebuild via `npm run update` (below), not this step.
7. **Verify the first boot.** Open the app over your tailnet URL, check
   **Setup & Health** shows all three (or four, with Codex) CLI checks
   green and the gate-sandbox line matches what you expect; tail logs with
   `journalctl -u hoopedorc -f` if anything's red. From here, **Updating**
   above (`npm run update`) is how you keep the box current.

Data lives at `DB_PATH` (default `./hoopedorc.db`, so
`/opt/hoopedorc/hoopedorc.db` if you cloned to `/opt/hoopedorc`) plus its
automatic backups at `DB_BACKUP_DIR` (default a `backups/` dir alongside
it) — see **Backups & data** above.

### Two boxes: EC2 for web/extensions, your Mac for Apple targets

Apple/Xcode projects can't build on Linux, so if you have any of those,
you'll run a second Hoopedorc instance on your Mac alongside the EC2 box —
same install steps as above, minus Tailscale Serve/systemd if you'd rather
just run it in the foreground there.

**One project lives on exactly one box.** Point a project's repo at both
instances and both will happily schedule and dispatch work against it —
nothing deduplicates across servers, since each box has its own independent
DB. That's by design, not a gap to work around: decide up front which box
owns which project (Linux-buildable → EC2, Apple/Xcode → Mac) and only add
each project on that one box.

A few things follow from that split:
- **Settings, model routing, and budgets are per-box** — configuring a
  model or a cost cap on one instance doesn't touch the other. If you use
  the same providers on both, you'll set them up twice.
- **The Telegram bot token can be shared or split.** One bot (same token,
  same chat id) works fine since Hoopedorc chat-id-restricts who it'll
  respond to — you'll just get approvals from both boxes in the same chat
  with no origin label. **Recommended:** two separate bots (one per box),
  so every alert's sender name tells you which box it came from at a
  glance.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `gh pr create` fails with "No commits between main and \<branch\>" | The author model didn't actually commit anything — usually a task that was too vague, or scoped to files that didn't need changing. (Historically this was also caused by agents writing to the wrong directory because `$PWD` didn't match the worktree `cwd` — fixed; if you see this on a current build, it's almost always the task itself, not the plumbing.) | Check the task's logs in its detail drawer; tighten the description/acceptance criteria and Retry. |
| A model's task fails almost instantly with something like "database is locked" | OpenCode keeps a shared SQLite session store; two `opencode` runs starting at the exact same instant (two tasks dispatched concurrently) can collide on it. | Hoopedorc already retries this automatically after a short stagger (`OPENCODE_TRANSIENT` in `packages/adapters`) — a single retry almost always clears it. If it keeps happening, lower that model's `maxConcurrent` in Settings. |
| Every task in a brand-new project auto-merges with basically no verification | The repo has no `test`/`build`/`lint`/`typecheck` scripts yet, so every gate "passes" by doing nothing (vacuous). | This should already escalate to your approval by default — check `Settings.allowVacuousGates` isn't turned on. Longer-term, the planner's first scaffold task is supposed to set up real scripts; if it didn't, add them yourself or via a follow-up task. |
| A "hard" difficulty task always fails validation with a self-review error | The author and validator models are configured to be the same model for that difficulty tier — the validator refuses to review its own work. | Settings → Routing: make sure `validatorByDifficulty` never matches `byDifficulty`/`byRole` for the same tier. |
| Pressing Stop doesn't seem to do anything | You're on a very old build — this was a real bug (B1), fixed early in the productization pass: Stop now actually aborts the live process and can't be overtaken by an in-flight auto-merge. | Update to a current build. |
| Approvals never reach Telegram | No bot token/chat id set, or the token has a Markdown metacharacter issue (also fixed — messages are plain text now). | Settings → Telegram: use the **Send test message** button to confirm delivery before relying on it live. |
| The server won't start after setting `HOST=0.0.0.0` | No `API_TOKEN` set and `ALLOW_UNAUTHENTICATED` isn't `1` — this is an intentional refusal, not a bug. | Set `API_TOKEN` (see Remote setup above), or explicitly opt into `ALLOW_UNAUTHENTICATED=1` if you really mean to. |
| The web UI shows nothing / a blank board in "real" (non-mock) mode | No project selected yet, or you're pointed at `MOCK=1` data. | Use the project picker in the nav; confirm `MOCK` isn't set in your `.env`/environment. |
| Docker: `claude` fails to authenticate inside the container | Claude Code's login on macOS lives in the system Keychain, which a Linux container can't reach at all — no mount fixes this. | Set `ANTHROPIC_API_KEY` in `.env` instead (see `deploy/README.md`) — note this bills per-token via the Console, not your subscription's flat rate. |
