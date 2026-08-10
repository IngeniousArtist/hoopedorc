<p align="center">
  <img src="apps/web/public/icon-192.png" alt="Hoopedorc" width="96" height="96">
</p>

<h1 align="center">Hoopedorc</h1>

<p align="center">
  <strong>A self-hosted, multi-model AI coding orchestrator.</strong><br>
  Turn a planning conversation into isolated agent work, gated pull requests,
  independent review, and safe merges.
</p>

<p align="center">
  <a href="https://github.com/IngeniousArtist/hoopedorc/actions/workflows/ci.yml"><img src="https://github.com/IngeniousArtist/hoopedorc/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/Node-%3E%3D20-339933?logo=nodedotjs&logoColor=white" alt="Node 20 or newer">
  <img src="https://img.shields.io/badge/version-0.6.0-525252" alt="Version 0.6.0">
</p>

<p align="center">
  <a href="docs/USER_GUIDE.md">User guide</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/CONTRACT.md">API contract</a> ·
  <a href="AGENTS.md">Contributing</a>
</p>

Hoopedorc is built for developers who already use several model subscriptions
and want them to operate as one engineering team. Describe the outcome in a
planning chat; Hoopedorc creates a dependency-aware task graph, assigns work to
Claude Code, Codex, or OpenCode-backed models, and runs independent tasks in
parallel Git worktrees.

Every task passes repository gates and review by a model that did not author
the change. Clean, low-risk work can merge automatically. Risky changes pause
for an explicit decision in the web app or Telegram, while unrelated work keeps
moving.

> **Project status:** v0.6.0. The core productization roadmap is complete and
> CI-covered. The separate post-productization hardening plan is active; its
> current completion state and evidence live in
> [`docs/OPTIMIZATION_PLAN.md`](docs/OPTIMIZATION_PLAN.md).

## Quick start

### Requirements

- Node.js 20 or newer; Node 22 is recommended.
- [`gh`](https://cli.github.com/) authenticated for the GitHub account that
  owns the target repositories.
- `claude` authenticated for Claude Code.
- `opencode` authenticated for the non-Claude providers you want to use.
- Optional: `codex` authenticated when you want ChatGPT-subscription-backed
  agents in the pool.
- Optional: Docker for sandboxed project setup and gate execution.

### Install and run

```bash
git clone https://github.com/IngeniousArtist/hoopedorc.git
cd hoopedorc
npm install
npm run setup
npm run start
```

Open <http://127.0.0.1:4317>. The first-run wizard checks the installed CLIs,
helps map models and routing, and walks through the first project.

For local development:

```bash
npm run dev    # all workspaces in watch mode
npm run mock   # web app on :5173 with a mock API and no model calls
```

## From idea to merged code

1. **Plan** — refine the goal in a conversational planning session. Hoopedorc
   produces an editable PRD, project guidance, and task DAG with acceptance
   criteria, scope paths, dependencies, difficulty, and model assignments.
2. **Dispatch** — ready tasks run in parallel, each on its own branch and Git
   worktree. Overlapping scopes are serialized and per-model concurrency caps
   apply across projects.
3. **Gate** — repository typecheck, lint, build, and test scripts run alongside
   no-conflict and in-scope checks. Docker-backed gates are used by default when
   a daemon is available.
4. **Review** — a different model evaluates the diff against the task's
   acceptance criteria and configured engineering guidance. A docs stage keeps
   project documentation current in the same PR.
5. **Merge or ask** — clean, confident, low-risk work auto-merges. Schema,
   dependency, credential-sensitive, destructive, out-of-scope, or low-
   confidence changes wait for human approval.

Failed attempts can move through a configured fallback chain. Rate-limited
models cool down without blocking other providers, and durable retry state lets
the scheduler continue safely after a restart.

## What is included

| Area | Capabilities |
| --- | --- |
| Planning | Conversational planning, attachments, editable PRD and task graph, repository-persisted planning context, Figma-aware task references |
| Execution | Parallel worktrees, dependency and scope scheduling, manual dispatch through one scheduler, model fallbacks, mid-run task creation and reprioritization |
| Quality | Repository gates, vacuous-gate detection, independent validation, risky-change inspection, optional GitHub CI wait, docs stage |
| Control | Live Kanban, task logs, pause-and-drain, hard stop, retry, rollback PRs, inline approvals, audit history |
| Models | Claude Code, Codex CLI, and OpenCode providers such as GLM, DeepSeek, Grok, and OpenRouter models |
| Budgets | Per-project/global limits, subscription invocation quotas, rolling windows, pre-run estimates, exactly-once model-call accounting |
| Remote operation | Telegram approvals and controls, browser notifications, schedules, run reports, Tailscale guidance, installable PWA |
| Operations | SQLite persistence and backups, graceful shutdown, guarded self-update, systemd deployment, health and model-slug checks |

## Architecture

```text
┌────────────────┐    REST + WebSocket    ┌────────────────────────┐
│ React web app  │◀──────────────────────▶│ Fastify server + SQLite│
└────────────────┘                        └───────────┬────────────┘
                                                   │ owns runtimes
                                           ┌───────▼────────┐
                                           │ DAG scheduler  │
                                           │ gates + review │
                                           └───────┬────────┘
                                                   │
                         ┌─────────────────────────┼──────────────────────┐
                         ▼                         ▼                      ▼
                  Claude Code                 OpenCode               Codex CLI
                  subscription           provider/model pool     ChatGPT subscription
```

This is one TypeScript npm-workspaces monorepo. `@orc/types` owns the shared
domain, REST, and WebSocket contract; the web app talks only through that
contract. The server composes persistence, the engine, and adapters at the
runtime boundary. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the
full ownership model and lifecycle invariants.

## Safety and security boundaries

- The server binds to `127.0.0.1` without authentication by default. A
  non-loopback bind requires `API_TOKEN` unless the operator explicitly enables
  the unsafe unauthenticated override.
- Tailscale Serve is the recommended remote-access path: it provides HTTPS
  without exposing the Fastify listener directly.
- Settings APIs redact stored Telegram and API tokens; secret values never
  round-trip back to the browser.
- Repository setup, dependency installation, and gate commands run in a
  disposable Docker container by default when Docker is reachable. Only the
  task worktree is mounted.
- Agent CLIs run on the host so they can use the current OS user's existing CLI
  authentication. They receive a sanitized environment allowlist, but they
  retain that user's filesystem and network access. This is credential hygiene,
  not process isolation; do not run untrusted repositories.
- Gates fail closed, destructive changes cannot silently pass, cancellation
  owns the complete child process group, and unrelated operator changes in the
  primary clone are never stashed, reset, or auto-committed.

The detailed threat and sandbox boundary is documented in
[`docs/specs/sandbox.md`](docs/specs/sandbox.md).

## Deployment

The supported always-on deployment is a prebuilt server supervised by systemd.
The same OS user should own the checkout, run the service, and hold the CLI
authentication state.

```bash
npm run build
npm run start:prebuilt
```

[`deploy/hoopedorc.service`](deploy/hoopedorc.service) is the reference unit.
[`scripts/update.sh`](scripts/update.sh) powers both `npm run update` and the
guarded Setup & Health updater; it refuses dirty or diverged checkouts, active
project runs, and mismatched service working directories. The Docker files in
[`deploy/`](deploy/) are reference material for gate isolation and adaptation,
not the supported full-app model-execution deployment.

Follow the ordered [EC2 deployment checklist](docs/USER_GUIDE.md#deploying-to-ec2--checklist)
for host sizing, authentication, Tailscale, systemd, and live verification.

## Repository map

```text
packages/types      shared domain types and REST/WebSocket contracts
packages/adapters   Claude Code, OpenCode, and Codex process adapters
packages/engine     scheduler, worktrees, Git/PR flow, gates, review, sandbox
packages/server     Fastify API, SQLite, planner, Telegram, runtime lifecycle
apps/web            React control plane, live board, settings, and reports
docs                user, architecture, contract, roadmap, and focused specs
deploy              systemd unit and reference Docker deployment files
scripts             setup, guarded update, policy checks, and benchmarks
bin                 hoopedorc CLI entry point
```

## Documentation

| Document | Use it for |
| --- | --- |
| [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) | Installation, first project, model setup, Telegram, Tailscale, deployment, and troubleshooting |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Package ownership, runtime flow, persistence, retries, shutdown, and deployment architecture |
| [`docs/CONTRACT.md`](docs/CONTRACT.md) | Canonical domain types, REST routes, WebSocket events, and persistence conventions |
| [`AGENTS.md`](AGENTS.md) | Contributor workflow, invariants, package boundaries, and required gates |
| [`docs/PRODUCTIZATION_PLAN.md`](docs/PRODUCTIZATION_PLAN.md) | Historical productization specifications, PRs, decisions, and acceptance evidence |
| [`docs/OPTIMIZATION_PLAN.md`](docs/OPTIMIZATION_PLAN.md) | Active hardening work, dependency order, measurements, and completion evidence |
| [`CHANGELOG.md`](CHANGELOG.md) | User-facing release history |

## Development and verification

Run focused tests while iterating. Before a pull request is ready, run the full
repository gate:

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

Contributors and coding agents must start with [`AGENTS.md`](AGENTS.md). Work
happens on a descriptive branch, reaches `main` through a reviewed PR with
green required checks, and preserves the audit trail in the relevant roadmap.

Hoopedorc is dogfooded: its original packages and subsequent feature waves
were built through the same branch, worktree, gate, review, and merge pattern
that the product provides.
