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
  PRD.md, ARCHITECTURE.md, CONTRACT.md, specs/*.md
```

## Run

```bash
npm install          # install all workspaces
npm run build        # build the libs (types -> adapters -> engine -> server -> web)

# Frontend dev against mock data (no real models needed):
npm run mock         # mock API on :4317 + web on :5173

# Full dev (all packages in watch mode):
npm run dev
```

## Prereqs

- Node >= 20 (22 recommended)
- `opencode` installed and authenticated for GLM / Deepseek / Grok / Nex; run `opencode serve`
- `claude` (Claude Code) logged in with your Pro subscription
- `gh` CLI authenticated (`gh auth status`)

## The rules every module follows

1. **The contract is `@orc/types`.** Don't change it without coordinating — it's shared.
2. **Each module depends only on `@orc/types`, never on a sibling module's internals.**
3. **`main` is sacred.** All work happens on branches + worktrees → PR → auto-merge only when green.
