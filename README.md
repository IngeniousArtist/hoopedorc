# Hoopedorc

A multi-model AI coding orchestrator. **Claude** plans a project into a task DAG;
specialist models (**GLM, Deepseek Pro/Flash, Grok, Nex**) implement tasks in
isolated git worktrees; a **validator model (Deepseek Pro)** runs hard gates +
review and auto-merges to `main` (flagging risky changes to you over Telegram).

This repo is being **built by the orchestration pattern it implements** — Claude
wrote the scaffold + contracts (Round 0), and the specialist models build the
modules in parallel (Round 1). See `docs/`.

## Layout

```
packages/
  types/      @orc/types      — shared domain model + REST/WS contract (the contract)
  engine/     @orc/engine     — scheduler, worktrees, git/PR, gates, validator  [owner: deepseek-pro]
  adapters/   @orc/adapters   — Claude Code + OpenCode runners                  [owner: deepseek-flash]
  server/     @orc/server     — Fastify REST+WS API, SQLite persistence         [owner: deepseek-flash]
apps/
  web/        @orc/web        — React kanban UI + live logs + settings          [owner: glm]
docs/
  USER_GUIDE.md, PRD.md, ARCHITECTURE.md, CONTRACT.md, specs/*.md
deploy/       systemd unit + Dockerfile/compose (see deploy/README.md)
bin/          `hoopedorc` CLI (start|init)
scripts/      npm run setup's implementation (scripts/init.mjs)
```

## Run

```bash
npm install          # install all workspaces
npm run setup        # create .env from .env.example, check gh/claude/opencode auth
npm run build        # build the libs (types -> adapters -> engine -> server -> web)

# Frontend dev against mock data (no real models needed):
npm run mock         # mock API on :4317 + web on :5173

# Full dev (all packages in watch mode):
npm run dev

# Production-ish single command: builds everything, then runs the server,
# which also serves the built web app itself (one process, one port):
npm run start        # or: hoopedorc start (if installed/linked — see bin/)
```

See [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) for a full walkthrough (first
project, the safety model, remote setup, troubleshooting) and
[`deploy/`](deploy/) for systemd/Docker deployment notes.

## Prereqs

- Node >= 20 (22 recommended)
- `opencode` installed and authenticated for GLM / Deepseek / Grok / Nex; run `opencode serve`
- `claude` (Claude Code) logged in with your Pro subscription
- `gh` CLI authenticated (`gh auth status`)

`npm run setup` checks all three for you.

## Security

The server binds to `127.0.0.1` and is unauthenticated by default (frictionless
solo localhost use). If you expose it beyond localhost (e.g. `HOST=0.0.0.0` over
Tailscale), set `API_TOKEN` so every request requires
`Authorization: Bearer <token>` — the server refuses to start otherwise. See
`.env.example` for `HOST`, `CORS_ORIGINS`, `API_TOKEN`, `ALLOW_UNAUTHENTICATED`.

Secrets (the Telegram bot token, the API token itself) are stored in the local
SQLite DB and redacted (`"__SET__"` sentinel) on every read from the settings API
— they never round-trip back to the browser. Gate scripts and spawned agents
still run **directly on this host** with your CLI auth (`gh`, `claude`,
`opencode`) — don't run untrusted repos through it. Their environment is
stripped of anything secret-shaped (`sanitizedEnv()` in `@orc/adapters`, keyed
off `/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|TELEGRAM/i`) before spawn, so a
prompt-injected agent or a hostile `npm test` script in the repo being worked
on can't read your Telegram token or provider API keys — but they still run
with real filesystem/network access on your machine, since a repo's own
`test`/`build` scripts are executed as-is (there's no sandbox yet; see F13 in
the productization plan).

## Status

This is under active development against a living fix/feature list — see
[`docs/PRODUCTIZATION_PLAN.md`](docs/PRODUCTIZATION_PLAN.md) (progress table near
the top) for what's been fixed, what's in flight, and what's next, and
[`CHANGELOG.md`](CHANGELOG.md) for a summarized history.

## The rules every module follows

1. **The contract is `@orc/types`.** Don't change it without coordinating — it's shared.
2. **Each module depends only on `@orc/types`, never on a sibling module's internals.**
3. **`main` is sacred.** All work happens on branches + worktrees → PR → auto-merge only when green.
