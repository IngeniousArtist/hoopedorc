# Hoopedorc — Product Requirements (v1)

## Problem
A solo, non-expert builder wants to ship software fast by running a *team* of AI
coding models instead of one. Today that means babysitting several terminals,
manually copying tasks around, and reviewing code they can't reliably judge.

## Goal
A local web app (also runnable headless on EC2) that orchestrates multiple AI
coding models as a team: Claude plans, specialist models implement in parallel
inside isolated git worktrees, and a validator model auto-merges safe work to
`main` while flagging risky decisions to the user over Telegram.

## Users
One operator (the owner). Not a multi-tenant product.

## Models & roles (default, user-configurable)
| Model | Runner | Role |
|---|---|---|
| Claude (Pro sub) | Claude Code | Planning, PRD, task breakdown; optional final reviewer |
| GLM 5.1 | OpenCode | Frontend tasks; frontend reviewer |
| Deepseek v4 Pro | OpenCode | Hard tasks; **primary validator/merger** |
| Deepseek v4 Flash | OpenCode | Medium tasks |
| Grok 4.3 | OpenCode | Status summaries / Telegram updates |
| Nex N2 Pro | OpenCode (OpenRouter) | Documentation |

## Core flow
1. **Create project** — point at an existing GitHub repo or create a new one.
2. **Plan** — Claude produces a PRD + a task **DAG**: each task has a difficulty,
   acceptance criteria, an assigned model, and a declared file scope.
3. **Dispatch** — the engine picks tasks whose dependencies are met, creates a
   branch + worktree per task, and runs the assigned model there (live logs).
4. **Validate** — objective gates (typecheck, lint, build, tests, no-conflicts,
   in-scope) run; then the validator model reviews against acceptance criteria.
5. **Fix loop** — on failure, the validator's reasons are fed back to the author
   model and it retries, up to `maxAttempts`.
6. **Merge** — if gates + validator pass and the change isn't "risky", auto-merge
   the PR to `main`. Risky changes (DB schema, new deps, auth/secrets, edits
   outside scope) require a one-tap human approval via Telegram/UI.
7. **Report** — costs, audit log, and status summaries; Telegram for anything
   needing attention while away.

## Auto-merge safety rails (non-negotiable for v1)
- Nothing is committed to `main` directly — always branch → PR → merge.
- All objective gates must pass; the validator must be a **different** model than
  the author; validator confidence below threshold → escalate to human.
- `main` is always green and one `git revert` away from any bad merge.

## v1 scope (in)
Create/plan project, DAG kanban, dispatch to worktrees, gates + validator + fix
loop, auto-merge with rails, cost tracking + budget caps + auto-stop, live logs,
local + headless run modes.

## v1.1 (out, next)
Bidirectional Telegram, Nex docs generation, Grok status summaries, model
fallback on rate-limit, multiple concurrent projects, audit replay viewer.

## Non-goals
Multi-user/SaaS, IDE plugin, fine-tuning, mobile app.

## Success criteria
Hoopedorc can take "build feature X" and land a correct, tests-passing PR merged
to `main` with no human edits to code — and it built *itself* (Round 1) this way.
