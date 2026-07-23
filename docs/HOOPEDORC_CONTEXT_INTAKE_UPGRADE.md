# Hoopedorc — Focused Context Handoff and Figma Fidelity Upgrade

**Status:** implementation in progress; F51 implemented and locally verified

**Approved:** 2026-07-23

**Roadmap:** `docs/PRODUCTIZATION_PLAN.md`, Phase 17 / Part 12

**Items:** F51, F52, B42, F53

## Purpose

This document replaces the earlier broad context/intake proposal.

The earlier proposal correctly identified two product needs:

1. an implementation agent should receive the context that is relevant to its
   task; and
2. an optional Figma design should survive planning and guide implementation
   and visual verification.

It incorrectly treated those needs as grounds for a new context platform,
project-memory hierarchy, skill registry, project-profile system, generic
capability registry, Figma compiler, and critic lifecycle. Hoopedorc already
has most of the required foundations. Building parallel systems would add
configuration and persistence risk without materially improving autonomous
execution.

The approved goal is narrower:

> After the owner approves a substantial plan, Hoopedorc should execute it
> with minimal involvement. When exact Figma screen frames are supplied,
> applicable tasks should use those frames and an automatic final visual-QA
> task should bring the implementation close to the design.

This is an incremental extension of the existing planning, task, scheduler,
gate, validator, retry, notification, and Git-durability paths. It is not a
rewrite.

## Owner decisions

The following decisions are approved:

- The dashboard remains the primary interface.
- Planning remains an interactive conversation.
- The owner will paste exact Figma node links into planning chat when design
  fidelity matters.
- A Figma fidelity source is normally a link to one top-level frame
  representing one screen or meaningful state, not a link to an arbitrary
  child layer.
- A whole Figma file/page link without a selected node is discovery context,
  not an enforceable fidelity reference. The planner should ask for the
  canonical screen frames when needed.
- Codex is currently the primary planner and deconstructor, but Hoopedorc must
  not hard-code Codex. Claude Code and OpenCode remain selectable and become
  equally eligible when their own Figma MCP access is configured and verified.
- Supplying at least one verified Figma screen enables automatic visual QA by
  default.
- A Figma or browser capability problem must be understandable and
  recoverable. It must preserve the plan or task, offer a retry/reroute path,
  and resume without repeating completed work.
- A preflight capability failure must not consume an author attempt.
- During autorun, a capability problem blocks only the affected task and its
  dependents. Other ready, non-conflicting work may continue.
- Skill selection remains small and operator-directed. The owner can name the
  relevant installed skills during planning; Hoopedorc should not invent a
  taxonomy from every skill installed on the machine.

## Existing architecture to reuse

The implementation must start from these shipped capabilities:

### Planning and durable context

- PlanView already provides interactive chat, editable PRD/task/AGENTS drafts,
  attachments, archived planning sessions, model selection, and plan cost.
- The planner already runs in the target repository and is instructed to
  inspect existing code instead of guessing.
- Follow-up planning already receives the prior PRD, recent tasks, and recent
  audit history.
- Images, PDFs, Markdown, text, CSV, and JSON can already be uploaded under
  `context/attachments/` and named in planner prompts.
- Deconstruction already creates a flat, validated task DAG with descriptions,
  acceptance criteria, dependencies, scope paths, role, difficulty, and
  suggested model.
- `AGENTS.md` and the conditional `CLAUDE.md` bridge are generated, editable,
  and committed with the PRD.
- B39 already makes plan approval a Git/SQLite durability boundary: exact
  planning artifacts are committed and pushed before tasks become runnable,
  partial failure preserves retryable scratch, and Start is refused while the
  project is `planning`.

### Task execution

- The author prompt already contains the task, acceptance criteria, working
  directory, allowed files, engineering standards, safety rules, project skill
  hints, and an `AGENTS.md` reminder.
- Objective gates, independent validation, fallback models, bounded attempts,
  rate-limit waiting, budgets, quotas, and approval policy already exist.
- Every project has one restart-safe scheduler/runtime owner. Manual dispatch
  joins the same scheduler.
- A blocked or failed task can already be reassigned in the dashboard and
  retried from the dashboard or Telegram without recreating the project.
- Notifications, task `statusReason`, logs, and audit entries already provide
  the surfaces needed to explain an interruption.
- Model invocations are accounted exactly once for planner, deconstructor,
  author, validator, docs, and health calls.

### Skills and runner configuration

F34's historical statement that skills are a Claude-Code-only mechanism is no
longer accurate for the installed runtimes:

- Claude Code supports user- and project-level skills.
- Codex supports installed skills/plugins.
- OpenCode supports skills and can discover external skills from
  `.agents/skills` and `.claude/skills`.

Hoopedorc already has `ProjectConfig.skillHints`, which adds small
operator-authored “skill — when to use it” nudges to author prompts. The
upgrade should correct the stale documentation and use this existing seam.
It should not add a database-backed skill marketplace.

Runner configuration and authenticated MCP configuration remain owned by each
CLI on the machine running Hoopedorc. Copying a skill to EC2 does not configure
or authenticate Figma MCP; those are separate deployment capabilities.

## The actual gaps

Only four gaps are in scope.

### 1. Relevant references are not a standing task convention

Task descriptions are not currently required to identify the exact PRD
heading, attached file, repository specification, or external design node an
author and validator should consult. Agents can inspect the worktree, but the
handoff can lose important planning nuance.

### 2. Figma links are unstructured planning text

The owner can paste a Figma URL into chat today, but Hoopedorc does not
distinguish an exact screen node from a whole file, verify that the selected
runner can open it, retain a small verified reference record, or ensure the
deconstructed tasks carry the right nodes.

### 3. MCP/capability failure is not a first-class recoverable block

A model with missing, unauthenticated, or temporarily unavailable Figma MCP
would currently fail as an ordinary planner/author problem. That can waste an
attempt and does not clearly tell the owner whether to retry, fix MCP, choose
another model, or attach a screenshot.

### 4. There is no automatic design-fidelity pass

The independent validator reviews task acceptance and the code diff, but there
is no guaranteed browser-based comparison between implemented screens and the
supplied Figma frames.

## Explicit non-goals

Do not build any of the following in this wave:

- a `.agent/` hierarchy of project, decision, pattern, and learning files;
- automatically curated long-term memory;
- a global skill registry or dashboard skill manager;
- a generic tool/MCP/capability registry;
- a project-profile or workflow-composition framework;
- a generic Project Intake application separate from planning;
- a context budget/cache/inspection dashboard;
- a normalized Markdown file for every Figma screen;
- a full-file Figma crawler or old/experimental-screen classifier;
- direct/compiled design modes;
- a raw Figma payload cache;
- design-sync or change detection;
- a generic Critic role or second orchestration lifecycle;
- pixel-perfect image-diff gating;
- hard-coded model names or a Codex-only design path;
- live Figma access in ordinary CI.

If later dogfooding shows repeated Figma calls, cross-agent interpretation
drift, or large multi-screen files are materially slowing work, a small cached
design manifest can be designed from evidence. It is not a V1 prerequisite.

## Target user workflow

### No-Figma project

The existing path stays unchanged:

```text
Planning chat
    ↓
Repository/PRD/attachments
    ↓
Editable PRD + AGENTS.md + task DAG
    ↓
Approve
    ↓
Autorun
    ↓
Gates + validator + merge
```

No-Figma projects must not make Figma probes, create visual-QA tasks, show
design warnings, or pay design-related model cost.

### Figma-backed project

```text
Planning chat
    ↓
Paste one exact Figma frame link per screen/state
    ↓
Selected planner inspects those nodes
    ↓
Deconstructor verifies and maps nodes to tasks
    ↓
PlanView shows verified frames and any capability issue
    ↓
Review/edit task models and references
    ↓
Approve
    ↓
Relevant frontend tasks run
    ↓
Automatic final visual-QA task
    ↓
Normal gates + independent validator + merge
```

The owner should be able to paste links naturally, for example:

```text
Implement these canonical screens closely:

- Login desktop: <Figma selection URL>
- Login mobile: <Figma selection URL>
- Dashboard populated: <Figma selection URL>
- Dashboard empty state: <Figma selection URL>
```

No separate intake wizard is required.

## Figma reference semantics

### Canonical fidelity reference

A canonical reference:

- uses an allowed Figma host;
- points to a design/file with a selected `node-id`;
- resolves to a top-level screen/frame or a meaningful screen state;
- is actually opened through the selected runner's configured Figma MCP;
- has enough returned metadata to prove the requested node was addressed
  (at minimum the node id and frame name; viewport dimensions when available).

The server should canonicalize stored links and avoid retaining unrelated query
parameters or secret-like values.

### Whole page/file links

A Figma link with no selected node may remain in planning chat as ordinary
context. It must not automatically trigger enforceable fidelity acceptance.
The planner should ask which frames are canonical rather than treating every
experiment, old version, playground, or component example as a product screen.

### Responsive interpretation

- If desktop and mobile frames are supplied, both are enforceable references.
- If only one viewport is supplied, that viewport is the visual source of
  truth. Other widths use the project's responsive conventions and best
  judgment; Hoopedorc must not claim they match an absent Figma design.
- Loading, empty, error, modal, and interaction states should have their own
  node references when their appearance materially matters.
- Static Figma cannot fully specify behavior. Planning conversation and
  acceptance criteria remain authoritative for interactions.

### Screenshot fallback

The existing attachment flow remains the fallback when:

- MCP authentication is unavailable;
- the owner intentionally does not want to configure Figma on a runner;
- a design is supplied as an image rather than a live Figma file; or
- the Figma service is temporarily unavailable and planning should continue.

An uploaded screenshot can guide implementation and visual QA, but the UI must
label it as an attachment reference rather than a verified live node.

## Minimal task-context convention

Do not introduce a generic Task Context Package object in V1.

The deconstructor should make each relevant task description self-contained
and add two small subsections when applicable:

```markdown
### Relevant references
- docs/PRD.md — Authentication / Login
- context/attachments/auth-copy.md
- Login desktop — <canonical Figma node URL>
- Login mobile — <canonical Figma node URL>

### Required skills/capabilities
- figma — inspect the referenced nodes before implementation
- figma-implement-design — use for the implementation pass
- browser verification — exercise the real screen at the referenced viewports
```

Rules:

- Include only references relevant to that task.
- Prefer file paths, headings, and exact node links over copied source
  material.
- Never invent a skill name. Use only skills the owner named for the project
  or fixed, documented skills installed for the approved Figma workflow.
- A task must still contain concrete acceptance criteria; references do not
  replace them.
- Both author and validator should be told to inspect the listed references.
- Existing `ProjectConfig.skillHints` remains the project-wide baseline.
  Task-specific skill names live in the task description for now.
- If structured references later become necessary for policy or querying, add
  a typed field in a separate evidence-backed change rather than pre-building
  it here.

## Runner and capability behavior

### Keep all model choices

Planner, deconstructor, author, and validator routing continue to use the
existing model configuration. Figma support must not remove Claude Code,
Codex, or OpenCode from general selectors.

When Figma references are present, eligibility depends on a successful
capability probe for the selected model/runner on the deployment machine.
Changing MCP configuration or rerouting the model should be enough to retry;
no project recreation is allowed.

### Probe the real boundary

Do not infer Figma support from:

- runner name;
- a configured MCP entry;
- a skill directory existing;
- marketing documentation; or
- a successful generic model-health prompt.

The probe must invoke the actual selected CLI with its normal sanitized
environment and ask it to open a representative referenced node through its
configured tools. One node per Figma file/model is sufficient for a short-lived
positive result; inaccessible files must be checked separately.

Probe calls count as `health` model invocations so quota and accounting remain
honest without adding another telemetry subsystem.

Positive probe results may be cached only for the current planning
session/current run or a short TTL. A server restart or expired result causes a
fresh check. A global durable capability registry is out of scope.

### Actionable issue shape

The web and logs need enough structured information to explain a failure:

```text
Stage: deconstruction
Model: Codex
Runner: codex
Reference: Login desktop
Problem: Figma MCP is configured but the node could not be read

Try:
1. Fix/re-authenticate Figma MCP for this runner, then Retry.
2. Select another Figma-capable model.
3. Attach a screenshot and continue without live-node verification.
```

Do not display tokens, MCP headers, full environment values, or secret-bearing
URLs.

## Failure, repair, and resume behavior

### Planning or deconstruction

When the selected planner/deconstructor cannot access a supplied node:

- retain the full planning conversation;
- retain any existing PRD, AGENTS, and task draft;
- identify the exact stage, model, runner, and node that failed;
- keep model selectors available;
- offer Retry after configuration is fixed;
- allow rerouting through existing Settings;
- allow screenshot fallback;
- do not clear or commit the plan;
- do not emit `[PLAN_COMPLETE]` or report a verified design when access was not
  proven.

Retry must continue from the same planning session. It must not create duplicate
tasks, commits, archives, or model-cost rows.

### Before author execution

For a task whose description contains verified Figma node references:

- perform a short-lived actual-node capability preflight for its assigned
  model before incrementing `Task.attempts` or launching the author;
- if the preflight fails, set the task to `blocked` with an actionable
  `statusReason`;
- create one deduplicated web notification and the configured Telegram alert;
- leave its dependencies and completed sibling tasks untouched;
- allow unrelated ready tasks to continue;
- do not open a worktree/PR or consume an author attempt.

After the owner fixes MCP or assigns another model, the existing Retry action
requeues the same task through the shared scheduler. The DAG and prior completed
work remain unchanged.

If MCP becomes unavailable after a successful preflight, author prompts should
instruct the runner to report a stable capability-unavailable marker instead
of pretending it inspected the design. The orchestrator should classify that
outcome as a recoverable capability block rather than “author produced no
changes.”

### Visual QA

If Figma or browser access fails during visual QA:

- block the visual-QA task with the same actionable issue behavior;
- do not merge work that claims close Figma fidelity without completing the
  visual pass;
- keep already merged prerequisite tasks and their audit history;
- reroute/retry the visual-QA task after the capability is restored.

This is a fail-closed fidelity promise, not a rollback of completed work.

## Automatic visual-QA task

Presence of at least one verified canonical Figma node causes the server to
insert one visible, editable visual-QA task into the draft DAG before the
standing docs task is finalized.

Use a focused pure helper, analogous to `ensureDocsTask`, rather than teaching
the whole engine about a Critic role.

### Dependencies and routing

- The visual-QA task depends on every non-doc implementation task in the
  current planning batch so it sees the integrated application.
- The standing docs task depends on visual QA and remains last.
- The visual-QA task uses the existing `frontend` role and an author model that
  passed the Figma capability probe.
- The owner may edit its model, description, criteria, scope, or dependencies
  in the existing task table.
- Removing the task in the reviewed draft is the explicit opt-out; commit must
  not silently add it back.
- No visual-QA task is created when there are no verified design references.

### Work performed

The task instructs its author to:

1. read `AGENTS.md`, the relevant PRD sections, and every referenced Figma
   frame;
2. determine the real repository command for starting the application;
3. use a non-conflicting local port and the configured browser-verification
   capability;
4. navigate to each reachable designed state;
5. capture the implementation at each supplied Figma viewport;
6. compare hierarchy, layout, spacing, typography, colors, components,
   responsive behavior, and important states;
7. fix material discrepancies in the same worktree;
8. exercise relevant interactions, loading, empty, error, and responsive
   states named by the plan;
9. run the repository's normal checks before finishing; and
10. summarize what was compared, corrected, and not verifiable in task logs.

The comparison is visual and behavioral judgment, not a raw pixel-diff gate.
Font rendering, antialiasing, browser chrome, and dynamic content make exact
pixel equality brittle. “Closely matches” means the implementation preserves
the design's material structure and appearance at the referenced viewports.

### Bounded repair

Visual correction happens inside this ordinary task and its existing bounded
attempt/fallback budget:

```text
visual-QA author inspects and repairs
    ↓
normal objective gates
    ↓
independent validator
    ↓
merge or existing bounded retry/escalation
```

Do not add an unlimited screenshot → critic → repair loop. Do not create a new
model role or merge path.

### Planning prerequisites

The planner must identify anything visual QA needs to reach the designed state:

- app start command;
- route;
- viewport;
- fixture/seed data;
- authentication state;
- feature flags;
- required backend service; and
- interaction needed to reveal a modal/error/empty state.

If a designed state cannot be reproduced without unresolved product or test
data decisions, the planner should ask during planning rather than leaving the
visual-QA task to guess.

## Persistence and contract boundaries

Keep the new durable state minimal.

- Planning messages remain the original source of pasted URLs.
- F52 may add one nullable JSON planning-session field containing the small
  verified reference list (canonical URL, node id, name, viewport/file
  metadata, verification model, and timestamp). This is planning scratch, not
  a global cache.
- The field follows the existing `planning_*` lifecycle: save on successful
  verification, restore on PlanView reload, retain on failure, and clear only
  after durable plan commit.
- The committed PRD/task descriptions retain the canonical references needed
  by downstream work. Do not create machine-maintained screen Markdown files.
- Existing task fields are sufficient in V1. Capability interruption uses
  `status`, `statusReason`, logs, notifications, and audit entries.
- Existing Retry and model reassignment remain the resume path.

Any contract change must update:

1. `packages/types/src/api.ts`;
2. `ROUTES`;
3. `docs/CONTRACT.md`;
4. the exact server route/behavior;
5. mock behavior;
6. `apps/web/src/api/client.ts` usage; and
7. server/web tests.

Any SQLite field must use an idempotent migration, update `schema.sql`, preserve
old rows, and keep planning finalization transactional.

## Security and reliability

- Treat pasted URLs, node names, frame text, and MCP output as untrusted input.
- Accept only known Figma hosts for automatic node handling.
- Require a selected node id for a canonical fidelity reference.
- Canonicalize links and redact unrelated query parameters from logs.
- Never accept a client-supplied MCP command, executable, config path, token,
  header, or environment variable.
- Invoke only the fixed configured model/runner through existing adapter
  factories and sanitized environments.
- Bound URL count, URL length, probe output, probe timeout, and stored metadata.
- Abort probes during graceful shutdown and record their invocation terminal
  state exactly once.
- Deduplicate repeated capability notifications.
- Never convert a capability error into a passing design check.
- Preserve the primary clone, planning drafts, attachments, unrelated changes,
  and completed tasks on every failure/retry path.

## Cost and latency

- No-Figma paths make zero new calls.
- Reuse the selected planner's normal design inspection where practical.
- Probe once per distinct model/Figma file for the current planning session or
  run, not once per frame when file-level permission is shared.
- Record probe calls as health invocations.
- Do not add context-size, cache-hit, or Figma-fetch dashboards.
- The one automatic visual-QA task is the intentional cost of promising close
  design fidelity.

## Implementation roadmap

Each item is a separate, reviewable branch/PR unless repository investigation
shows two adjacent items cannot be safely separated. Do not begin a later item
until the prior PR is merged and independently checked.

### Phase 17.1 — F51: lean task references and runner-accurate skills

**Status:** implementation complete and locally verified on
`f51-lean-task-references`.

**Goal:** Preserve planning nuance in ordinary task handoffs without adding a
new context schema.

**Likely owners/files:**

- `packages/server/src/planner.ts`;
- `packages/engine/src/orchestrator.ts`;
- `packages/engine/src/validator.ts`;
- prompt/unit tests;
- `packages/types/src/domain.ts` comments;
- `docs/USER_GUIDE.md`;
- `docs/CONTRACT.md`.

**Implementation:**

- Require self-contained task descriptions.
- Add the `Relevant references` and `Required skills/capabilities`
  conventions to deconstruction.
- Tell authors and validators to inspect listed references.
- Preserve current `ProjectConfig.skillHints` as the project baseline.
- Correct Claude-only/OpenCode-no-skills statements using verified installed
  CLI behavior.
- Document the small operator-selected EC2 skill set and keep MCP setup
  separate.

**Acceptance:**

- A task referencing a PRD section and attachment carries those exact pointers
  into both author and validator prompts.
- Figma is not required for this item and no-Figma output remains compatible.
- Empty reference/skill sections are omitted.
- No Task/SQLite/API field is added.
- Skill docs accurately cover Claude Code, Codex, and OpenCode without
  promising identical discovery semantics.

**Tests:**

- planner prompt-content tests;
- author prompt-content tests;
- validator prompt-content tests;
- well-formed existing plan output remains compatible;
- missing references produce no empty prompt noise.

**Verification (2026-07-23):** typecheck, build, lint, 164 engine tests, 12
adapter tests, 175 server tests, 20 web tests, 14 Playwright tests, and
`git diff --check` passed locally. No API route, task field, or SQLite schema
was added.

### Phase 17.2 — F52: direct Figma nodes and planning verification

**Goal:** Turn exact Figma selection URLs in planning chat into a small,
verified, durable planning reference list.

**Likely owners/files:**

- `packages/types/src/api.ts` and `ROUTES`;
- `packages/server/src/planner.ts`;
- planning routes in `packages/server/src/index.ts`;
- `packages/server/src/db/index.ts`, `schema.sql`, and `repo.ts`;
- `apps/web/src/pages/PlanView.tsx`;
- mock server and planning tests;
- `docs/CONTRACT.md` and `docs/USER_GUIDE.md`.

**Implementation:**

- Extract and canonicalize exact Figma node URLs from planning messages.
- Keep whole-file/page links as ordinary chat context.
- Have the selected planner inspect references during conversation.
- Make deconstruction return verified node metadata or an actionable typed
  capability issue.
- Persist only the small verified planning list.
- Restore it on reload and show verified frame/model state in PlanView.
- Map relevant nodes into task descriptions and acceptance criteria.
- Preserve every planning artifact when verification fails.

**Acceptance:**

- Pasting two exact frame links produces two verified references with their
  real names/node ids and available viewport metadata.
- A file/page link without a selected node prompts for frames and does not
  silently become fidelity acceptance.
- Missing auth, missing MCP, inaccessible file, invalid node, timeout, and
  malformed MCP output each produce actionable non-secret errors.
- Switching planner/deconstructor routing, fixing MCP, and retrying uses the
  same planning session without duplicate drafts, tasks, commits, archives, or
  costs.
- Reload preserves verified references.
- A no-Figma conversation is byte-compatible at the contract level where
  possible and makes no probe call.

**Tests:**

- URL allowlist/canonicalization/bounds;
- selected-node vs file/page classification;
- successful/missing/unauthorized/timeout/malformed probe doubles;
- planner/deconstructor reroute and retry;
- planning-session migration/round-trip/clear-on-commit;
- mock UI verified/error/retry states;
- no-Figma regression.

**Live check:**

- On the deployment environment, the selected Codex planner opens a real
  owner-supplied frame and PlanView shows its actual frame identity.
- Repeat once for Claude Code and OpenCode only after their Figma MCP
  configurations are installed; lack of configuration is an expected
  actionable result, not a reason to remove those models from selectors.

### Phase 17.3 — B42: recoverable Figma capability blocks

**Goal:** Prevent missing design access from wasting attempts or silently
degrading fidelity during autorun.

**Likely owners/files:**

- shared capability issue types;
- `packages/server/src/engine-runner.ts`;
- `packages/engine/src/orchestrator.ts`;
- adapters/failure classification where needed;
- task/notification UI and tests;
- Telegram notification wiring;
- `docs/CONTRACT.md` and `docs/USER_GUIDE.md`.

**Implementation:**

- Probe the actual assigned model before a Figma-dependent author attempt.
- Reuse a planning/run-scoped positive result within bounds.
- Detect a stable capability-unavailable author marker after a mid-call loss.
- Block only the affected task with actionable `statusReason`.
- Notify once, preserve attempts and DAG state, and keep unrelated scheduling
  active.
- Reuse model reassignment and Retry to resume.

**Acceptance:**

- A failed preflight leaves `attempts` unchanged and creates no worktree,
  branch, commit, PR, gate, or validator call.
- The affected task becomes blocked with model/runner/reference/recovery
  context.
- Independent ready tasks continue.
- Fixing MCP and Retry resumes the same task.
- Reassigning to another verified model and Retry resumes the same task.
- Restart while blocked preserves the explanation and does not auto-consume an
  attempt.
- A mid-author capability loss is not misreported as “no changes.”
- Notifications are deduplicated and secrets are redacted.

**Tests:**

- success, auth failure, missing MCP, timeout, node denial, and mid-call loss;
- no-attempt/no-worktree proof;
- unrelated scheduler progress;
- retry/reroute/restart behavior;
- notification/Telegram dedupe and redaction;
- no-Figma tasks bypass the hook.

**Live check:**

- Disable or misconfigure Figma MCP for one routed model on a scratch project,
  observe the actionable block, restore it, Retry, and confirm the same task
  proceeds without an extra failed author attempt.

### Phase 17.4 — F53: automatic visual-fidelity QA task

**Goal:** Make close Figma fidelity the default execution outcome whenever
verified screen nodes are supplied.

**Likely owners/files:**

- a focused server helper analogous to `docs-task.ts`;
- deconstruct/draft task assembly in `packages/server/src/index.ts`;
- PlanView task review;
- engine prompt guidance;
- mock and browser tests;
- `docs/CONTRACT.md` and `docs/USER_GUIDE.md`.

**Implementation:**

- Deterministically insert one visual-QA draft task when verified nodes exist.
- Order it after implementation and before the standing docs task.
- Include every verified node, relevant route/state/fixture, required
  capabilities, and material fidelity criteria.
- Assign a verified Figma-capable frontend model while leaving the field
  editable.
- Run comparison and repair through the normal author/gate/validator pipeline.
- Use B42 for Figma/browser capability blocks.
- Do not re-add a visual-QA task the owner explicitly removes before commit.

**Acceptance:**

- Verified Figma nodes produce exactly one visible visual-QA task.
- No-Figma plans produce none.
- The task depends on all non-doc tasks and the docs task remains last.
- Duplicate deconstruction/regeneration does not create duplicates.
- Desktop/mobile/state nodes become distinct acceptance entries.
- A single supplied viewport is not misrepresented as mobile fidelity.
- The task starts the real app, inspects each reachable state, repairs material
  differences, runs gates, receives independent validation, and merges through
  the existing path.
- Figma/browser failure blocks and resumes through B42.
- There is no generic critic loop or alternate merge path.

**Tests:**

- pure DAG insertion/dependency/idempotency tests;
- task-description/reference/viewport tests;
- PlanView interaction tests for generated task, model edit, and explicit
  removal;
- Playwright mock coverage for Figma and no-Figma plan review;
- engine prompt/blocked-retry behavior;
- full repository gate.

**Live check:**

- Use at least one desktop and one mobile owner-supplied Figma frame on a
  scratch UI project. Complete plan → autorun → visual QA, inspect the browser
  result at the referenced viewports, and record the actual task/PR evidence.

## Required delivery workflow

For the documentation approval PR and every later implementation item:

1. Fetch and verify clean, current `main`.
2. Create one descriptive branch.
3. Restate the item, dependencies, non-goals, acceptance criteria, and live
   checks.
4. Trace the actual contract, persistence, server, engine, UI, test, and
   deployment paths before editing.
5. Change shared contracts first when a contract changes.
6. Implement the smallest owning-layer change.
7. Add regression coverage for success, failure, retry/reroute, restart, and
   no-Figma compatibility as applicable.
8. Run focused checks while iterating.
9. Run every repository gate before handoff:

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

10. Verify UI changes in a real browser at 360, 390, 768, 1280, and 1440px.
11. Exercise the real CLI/MCP/browser boundary for the phase's live acceptance;
    mocks do not replace that evidence.
12. Update contract, architecture, user guide, roadmap, and focused spec in the
    same PR.
13. Commit with the roadmap ID, push, open a PR, wait for green required CI,
    inspect the final diff/checks, and merge without bypassing failures.
14. Independently verify the merged commit for each substantial phase before
    beginning the next.

## Final success criteria

The wave is complete when:

- ordinary plans hand authors and validators concise, relevant references;
- skill documentation matches the real installed runners;
- exact Figma screen links can be supplied naturally in planning chat;
- selected runners prove actual access instead of being trusted by name;
- access failures explain the model, runner, node, cause, and recovery path;
- planning and task state survive fix/reroute/retry without duplication;
- a preflight failure consumes no author attempt;
- unrelated tasks continue while one Figma task is blocked;
- Figma-backed plans automatically include one final visual-QA task;
- the visual task compares and repairs the integrated app at supplied
  viewports through the existing gate/validator/merge path;
- no-Figma projects remain unchanged; and
- no global registry, context platform, design compiler, or generic critic
  framework has been introduced.
