# AW01 reference-app commissioning

Implements the first evidence track in the
[complete app workspace plan](../APP_WORKSPACE_PLAN.md). This is an operational
acceptance procedure, not proof that the following checks have passed.

## Scope and ownership

Use a dedicated repository and isolated Hoopedorc database, repository directory,
preview ports and disposable application data. Preserve the primary Hoopedorc
clone and all operator projects/settings. Exercise the existing server APIs,
planning commit path, scheduler, adapters, gates, PRs and milestone verification.
Direct CLI smoke calls establish provider access only, never end-to-end success.

Local provider evidence, deterministic fault fixtures, isolated-worker evidence
and remote deployment evidence are distinct. Record each separately. AWS remains
deferred until the owner chooses/provisions a replacement. No provider login,
credential copy, cloud provisioning or production data reset is implicit in this
runbook. Live model calls follow the owner's selected budget/account policy.

## Stage A — Readiness (no model calls)

1. Record current main SHA and clean tracked state. Preserve unrelated untracked
   files; use a clean task worktree for implementation.
2. Probe versions for Node, npm, GitHub CLI and configured model harnesses.
3. Check authentication through the same sanitized environment as the adapters.
   Record only authentication class/status; redact tokens, account identifiers,
   raw configuration and credential paths from published evidence.
4. Confirm exact selected model IDs against the installed CLI/catalog/config.
   A successful version/help command does not establish entitlement.
5. Choose eligible author/reviewer profiles and account pools. Every contributing
   author must differ from the milestone reviewer, including fallback authors.
6. Record native versus isolated execution and available services. Missing Docker
   means Docker isolation is unverified; it does not prove the native path fails.
7. Confirm model-call limits and metered-spend policy before calls. Set bounded
   attempts/concurrency and keep notifications disabled in the test installation.

## Stage B — Small existing-repository journey

Use a dedicated private test repository with a working baseline and meaningful
checks. The first brief adds two independent observable behaviors, plus a combined
verification task. Keep new dependencies/schema changes out of this slice so
provider/Git/runtime behavior can be diagnosed separately from service setup.

Acceptance:

- Repository inspection identifies the actual branch/commit and existing stack.
- Planning produces a reviewable brief and dependency graph using existing code.
- Approval durably commits/pushes the exact approved material; replay/reopen does
  not duplicate the task set or approval commit.
- Two tasks execute concurrently when scopes and resources allow. Required
  gates, independent review and PR/merge policy remain active.
- The combined milestone cites every original criterion at the actual revision.
- Close/reopen the control UI; durable operations and results remain available.
- Record actual invocation ledger totals and artifact/revision identities.

## Stage C — Full reference app

**Brief:** a client portal for a small studio. Clients sign in, see their assigned
projects, upload files and view activity. An administrator manages projects and
assignments. Use test-only identities and non-sensitive generated files.

| ID | Criterion | Required evidence |
| --- | --- | --- |
| CP01 | Valid sign-in works; invalid credentials produce a useful error; sign-out ends access | Browser journey plus auth/API test |
| CP02 | A client sees only assigned projects; direct requests for another client's project/file are refused | Two-user API and browser checks |
| CP03 | Admin creates/updates a project and assignment; changes survive reload/restart | API/storage test and browser journey |
| CP04 | Allowed file upload/download preserves content; oversized/invalid uploads fail safely | File fixtures, API checks and browser evidence |
| CP05 | Activity reflects the expected completed action without duplicate entries on retry | Persistence/idempotency test |
| CP06 | Loading, empty, error and success states are actionable; core flows work by keyboard and on phone/tablet/desktop | Interaction tests and 360/390/768/1280/1440 browser evidence |
| CP07 | Required repository checks and integrated journeys pass at the recorded revision | Executed gate/test artifacts plus milestone receipt |
| CP08 | Staging runs the accepted version; smoke checks pass; promotion/recovery scope is explicit | Release identity and deployment evidence (pending AW09/target) |

Choose concrete stack and services from the supported environment work (AW05).
Until provisioned, record missing services as unavailable instead of substituting
an in-memory demo and claiming persistence/service acceptance.

## Stage D — Deliberate recovery

Run against the dedicated project only; never interrupt unrelated processes.

| Scenario | Procedure | Acceptance |
| --- | --- | --- |
| Provider interruption | Cancel an owned author invocation through its supported task/process owner; separately use controlled fixtures for rate-limit behavior | Child group settles, work/usage retained, retry/fallback remains bounded |
| Server restart | Stop/restart only the test installation during a recorded operation | No duplicate tasks/commits/accounting; explicit recoverable state |
| Failing test | Introduce a reviewed change that causes a known assertion to fail | No successful acceptance; evidence drives a bounded repair |
| Visual correction | Request one precise change against recorded preview evidence | Inspectable repair, before/after evidence, affected checks rerun |
| Stale evidence | Advance a relevant revision after a successful check | Old result remains historical; recheck required |

Do not intentionally exhaust a real provider account to simulate rate limiting.
Keep synthetic fault results separate from real-provider interruption evidence.

## Evidence to retain

For each run record: timestamp; Hoopedorc commit; reference repo/commit; settings
and environment identities; CLI/model identities; authentication class; resource
policy; plan/operation/task/run/PR IDs; test commands and outcomes; milestone and
artifact IDs; invocation totals/unknown usage; interventions; and remaining checks.
Never commit credentials, raw private transcripts, environment dumps or databases.

For each intervention record its cause, user-visible symptom, recovery taken,
time/usage spent, and proposed owning-layer fix. Rank reproducible correctness
and durability failures first, then repeated setup and workflow friction.

## Evidence record — 3 October 2026

Status: local readiness checked; live model run not started. The owner requested
a clear documentation checkpoint before execution continues.

- Baseline: `5bb62ba`; fetched `origin/main`, local main has zero ahead/behind
  commits and no tracked modifications. Existing untracked dependency directory
  preserved; implementation uses a separate clean worktree.
- Installed: Node `v22.23.0`, npm `10.9.8`, GitHub CLI `2.96.0`, Claude Code
  `2.1.278`, Codex `0.158.0`, OpenCode `1.18.30`.
- Docker executable is unavailable on PATH. Docker worker commissioning remains
  pending; native host evidence must be labelled accordingly.
- Codex differs from the VW17 inspected version (`0.154.0`); verify current native
  behavior before calling it compatible. No worker/selective claim is inferred.
- Authentication probes through the adapter's sanitized environment: Claude
  reports logged in with `oauth_token`/`firstParty`; Codex reports ChatGPT login,
  not API-key login. GitHub active-account authentication succeeds. Raw account
  and credential values were not printed or persisted in this evidence.
- Owner-selected live-call policy: **existing subscriptions only; no metered API
  spend**. Prepared an isolated test database with only Claude `sonnet` as
  planner/reviewer and Codex `gpt-6-sol` as author/docs, no fallback providers,
  and separate subscription pools capped at ten calls each per 24-hour window.
  Codex's installed `debug models --bundled` catalog lists `gpt-6-sol`; this
  establishes a catalog entry, not provider entitlement. Exact model availability
  remains pending a live response. Subscription accounting alone is not billing
  proof; the authentication class above must also remain true at invocation.
- A separate loopback test server was started with a dedicated database/repo
  directory and then stopped at the documentation checkpoint. No project was
  created and no model invocation or deployment was started. Operator settings
  and projects were not changed. Local preparation resides in
  `/private/tmp/hoopedorc-aw01-live`; recheck/recreate it if temporary files expire.
- Existing focused baseline checks passed: `node --import tsx --test
  packages/server/src/milestone-process.test.ts
  packages/server/src/planning-commit.test.ts
  packages/server/src/plan-changes.test.ts` — **14 passed, 0 failed, 0 skipped**.
  This includes real local Git/worktree/process behavior with deterministic
  provider doubles, not a real-provider journey. Local log:
  `/private/tmp/hoopedorc-aw01-baseline-tests.log`.
- Documentation validation: local Markdown link targets resolve and
  `git diff --check` passes. No product behavior changed, so the full local
  regression/UI suite was not repeated for this documentation-only PR. Required
  remote CI remains mandatory before merge.

Update this record with exact results as stages complete; link the PR/CI evidence
from Productization Plan Part 15. Keep an incomplete run explicitly incomplete.
