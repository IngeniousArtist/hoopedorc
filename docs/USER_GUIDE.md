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
3. **Plan**: describe what you want in the chat panel. Claude (Sonnet, for
   cheap back-and-forth) will ask clarifying questions and propose a plan —
   refine it conversationally ("split that into two tasks", "don't touch
   the database", "add tests"). When you're happy, approving it runs one
   more Claude call (Opus, the plan's single most important call) that
   deconstructs the agreed plan into a real task list: each task's
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
- **Merge policy** (global in Settings, optionally overridden per-project):
  `hard_gate_flag_risky` (default — auto-merge unless something above
  trips), `fully_autonomous` (never asks), or `always_ask` (every merge
  needs a human tap, even a clean one).
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
- **What's NOT sandboxed (yet).** Gate scripts and every model's own tool
  use run **directly on the host machine** with your real `gh`/`claude`/
  `opencode` auth — a repo's own `test`/`build` scripts execute as-is. Their
  environment is stripped of anything secret-shaped before they run, but
  they still have real filesystem/network access. Don't point this at a
  repo you don't trust. A containerized sandbox mode is tracked as future
  work (F13 in `docs/PRODUCTIZATION_PLAN.md`), not built yet.

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
prompt (or that project's own `AGENTS.md`, if it has one).

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
- Once all three check out (`npm run setup` re-runs the same checks Setup
  page does), follow `deploy/README.md`'s "Native + systemd" steps for the
  actual service setup, see **Backups & data** above for where the DB and
  its backups live on disk, and **Updating** below for keeping this box
  current afterward (`npm run update` restarts the same systemd unit).

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
