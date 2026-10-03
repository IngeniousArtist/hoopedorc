# Complete app workspace plan

Owner-approved direction: 3 October 2026. Initial audited baseline: `5bb62ba`.
Primary user: the owner, working as a technical solo builder with several model
subscriptions. Status and evidence are indexed in
[Productization Plan, Part 15](PRODUCTIZATION_PLAN.md#part-15--complete-app-workspace).

## Product goal

Give Hoopedorc a brief, a repository and references; use a small model team to
plan, implement, verify and ship a working app. The owner should be able to
inspect the result, make decisions and request corrections without manually
coordinating each model, terminal and test environment.

The primary measure is verified product progress for the human effort and
resources spent. Task count, token volume and concurrent agents are supporting
diagnostics, not the definition of success.

## Read this first

The VW01–VW18 implementation wave is already merged. Preserve its single
scheduler, task worktrees, repository locks, planning receipts, independent
review, accounting, previews, Library, capability controls, resource pools,
environment profiles and milestone checks. This plan extends those capabilities.

Implementation completion does not establish live provider or deployment
acceptance. Start with AW01 and the
[commissioning runbook](specs/app-workspace-commissioning.md). Record actual
interventions, then prioritize fixes using that evidence. The earlier
[commissioning matrix](specs/commissioning.md) remains authoritative for the
unverified VW deployment/provider boundaries.

Use `AGENTS.md` for contribution workflow. One tightly scoped item per branch and
PR; contracts first; focused local checks during the wave; required GitHub CI
before merge. Perform the comprehensive local regression after this wave, and
retain the separate real-provider and deployment acceptance requirements.

## Existing foundation and remaining gaps

| Area | Implemented foundation | Next improvement |
| --- | --- | --- |
| Planning | Repository inspection, chat, editable PRD/tasks, durable operations, reviewed revisions | Structured product requirements and visible coverage |
| Models | Harness adapters, routing, fallback, account pools, quotas, independent review | Feasible team presets and measured allocation |
| Execution | Dependency/scope scheduling, worktrees, cancellation, restart recovery | A proven real-provider journey through failures |
| Design | Figma references, Library, generated visual QA, preview artifacts | Early design direction and direct visual corrections |
| Verification | Gates, browser captures, criterion evidence, bounded milestone repair | Repeatable authenticated journeys and typed evidence links |
| Environments | Node/Python requirements, setup/gates, task previews, isolated profiles | Reproducible services and isolated test data |
| Delivery | GitHub PR/check/merge policy and rollback PRs | Target-app staging, release records and recovery |

The October review inspected source/contracts and the desktop mock interface.
It did not exercise paid model calls, live deployment or a fresh responsive
verification pass. Existing September test evidence is historical, not a rerun.
Browser automation/sandbox errors encountered during the review are tooling
limitations and are not product defects without an independent reproduction.

## Experience to build toward

1. Connect a repository or select the supported app starter.
2. Verify the environment and available model team before implementation calls.
3. Agree on users, journeys, scope, design direction and acceptance criteria.
4. Review the next milestone, dependencies, model allocation and resource limits.
5. Watch independent work progress while the scheduler owns task execution.
6. Open the integrated preview and inspect evidence for each requirement.
7. Request a correction, review its scope, and compare the verified result.
8. Deploy the verified revision to staging, check it, then approve production.
9. Turn a later defect into a reproduction, repair and verified release.

Small fixes keep a short single-task path. Large briefs detail the next
milestone and revisit later work after evidence arrives. A heavyweight planning
ritual is not required for every change.

## Delivery sequence and acceptance

### AW01 — Prove the reference journey (first)

**Problem:** the implemented capabilities have not yet been accepted together
on the intended provider accounts.

Use a dedicated client-portal reference project: sign-in, client/admin roles,
projects, file uploads and an activity feed. Begin with a smaller existing-repo
feature to verify the harness/Git/gate path before the complete app run.

Acceptance:

- Record exact repository, engine revision, CLI/model identities, authentication
  class, environment mode and resource limits without recording credentials.
- Exercise planning approval and its durable Git/task receipt; retry/reopen must
  not duplicate tasks or commits.
- Complete two independent tasks through the existing scheduler and PR workflow,
  with a valid independent reviewer and combined-revision milestone evidence.
- Deliberately exercise one provider interruption, one control-plane restart,
  one failing test and bounded repair, and one requested visual correction.
- Verify the original product journeys, including unauthorized access refusal,
  persistence, upload validation and useful empty/error states.
- Record each manual intervention and total usage, including unknown usage.
- Keep staging/release acceptance explicitly pending until the required target
  and AW09 capability are available; local previews are not deployment evidence.

**Dependencies:** authenticated profiles, valid reviewer allocation, dedicated
repository and app data, approved live-call policy. Docker/remote acceptance
requires a compatible provisioned environment. **Non-goals:** silently install
or log into providers, provision a cloud host, weaken merge checks, or claim a
mock run proves live acceptance. Detailed procedure: the commissioning runbook.

### AW02 — Feasible model teams and preflight

Present responsibilities and account resources before model slugs. Offer
subscription-only, balanced and quality-first allocation presets, retaining
inspectable assignments and existing advanced settings.

Acceptance:

- A preset resolves only to configured, eligible profiles; it does not invent
  model IDs, account entitlement, pricing or capacity.
- Validate planner, author, reviewer, fallback and capability compatibility
  before starting a plan. Reserve a reviewer independent of all milestone
  authors; a two-model team can reserve one model exclusively for review.
- Explain missing capabilities, shared-account constraints and unavailable
  actions, with an actionable next step.
- Subscription-only never silently falls back to a metered profile.
- Existing in-flight invocations retain their snapshots; settings writes remain
  normalized and resource admission remains owned by the existing services.

**Depends on:** AW01 findings. **Owners:** shared types, settings/resource and
activation policies, setup/planning preflight, web configuration.

### AW03 — Project outcome overview

Make the default workspace answer: what are we building, what works, what is in
progress, what needs a decision, and what can I test?

Acceptance:

- Show milestone acceptance, latest usable preview, blockers and next actions
  with links to existing Plan/Board/Review/Workspaces surfaces.
- Separate completed tasks from accepted product outcomes. Stale/unavailable
  evidence must not appear current or passed.
- Consolidate attention without hiding task-level engineering detail.
- Preserve deep links and keyboard access; verify loading, empty, error and
  success at 360/390/768/1280/1440px with no document overflow.

**Depends on:** baseline evidence and existing milestone/preview APIs. **Owners:**
web first; add shared read contracts only for data not already available.

### AW04 — Executable product requirements

Extend the PRD with stable requirement identities and explicit links to tasks,
verification and milestones. Cover roles, screens/states, data, permissions,
integrations, environment needs, exclusions and open decisions.

Acceptance:

- A reviewed brief exposes uncovered requirements and missing verification
  methods before execution; each claimed outcome links to its evidence.
- Changes show their impact on pending work and acceptance. Preserve original
  criteria and historical evidence; do not silently weaken failed criteria.
- Detail the next milestone while keeping later milestones lightweight.
- Keep Task as the execution unit and preserve legacy task IDs/history. Additive
  migrations and existing planning commit receipts own persistence.

**Depends on:** AW01 and AW03. **Owners:** types, planner/plan changes/persistence,
milestone policy, Plan and Review UI.

### AW05 — One complete app environment

Deliver one TypeScript web starter with authentication, a database, uploads,
seeded test users/data and browser tests. Select its concrete stack from the
reference journey before freezing a template. Imported projects reuse detected
commands and components.

Acceptance:

- Setup and baseline checks succeed before author calls; startup has bounded
  readiness checks and actionable failures.
- Services, ports, test databases/storage and fixtures have workspace ownership
  and do not leak mutations across concurrent tasks.
- Migrations and seed/reset procedures are repeatable. Reset is limited to
  validated disposable test resources, never operator/production data.
- Secrets are referenced and supplied at the correct boundary, absent from
  prompts, artifacts and unrelated subprocess environments.
- Reuse existing setup/preview/process ownership. Report actual isolation; do
  not equate worktrees or native host processes with a sandbox.

**Depends on:** AW01; use AW02 readiness. **Owners:** environment types, engine
setup, server preview/execution services, project setup UI.

### AW06 — Reusable acceptance journeys

Extend the current bounded browser capture with named repository-owned journeys,
fixtures, test accounts, upload/download checks, API assertions and explicitly
configured service access.

Acceptance:

- Run the reference journey from sign-in through durable state and cross-user
  access refusal; test reload, validation and service-error behavior.
- Distinguish code, integration, browser and deployment checks. An executed
  passing test artifact backs machine-checkable criteria; prose alone does not.
- Evidence identifies requirement, exact revision, environment and fixture.
  Changed revisions/data invalidate freshness appropriately.
- Cancellation, retries, stale evidence and restart retain existing ownership
  and accounting guarantees. External service access is explicit and scoped.
- Repository tests remain runnable without Hoopedorc, with failures linked to
  useful screenshots/traces/diagnostics in Review.

**Depends on:** AW04/AW05. **Owners:** review/evidence types, browser worker,
milestone verification and Review UI.

### AW07 — Design direction and visual corrections

Extend Library and Review with a concise approved design brief, tokens and
component references, an early representative screen, comparison views and
annotations tied to a specific screenshot/route/viewport/revision.

Acceptance:

- Reuse an imported app's design system and components; Figma remains optional.
- An annotation becomes an inspectable scoped repair proposal through the
  existing plan-change flow, preserving unsent drafts and active-task ownership.
- Show before/after evidence and rerun affected checks. Visual approval never
  bypasses required code checks.
- Large design changes can have a checkpoint without forcing one for every
  small correction; follow the owner's selected policy.

**Depends on:** AW03/AW06. **Owners:** Library, review evidence, plan changes, web.

### AW08 — Cause-based recovery

Explain whether a failure is provider capacity, capability, environment, code,
integration or inadequate planning, and offer the appropriate next action.

Acceptance:

- Reuse durable retry/fallback and milestone repair. Classifications attach
  evidence and preserve uncertainty rather than presenting guesses as facts.
- Repeated identical failures stop spending calls without a changed condition
  or explicit bounded policy; no retry path resets durable budgets.
- Independent eligible work continues. Dependencies and active ownership remain
  enforced; repairs and plan application are idempotent across restart.
- A run report shows accepted outcomes, blockers, preserved work, usage and
  next actions. Existing notification channels remain opt-in.

**Depends on:** AW01 findings; AW06 improves diagnosis. **Owners:** engine policy,
server durable state/run reporting and attention UI.

### AW09 — Target-app releases

Add one supported deployment target: verified revision → staging → smoke tests
→ production approval → health checks. This is distinct from Hoopedorc's updater.

Acceptance:

- Each release records source revision, artifact identity, configuration
  version, migration state and verification evidence.
- Retries/restart reconcile the same release without duplicate deployments.
- Promote the tested artifact under explicit policy; required checks remain
  fail-closed. Display drift and failure with recovery actions.
- Recovery states which code/config/data it restores. Never assume a code
  revert undoes database migrations or external effects.
- A production defect can create a reproduction/repair proposal and verified
  follow-up release through the existing execution system.

**Depends on:** AW05/AW06 and a chosen/provisioned deployment target. **Owners:**
types, a focused server release service and store, existing runtime ownership,
release UI. **Non-goal:** an arbitrary client-supplied shell runner.

### AW10 — Inspectable project knowledge

Build on planning archives, AGENTS.md and Library: retain architectural decisions,
design conventions, constraints, failed approaches and proven verification steps.

Acceptance:

- Every entry has provenance and scope; accepted decisions can be superseded
  without deleting their history.
- Task context shows selected sources and revisions; stale/conflicting guidance
  is visible and bounded context does not grow with every conversation.
- Do not add speculative retrieval infrastructure until measured examples need
  it. Reuse existing versioned references and activation manifests.

**Depends on:** AW04 and observed context failures. **Owners:** Library/planning
store, invocation preparation, context UI.

### AW11 — Optimize using measured outcomes

Measure model/role first-pass acceptance, repairs, latency, observed cost,
unknown usage and quota consumption on comparable tasks. Extend existing offline
routing evaluation; synthetic examples are not measured savings.

Acceptance:

- Compare with the current static baseline using held-out observations and
  repair-inclusive costs. Label small samples and confounding differences.
- Enable a live routing pilot only after measured benefit and a separate
  decision; preserve bounded static fallback and account/capability constraints.
- Broaden stacks/providers only when the first path succeeds repeatedly.

**Depends on:** AW01–AW09 evidence. **Owners:** existing invocation ledger,
analytics and routing-evaluation services. No permanent model-manager loop.

## Recommended order

| Phase | Items | Exit condition |
| --- | --- | --- |
| Baseline | AW01 | Real-provider evidence and ranked interventions; pending boundaries explicit |
| Daily use | AW02–AW04 | A feasible plan and its next action are understandable from the workspace |
| Full apps | AW05–AW06 | Auth/data/uploads work across tasks and combined verification |
| Iteration | AW07–AW08 | Corrections and failures lead to bounded, verified recovery |
| Release | AW09 | Stage, promote, check and recover an accepted app |
| Learning | AW10–AW11 | Better context/allocation demonstrably reduce human effort or total cost |

AW01 is a continuing evidence track: its first local/provider slice precedes
feature work; its full-app and deployment checks close as AW05/AW06/AW09 land.
It must not create a circular prerequisite for those features. Independent
documentation, deterministic fixtures and verified local fixes can proceed when
a provider, Docker or remote-host check is unavailable, with that check pending.

## Measures and decisions

Track time to first working preview; accepted milestone rate; human interventions
per accepted milestone; total repair-inclusive cost and subscription calls;
recovery time; and defects discovered after release. Record the baseline before
choosing numerical improvement targets. Do not report unavailable provider
allowance as zero or guessed headroom.

Defer a marketplace, multi-tenant SaaS, distributed scheduling, a full browser
IDE and broad native-platform support. Keep the single-operator boundary until
the complete supported journey is useful repeatedly.

Current external references inform direction, not compatibility claims:
[Cursor agent environments and artifacts](https://cursor.com/docs/cloud-agent)
and [Replit development checkpoints](https://docs.replit.com/features/version-control/checkpoints-and-rollbacks).
Installed runtime behavior and Hoopedorc's own evidence remain authoritative.

## Continuing the work

Read the Part 15 status table and the AW01 runbook's evidence record first.
Reconfirm current main and tool versions. Start the next unfinished, unblocked
acceptance slice on a descriptive branch. Update this plan only when scope or
decisions change; put exact commands, results, PRs and remaining checks in the
roadmap/runbook. Never relabel a pending live check as passed from a fixture.
