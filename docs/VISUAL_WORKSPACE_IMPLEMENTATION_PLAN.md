# Visual workspace implementation plan

Implementation handoff · 21 September 2026 · audited baseline: 75c146e

This document records the requested product direction and implementation sequence after inspecting the running UI, source, tests, and historical roadmap. It is the focused specification for Part 14 of [PRODUCTIZATION_PLAN.md](PRODUCTIZATION_PLAN.md#part-14--visual-development-workspace), whose status table records each VW item's current state, PR, and evidence. This document itself does not approve unresolved authentication, isolation, or compatibility choices.

[Open the clickable layout concept](design/visual-workspace-concept.html). This is a self-contained HTML file with sample data and no external dependencies. Its script syntax and view/label targets were checked statically. The browser tool blocked opening the local file, so rendered layout and interaction verification of the concept remain outstanding.

## Start here

VW01–VW10 are implemented as of 21 September 2026 (AWS validation is owner-deferred);
see the [current status and evidence](PRODUCTIZATION_PLAN.md#part-14--visual-development-workspace).
VW11 is in progress. The next item after its merge is **VW12 — selective skills,
plugins and MCP activation**. The initial
VW01 → VW02/VW03 → VW04 sequence remains the dependency foundation for the
later work. Do not start by replacing the engine, creating a second
scheduler, or implementing every screen at once.

For each item:

1. Read [AGENTS.md](../AGENTS.md), this item's acceptance criteria, and the
   relevant current contract/source. Reconfirm audit findings against current
   main before editing.
2. Start from clean, current main on one descriptive branch. Reproduce a bug
   before or alongside its fix. Keep migrations additive and preserve operator
   data, planning revisions, task IDs, and worktrees.
3. Change the shared contract first if necessary, including ROUTES, server,
   mock, web client, persistence, tests, and CONTRACT.md. A pure UI rearrangement
   should not invent a replacement domain model.
4. Follow AGENTS.md's current owner-requested testing policy: focused local
   coverage per item, comprehensive local regression after the plan finishes,
   and unchanged required GitHub CI before merge. Record exact evidence,
   unavailable live checks, and the PR in the Part 14 status table. Merge only
   after required CI passes; verify substantial merged changes independently.
5. Start the next item from the merged result. Do not combine unrelated slices
   into a large rewrite PR.

**Next implementation request:** “Implement VW12 from
VISUAL_WORKSPACE_IMPLEMENTATION_PLAN.md, starting from reviewed main. Add
per-attempt activation with enforced or explicitly unsupported harness isolation,
preserving CLI-owned authentication and reference history. Follow AGENTS.md's focused
testing policy through verification and PR.”

## Recommendation

Keep Hoopedorc's scheduler, worktrees, Git protections, persistence, adapters, validation, accounting, and Telegram integration. Rework the experience around a project workspace where a designer can plan an outcome, inspect the product, direct agents, and review evidence. Add missing runtime services incrementally.

The product promise should be: “Give Hoopedorc a brief, your project, and your references. Manage the work visually while agents implement and verify changes within your chosen resources and autonomy.”

Large briefs should produce resumable progress through milestones. A small fix should use the same execution system with one task and minimal planning. “Autonomous” must mean bounded decisions, preserved work, and useful recovery, rather than an assurance that every large brief succeeds without intervention.

The initial audience should be individual designers who build software, technical founders, and small development teams using their own machines or AWS. Preserve the present single-operator deployment boundary first; multi-tenant hosted SaaS would be a separate project.

## What the audit established

Evidence labels distinguish browser observations, source findings, existing tests, and work that still needs live verification.

| Finding | Evidence | Consequence |
|---|---|---|
| The project already contains substantial orchestration infrastructure. | Architecture, contract, engine/server sources; 102 focused server tests passed. | Retain it; do not replace the scheduler to deliver a better UI. |
| Navigation mixes project work with installation administration. | Browser: nine destinations, including Board, Plan, Model Slugs, Setup, and Settings. | Separate project navigation from global connections and settings. |
| The board gives substantial space to configuration and execution metrics before showing work. | Browser: first column heading around y=513 at 1440×900 and y=634 at 360×900 in the paused fixture. | Compact the header; move configuration into project settings and details into task inspection. |
| Settings is too much configuration at once. | Browser: 165 input/select/textarea elements and 6,792px document height at 1280×800 in the six-model fixture. | Account/connection overview, focused detail forms, presets, and advanced disclosure. |
| The board fits the document width but requires horizontal browsing. | Checked 360, 390, 768, 1280, 1440 widths. No document overflow in this fixture; phone Stop buttons and collapsed lanes were under 40px wide. | Preserve contained scrolling; add a practical phone list and meet touch-target rules. |
| Planning becomes unavailable while tasks run. | Browser and PlanView running guard. | Separate a proposed revision from the active execution plan so steering does not rewrite running tasks. |
| Failed planning sends lose the typed message. | Source: PlanView clears input, then the failure branch rolls back messages without restoring input. | Preserve the composition and show retry state. This was not deliberately failure-injected in the browser. |
| Draft saving can fail silently. | Source: debounced planSaveDraft catches and ignores failures; UI says edits are auto-saved. | Explicit Saving / Saved / Save failed states; retry and navigation protection. |
| First-plan handling can confuse an existing repository with an empty project. | Server buildPriorContext returns undefined when there are no committed tasks; deconstruction then inserts “brand-new project” scaffolding instructions. | Determine repository state from inspection, independently of task history. |
| Planning can silently run outside the repository. | resolvePlannerCwd catches clone errors and returns the temporary directory. | Show repository inspection failure and retry; an explicitly chosen brief-only draft must disclose its limited context. |
| Follow-up prompts overstate what is already implemented. | priorContextBlock says treat prior context as done; supplied tasks include non-done states. | Preserve task status, accepted changes, failed work, and current repository evidence distinctly. |
| Mock mode is not isolated from model calls. | One sample chat invoked the real planner; UI reported $0.15. Route inspection confirms no mock planner branch. | Fix mock planning before using it as a safe demo or broad UX-test environment. No further planner calls were made. |
| Review is a narrow drawer with Overview, Logs, Review, and PR. | Browser; TaskDrawer uses 420px desktop width. | Keep quick inspection but introduce a full-size review workspace with product evidence and code. |
| Design integration already exists. | F51/F52/B42/F53, merged PRs 157–160; focused tests passed. | Keep exact Figma-node verification, recoverable capability blocks, screenshot fallback, and generated visual-QA tasks. |
| Current sandboxing covers setup/dependencies/gates, not the author CLI. | Architecture, sandbox spec, adapters: host-run author processes with broad permissions. | Do not describe existing worktrees or gate containers as full agent isolation. |
| Shared preview, browser-session, and workspace-file APIs are absent from the reviewed route manifest. | packages/types/src/api.ts and current UI. | These require backend capabilities, not just embedded panels. |

Additional source concern: task-run and review-history requests catch errors silently. Loading, unavailable, and failed evidence must be distinguishable; investigate task-switch staleness with a regression test rather than assuming every empty result is genuine.

Passing tests do not disprove the findings above. The current tests cover many valuable invariants but do not cover every failure path or prove the end-to-end designer workflow.

## What to retain, extend, and add

| Area | Keep | Extend or add |
|---|---|---|
| Execution | One project runtime owner, DAG scheduling, scope checks, bounded retry/fallback, process-group cancellation | Milestone-level acceptance and controlled replanning; no competing dispatch path |
| Git | Task worktrees, common-repository lock, durable primary clone, PR/check/merge protections | Visual workspace inventory, branch/commit identity, safe inspection and preview lifecycle |
| Planning | Chat, attachments, editable draft, revision IDs, committed PRD/AGENTS and idempotent approval receipts | Existing-code inspection, reliable drafts, durable planning operations, revision comparison during a run |
| Design | Existing Figma nodes, verified runner capability, screenshots, visual-QA tasks | Project design library, component references, visible source precedence, review artifacts |
| Models | Claude Code, Codex, OpenCode adapters, routing, quotas, invocation ledger | Account-level shared capacity, capability discovery, per-task activation, optional evaluated classifier |
| Operations | SQLite, REST/WS snapshots, Telegram inbox/actions, systemd update protections | Preview/artifact services, explicit environment health, isolated workers where verified |

The earlier roadmap deliberately excluded a generic context registry and marketplace from its focused Figma wave. That was a useful scope boundary. This proposal adds a modest project library in a new wave; it should not rewrite those historical decisions or introduce a marketplace.

## The proposed interface

Use a neutral project workspace, with the product and its work occupying most of the screen. The attached concept is a layout exploration with sample data, not finished branding or functioning orchestration.

    Project navigation     Main work surface                   Optional inspector
    ------------------     --------------------------------    ------------------
    Project / environment  Goal, progress, attention, pause    Selected task
    Board                  Kanban or task list                 Summary / outcome
    Plan                   Brief + conversation + task draft   Dependencies
    Review                 Preview / changes / checks          Active references
    Library                Designs, rules, components          Model and resources
    Workspaces             Branches, previews, dirty state     Activity / recovery

    Connections            Global harnesses, accounts, MCPs
    Settings               Installation and notification preferences

### Board: manage outcomes

Use five readable default groups: Planned, Working, Review, Done, Needs attention. These are a presentation over existing task states, not a database migration. Planned distinguishes ready from waiting on dependencies; Working includes a visible repair state; Needs attention preserves the exact blocked/failed reason.

Show the task title, short current activity, dependency or blocker, and review availability first. Model, attempts, quota usage, and full logs live in the inspector. Users can enable a detailed engineering view.

Drag/drop must express an allowed action, such as prioritizing work, and never manufacture a successful task status. Completing a card still requires the engine's evidence. Keyboard and menu equivalents accompany drag/drop.

A compact header shows the brief, milestone progress, active workers, budget state, and one clear pause/resume action. A persistent attention count opens actionable items. Do not duplicate the whole runtime dashboard above the board.

On phones default to a status-filtered list; Kanban remains optional. Task inspection is a full-screen route with Back. On tablets use one main surface and an optional inspector. Desktop supports resizable panels without making three panes mandatory.

### Plan: a document and a collaborator

Left: conversation and references. Right: the brief, assumptions, acceptance criteria, milestones, and editable task outline. Code references can open alongside the draft; selected files or lines become explicit context.

Planning starts by identifying a new project versus an existing repository and showing the observed branch/commit and stack. The user should see “Using existing React components and API conventions,” with inspectable references, rather than have to guess whether the agent read the code.

During a run, keep the active plan immutable and allow a separate proposal. Applying a proposal shows a change summary: added tasks, altered pending tasks, dependencies, cost/time implications, and affected active work. Apply at a safe scheduler boundary. Immediate corrections to an active task require an explicit stop/settle and restart or queued follow-up; never silently replace its prompt.

Small changes can go straight to a single task after inspection. Larger briefs need milestones and integration checkpoints, but do not require the user to maintain a giant task spreadsheet.

### Review: inspect the result

Open a full-size workbench with Preview, Changes, Checks, and Activity. The user can compare the implemented screen with its Figma frame, screenshot, or design rules, inspect a diff, and request a focused repair.

A review item identifies the exact candidate commit, environment, tested URL, viewport, and check results. An old screenshot must not be presented as evidence for a newer commit. Design approval and code merge policy remain distinct; a design sign-off does not override failed required checks.

Start with code/file reading, search, diffs, and “add this selection to the plan.” Editing code can follow, using exclusive write ownership or explicit pause/handoff so a person and agent do not overwrite each other. This should not start as a full IDE rewrite.

### Workspaces: show what parallel work means

Each workspace card shows its task, branch, base commit, changed files, dirty state, worker, environment, preview, and checks. Useful actions are Open preview, Inspect changes, Open in editor where supported, and View recovery.

Show dependent branches and integration conflicts in plain language. Preserve dirty worktrees and explain cleanup eligibility. Worktrees separate Git changes; ports, databases, browser profiles, and background processes also need task-scoped ownership.

### Library: designs and instructions with visible scope

Provide project entries for Figma nodes, screenshots, DESIGN.md, tokens, component source/Storybook links, coding rules, framework documentation, and approved skills. Separate a reference from an executable capability.

Every entry shows its source, version/revision when known, applicability, and whether it was used by a task. Default precedence: explicit task requirements, project rules, existing code/components, project design system, then general defaults. Conflicting references are surfaced before dispatch rather than silently chosen.

Figma stays optional. Existing code and components should be the starting point for an existing app; a design document gives guidance, a component library gives concrete building blocks, and Figma provides exact visual intent when needed. They solve different parts of the problem.

## Browser and framework support

Treat three capabilities separately:

1. Human preview: serve the task's actual app through an authenticated, environment-aware preview URL. Associate it with a workspace and revision; show starting, ready, failed, and stopped states.
2. Agent browser: grant the selected task a supported browser capability, initially Playwright through an appropriate harness integration. Use separate browser contexts and task fixtures. Capture screenshots and traces as review artifacts.
3. Interactive remote browser: later add a controllable streamed session for workflows that cannot be embedded. An iframe is not a universal browser. Preserve an open-in-new-tab path.

Playwright offers isolated browser contexts and a trace viewer with action snapshots, logs, and network details; these are useful building blocks, not a complete Hoopedorc session manager. Its MCP implementation is one integration option. CLI/skill access may be more economical for a harness that already works well through those interfaces. The orchestrator should expose one tested browser capability with adapter-specific delivery. [Playwright isolation](https://playwright.dev/docs/browser-contexts), [Trace Viewer](https://playwright.dev/docs/trace-viewer), [Playwright MCP](https://github.com/microsoft/playwright-mcp).

For frameworks, use project environment profiles built from detected repository evidence and user choices: runtime/toolchain, dependency setup, services, start command, readiness check, validation commands, and preview/artifact type. Preserve existing structured setup support. Add typed argument arrays for generic commands instead of assuming every project has npm test/build/lint/typecheck.

Ship a verified web path first, then prove one non-Node backend profile. Native mobile/desktop builds need compatible hosts and simulator or build artifacts; do not imply a Linux AWS worker can run every platform-specific toolchain. Unsupported combinations should explain what environment is required.

## Models, harnesses, skills, plugins, and resources

Keep these concepts separate in implementation, while presenting a simpler connection wizard:

- Harness: executable and version, invocation/resume/cancellation behavior, supported tools and accounting.
- Model profile: model, effort, role eligibility, context limits, and preferred use.
- Account/quota pool: shared allowance across profiles, active slots, observed limits and cooldown.
- Execution environment: local/AWS host capabilities and available CPU, memory, disk, services.
- Task activation: selected instructions, skills, plugins, and MCP capabilities for this attempt.

Connect a harness once, verify it, discover or validate its available models, then offer a small number of allocation preferences such as Subscription first, Balanced, and Fastest eligible. Advanced configuration remains accessible. Do not claim exact subscription percentages unless a provider exposes them.

Enabling a skill in the library must not automatically load it into every call. Keep a small metadata index; resolve approved relevant entries; load only their needed content/tool schemas. Record the effective activation manifest per attempt. Installation, authentication, availability, and activation are separate states.

Harnesses differ in automatic instruction/plugin discovery. An “off” switch is only trustworthy if the adapter can enforce it using isolated configuration or a tested allowlist. Otherwise show the limitation; prompt wording alone does not disable a tool. Preserve CLI-owned authentication until a separately verified design changes it.

Routing should first enforce task capability, independent review, account, budget, and environment constraints. Then rank eligible model profiles using static preferences and measured outcomes. Revalidate/reserve capacity at dispatch. Shared accounts must not gain imaginary quota when switching models.

Jev can be an optional classification/ranking step after that filter, with a static fallback, version pinning, and low-confidence handling. It should not own task state, Git actions, or spending authority. Evaluate it against the existing policy on representative tasks before switching it on. Typesafe's own documentation describes classification confidence and limitations; confidence is not an estimate of coding success. [Jev models](https://docs.typesafe.ai/models), [model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13), [confidence](https://docs.typesafe.ai/confidence).

Optimize cost per verified completed task, including planning, retries, validation, and infrastructure. More cheap workers can cost more if repairs and integration dominate. Keep capacity for review and integration, and bound native subagent recursion through the parent attempt's resource policy.

## Local and AWS operation

Keep the browser control plane and existing single-owner server. A local installation runs locally; an AWS installation runs on the user's host and remains accessible through the supported private/authenticated access path. Closing the UI must not stop execution.

First make the same product work well in either location. A connection picker can switch between installations without creating a distributed scheduler. Do not put multiple runtimes over a shared SQLite file or let two machines believe they own the same project.

Only add remote-worker scheduling when there is a demonstrated need, with durable ownership, reconnect reconciliation, bounded leases, and credential boundaries. Multi-host scheduling is not a prerequisite for the first useful redesign.

Expose actual isolation mode in environment health. The current gate sandbox is valuable, but full autonomous agent isolation remains unfinished. Expand the existing sandbox design with a tested authentication path for each harness, restricted worktree mounts, scoped browser/service access, resource limits, and restart/cancellation tests. Never silently switch a subscription-backed setup to paid API calls.

Use the existing Telegram durable actions and approval handling. Send useful milestone/attention digests with links into the board or review item; avoid noisy per-log messages. A stale Telegram approval must remain bound to the exact pending decision.

## Reliability for big briefs

Preserve the existing task scheduler and durable retry state. Add the missing outcome layer incrementally:

1. Brief acceptance criteria map to milestones and task evidence.
2. Each ready task has bounded scope, dependencies, required capabilities, and a verification method.
3. Dispatch checks capability and capacity before consuming an author attempt.
4. A failed task is classified into actionable recovery: missing capability, provider cooldown, environment/setup failure, code/check failure, integration conflict, or inadequate plan.
5. Retry only when the cause changed or the policy justifies another attempt. Repeated identical failures escalate with preserved evidence.
6. Independent work continues when policy allows; dependencies remain blocked.
7. Integration verifies the combined revision and the actual product flow.
8. Completion requires the brief's acceptance evidence, not just all task rows being done.

Use model reasoning for planning, ambiguous diagnosis, and bounded replanning. Use ordinary software for scheduling, retry counters, capacity, idempotency, and status. A permanent expensive “manager” loop is unnecessary.

Milestone hierarchy can be introduced without replacing Task or repurposing the existing Run type, which already represents an execution attempt. Add a small enclosing operation/milestone entity only where durable lifecycle needs it; migrate legacy tasks with their IDs, history, and artifacts intact.

## Proposed delivery sequence

P0–P7 below identify delivery slices. The stable VW01–VW18 implementation items and dependencies are defined in the implementation backlog below and indexed in PRODUCTIZATION_PLAN.md. Reference VW IDs in commits and PRs; preserve historical completion evidence.

| Slice | Deliverable | Acceptance before moving on |
|---|---|---|
| P0 — trustworthy planning | Fix lost input, save status, misleading repository assumptions, and real calls in mock mode. | Inject send/save/clone failures; input survives; reload recovers saved revision; existing repo without prior tasks is not scaffolded; failed tasks are not described as done; mock planner cannot launch a real CLI. |
| P1 — visual workspace shell | Compact navigation/header, readable board/list, task inspector, organized settings. Use existing APIs where possible. | Existing actions preserve behavior; blocked reasons and next actions are visible; deep links and keyboard navigation work; 360/390/768/1280/1440 widths; no unexpected horizontal document scrolling; 40px phone controls. |
| P2 — planning workbench | Plan document beside conversation, repository context references, durable operation state, later proposed revision while running. | Leaving/reopening the tab recovers the operation; stale-tab writes are rejected; applying a revision shows a diff and never mutates an active attempt. Split background planning and live revision application into separate reviewable changes. |
| P3 — preview and review | Environment start/readiness ownership, preview route, artifact records, full review workspace, read-only code/diff inspection. | Local and AWS live smoke tests; port conflicts handled; preview revision is clear; expired/unavailable evidence is visible; failed browser checks link to screenshots/traces; closing UI leaves server work intact. |
| P4 — library and activation | Visual project references and rules; preserve Figma path; per-attempt skill/MCP activation with capability checks. | Unselected content is absent from effective context where adapter isolation supports it; unsupported isolation is disclosed; no-Figma projects make no Figma probes; a capability outage preserves work and resumes. |
| P5 — resource controls and isolation | Shared account pools, allocation presets, host health, verified isolated agent profiles. | Simultaneous dispatch respects shared limits; cooldowns do not spin; no silent paid-auth switch; cancellation and restart settle processes; isolated worker cannot reach unrelated project files or control-plane secrets. |
| P6 — large-brief completion | Milestone planning/integration, outcome evidence, bounded replan and repair. | Multi-task run survives a restart, provider failure, and failed branch without duplicating work; integrated flow meets the brief; recovered work and total cost are visible. |
| P7 — broader compatibility | Additional framework profiles/harnesses; Jev evaluation and optional routing. | Each advertised combination passes its compatibility suite; classifier improves measured allocation with no increased unacceptable failures; fallback works when classifier is down. |

Order can overlap in design work, but implementation should remain small and dependency-aware. P0/P1 give immediate value. P3 depends on real environment ownership and should not be sold as just a UI panel. Full agent isolation is required before claiming strongly sandboxed unattended operation.

The first usable redesigned release should complete one real journey: connect an existing project → plan a modest feature using its components → run two independent tasks → inspect the combined preview and checks → request one visual correction → review the resulting change. Prove it locally and on the user's AWS installation before expanding the feature catalog.

## Implementation handoff

### Work items and owning files

All items start as **not started**. Dependencies below are implementation
dependencies, not a request to start parallel agents. P0–P7 refer to the delivery
slices above. Existing source paths are starting points; new modules belong at
the owning package boundary.

| ID | Slice / work item | Depends on | Owning source and coverage |
|---|---|---|---|
| VW01 | P0: deterministic mock planning | None | packages/server/src/index.ts, planner.ts, mock.ts, planner.test.ts; apps/web/e2e/app.spec.ts |
| VW02 | P0: preserve planning input and make saves truthful | VW01 | apps/web/src/pages/PlanView.tsx and PlanView.test.tsx; api/client.ts; server revision/save behavior only if required |
| VW03 | P0: repository-aware planning and truthful history | VW01 | packages/server/src/index.ts, planner.ts, planner.test.ts; existing GitServiceImpl boundary; shared planning response/UI if inspection state is exposed |
| VW04 | P1: project navigation, compact board, task inspector | VW02, VW03 | apps/web/src/App.tsx, pages/Board.tsx, components/ProjectHeader.tsx, BoardSummary.tsx, TaskDrawer.tsx; App/Board/TaskDrawer tests and e2e |
| VW05 | P1: organize existing settings and setup | VW04 | apps/web/src/pages/Settings.tsx, SetupView.tsx, associated tests; preserve current settings contracts and normalizer |
| VW06 | P2: durable planning operations and planning workbench | VW02, VW03 | packages/types/src/api.ts and domain.ts; packages/server/src/index.ts, planner.ts, background-operations.ts, db/index.ts and schema.sql; PlanView and REST/WS coverage |
| VW07 | P2: propose and apply plan changes during execution | VW06 | shared plan/revision contracts; planning-commit.ts, engine-runner.ts, DB transactions; scheduler mutation boundary; PlanView diff/apply flow |
| VW08 | P3: workspace inventory and read-only code inspection | VW04 | shared workspace/file contracts; server project/task ownership; engine Git/worktree services; new web workspace/file surfaces and tests |
| VW09 | P3: managed environment and preview lifecycle | VW08 | shared environment/preview contracts; server lifecycle/routes; engine managed process and sandbox boundaries; project-config.ts; deployment docs |
| VW10 | P3: review workbench and browser evidence | VW09 | shared artifact/evidence contracts; server artifact storage/routes; visual-qa-task.ts; TaskDrawer/review UI; browser capability integration |
| VW11 | P4: project reference library | VW03, VW04 | shared context metadata; existing attachments, Figma references, planning and project config; new library UI; migration and compatibility tests |
| VW12 | P4: selective skills, plugins, and MCP activation | VW11 | packages/adapters/src; server capability preflight; per-attempt activation contract; effective context manifests and adapter compatibility tests |
| VW13 | P5: account pools and resource allocation | VW05, VW12 | packages/types/src/domain.ts; packages/server/src/config.ts, budget.ts, engine-runner.ts and DB; engine dispatch policy; resource UI |
| VW14 | P5: verified isolated agent execution profiles | VW12, VW13 | adapters, engine sandbox/process/worktree boundaries; server environment health; docs/specs/sandbox.md and deploy docs; real host/container tests |
| VW15 | P6: milestone acceptance and bounded replanning | VW07, VW10, VW13 | additive shared milestone/outcome contracts; DB; planner, engine-runner, scheduler/integration gates; board/review evidence |
| VW16 | P7: portable framework/environment profiles | VW09, VW10 | ProjectConfig, project-config.ts, setup/gate/worktree services; new environment profile validation; non-Node fixtures and real toolchain checks |
| VW17 | P7: additional harness compatibility | VW12, VW13, VW14 | RunnerKind and capability contracts; adapters and subprocess fixtures; settings/discovery UI; live compatibility matrix |
| VW18 | P7: optional Jev routing evaluation | VW13, VW15; measured baseline | bounded routing service/policy at server/engine boundary; settings, invocation ledger, offline benchmark fixtures and failure tests |

These are work packages, not instructions to create one enormous PR per row.
For VW06 onward, separate contract/persistence, backend behavior, and consuming
UI into coherent, backward-compatible PRs where size requires it. Each PR must
leave the product usable; do not land a UI that assumes an unshipped endpoint.
Do not add every future schema field in an initial migration.

### VW01 — first implementation PR

**Problem:** the mock planning chat route invokes runPlannerChat, which can
launch the authenticated production planner. The browser audit encountered a
real response and reported cost. Check deconstruction and Figma verification
for the same boundary before expanding browser tests.

**Scope:** introduce deterministic mock planning at the server's composition
boundary. Cover chat, deconstruction, and planning design verification with
representative success and capability-failure fixtures. Reuse real contract
validation, revision guards, response envelopes, and persistence semantics.
Keep mock Git/attachment/session handling within its existing isolated paths.

**Non-goals:** no production prompt changes, routing changes, new provider
credentials, dashboard redesign, or general-purpose fixture platform. Do not
change global CLI authentication to make a demo safe.

**Acceptance and regression coverage:**

- A mock chat request returns a deterministic valid response and never spawns
  an agent CLI. Assert the invocation boundary was not called.
- Mock deconstruction and Figma verification cannot call providers/MCPs,
  ensure a real repository clone, or mutate the primary repository.
- Real mode still selects the production dependencies; prove the selection
  with injected fakes rather than paid live calls.
- Fixture IDs, task dependencies, generated QA identity, revision errors, and
  response shapes match the shared contract. Stale revision requests still fail.
- Represent errors explicitly. Unsupported mock operations return a clear
  unavailable response rather than falling through to real execution.
- A browser scenario exercises the actual mock planning route without
  intercepting it into success; it receives a usable plan with no external
  model call. No real Telegram message or remote Git mutation is needed.
- Document the bounded mock guarantees. A mock flag must not imply other
  untested setup/health operations are isolated.

**Focused checks:** server planner/route coverage and the planning e2e
scenario, followed by all repository gates. Live paid-model verification is
not required for this item because production behavior is unchanged.

### VW02 — planning work must survive failure

**Scope:** retain submitted input or an explicit recoverable failed message;
show draft save state; prevent stale save completions from marking newer edits
saved; make approval use the exact visible draft and existing revision receipt.

**Acceptance:**

- Send failure preserves the original message, any subsequently typed input,
  attachments, and chat history. Retry does not duplicate the accepted turn.
- Save failure shows an actionable inline error. “Saved” appears only after
  the current revision/content is acknowledged.
- Rapid edits and out-of-order responses cannot overwrite newer content.
  Switching projects or unmounting cannot publish stale save state.
- Navigation during a pending/failed save preserves or explicitly protects
  unsaved work. Reload restores acknowledged data. If persistent unsent
  recovery is added, scope it to project/revision and never include secrets.
- Commit while save is pending cannot publish an older draft. Reuse the
  server's exact-content commit boundary rather than inventing a second save.
- Cover success, send failure, save failure, stale revision, rapid edits,
  project switch, reload, and commit/retry in interaction/contract tests.

**Non-goals:** background planner execution and live plan revision changes
belong to VW06/VW07; this item should stay a focused reliability fix.

### VW03 — plan from the repository that actually exists

**Scope:** represent repository inspection separately from historical task
presence. Distinguish an empty repository, an existing codebase, and unavailable
inspection. Keep non-done task states truthful in follow-up context.

**Acceptance:**

- An existing codebase with zero Hoopedorc tasks does not receive an
  unconditional “brand-new project” instruction.
- A genuinely empty repository may receive stack-appropriate scaffold work.
- Clone/read failure is visible, retryable, and preserves the user's draft;
  it does not silently substitute a temporary working directory.
- Done, failed, blocked, pending, and active work remain distinct. A failed
  task's title is not proof its implementation exists.
- Planning context records the observed repository revision where relevant;
  stale repository evidence is refreshed or disclosed before applying a plan.
- Fixtures cover existing/empty/inaccessible repositories, mixed-status
  history, retry, and an existing non-Node project. Do not force npm scripts
  onto a detected non-Node project.

**Non-goals:** generic framework installation and complete environment profile
support remain VW16. This item removes misleading assumptions now.

### Acceptance additions for later items

Use these with the slice acceptance table; they are not optional polish.

- **VW04/VW05:** preserve existing URLs or add deterministic redirects;
  settings edits survive validation errors; old stored settings remain valid;
  every existing run/approval/retry/stop action retains its server semantics.
  Drawer history loading failures must not look like “no runs/reviews.”
- **VW06:** persist operation identity/state and recover after disconnect or
  restart. A background operation registry alone does not prove durable
  planner resumption; specify whether an interrupted CLI resumes or restarts,
  account both attempts, and prevent duplicate finalization.
- **VW07:** compare-and-swap the plan revision and task generation when
  applying edits; reject incompatible intervening changes. Preserve accepted
  tasks and in-flight ownership; stop/settle before replacing active work.
- **VW08:** validate project/task/worktree ownership on every file access;
  reject traversal and escaping symlinks; bound large/binary reads; disclose
  deleted/unavailable workspaces. Read-only browsing does not grant shell access.
- **VW09:** assign server-owned preview targets; authenticate proxies and
  WebSocket upgrades; do not accept arbitrary proxy URLs. Handle readiness
  timeout, port conflict, orphan process, restart, and stopped workspace.
  Application previews must not receive the control plane's auth token.
- **VW10:** bind evidence to task, attempt, commit, environment, and viewport;
  mark stale evidence; retain failure artifacts under a documented policy.
  UI design approval cannot bypass failed required code checks. Native/batch
  projects show appropriate artifacts instead of an unusable iframe.
- **VW11/VW12:** migrate legacy Markdown references without losing them;
  explain conflicting sources. “Inactive” must be enforced by the adapter,
  or labeled unsupported. Test effective instructions, tool schemas,
  configuration, and cancellation for each supported harness.
- **VW13:** reserve shared capacity transactionally/revalidate at dispatch;
  recover reservations after restart; keep billing invocation IDs unique.
  Label unknown usage and distinguish metered cost from subscription activity.
- **VW14:** verify the actual CLI version/auth flow locally and on AWS;
  keep account authentication under the chosen supported owner. Test that the
  worker cannot reach unrelated workspaces, host secrets, or the control plane.
  Never equate sanitizing environment variables with filesystem isolation.
- **VW15:** trace each brief criterion to integrated evidence; bound replan
  scope, retries, time, and spending. Replanning cannot quietly delete an
  acceptance criterion to declare success. No parallel replacement scheduler.
- **VW16/VW17:** publish only tested host/framework/harness combinations;
  show unsupported capabilities before dispatch. Test setup, cancellation,
  accounting, retry, restart, and artifacts, not just a successful hello-world.
- **VW18:** evaluate held-out representative tasks against static routing;
  include classifier overhead and downstream repair cost. If Jev is down,
  malformed, low-confidence, or recommends an ineligible candidate, use the
  bounded fallback and record why. Deployment remains optional.

### Definition of done and verification commands

Every item updates its Part 14 row with branch/PR, exact verification evidence,
remaining live checks, and completion status. Do not mark it complete because
unit tests pass while its required local/AWS flow remains unverified.

Use the repository's Node version from .nvmrc. Run all AGENTS.md gates:

    npm run typecheck
    npm run build
    npm run lint
    npm test -w @orc/engine
    npm test -w @orc/adapters
    npm test -w @orc/server
    npm run test:web
    npm run test:e2e
    git diff --check

Use focused tests while iterating. UI behavior also needs a real browser at
360, 390, 768, 1280, and 1440px, including keyboard interaction, async states,
errors, confirmations, and touch targets. Mock tests are not substitutes for
the live process/authentication/deployment checks listed for an item.

The first redesigned-release scope is VW01–VW06 and VW08–VW10, using existing
Figma/reference and routing capabilities. VW07 and VW11 onward extend that
release. This allows useful visual review before every future resource and
library feature is built. Do not advertise full agent isolation until VW14
passes its real boundary checks.

## Product validation scenarios

Use a fixed set of representative briefs: a tiny bug, a UI change from DESIGN.md/components, a Figma-based screen, an existing-code feature, a multi-task feature with a shared API contract, and a non-Node backend change.

Measure successful acceptance without manual code rescue, interventions per task, recovery success, discarded/duplicated work, time to first useful preview, time to diagnose a block, total cost per verified completion, and context included versus actually needed. Record a baseline before tuning routing.

For UX, observe a designer completing the real journey without terminal intervention. Verify that they can tell what changed, where it is running, what was checked, what is blocked, and what they can do next. A polished screenshot alone is insufficient.

## Research that informed the direction

- Conductor demonstrates separate workspaces for parallel work; its cloud FAQ describes a managed sandbox offering. Borrow clear workspace identity and resource visibility, while keeping Hoopedorc's own-AWS requirement. [Parallel agents](https://www.conductor.build/docs/concepts/parallel-agents), [Cloud FAQ](https://www.conductor.build/docs/cloud/faq).
- Nimbalyst connects planning artifacts, sessions, code, and visual work. Borrow continuity from intent to result, rather than making the user reconstruct it across logs. [Context graph](https://www.nimbalyst.com/context-graph/), [Agent orchestration](https://www.nimbalyst.com/features/agent-orchestration/).
- The Composio-origin Agent Orchestrator now lives under Untrivial-ai. Its architecture emphasizes a persistent daemon, thin clients, and a single control owner. Hoopedorc already has analogous foundations worth retaining. [Repository](https://github.com/Untrivial-ai/agent-orchestrator), [Architecture](https://orchestrator.inc/docs/architecture/).
- OpenHands separates remote agent execution from clients/workspaces. This informs a later worker boundary rather than requiring an immediate server rewrite. [Agent server](https://docs.openhands.dev/sdk/guides/agent-server/overview).

These are documentation-based comparisons, not hands-on reliability benchmarks of competitors. Source claims describe their documentation at research time; recommendations here are design judgments for Hoopedorc.

## Verification and limits of this audit

- Reviewed AGENTS.md, architecture, contract, relevant user/deployment and sandbox guidance, focused design intake docs, roadmap F51/F52/B42/F53, and owning UI/server/adapter paths.
- Ran the app's in-memory mock server and inspected Board, the planning lock/chat, Settings, and task Overview/Review in Chrome. Checked board layout at 360, 390, 768, 1280, and 1440 widths; this was a sampled audit, not exhaustive responsive interaction coverage of every screen.
- Web tests: 25 files, 100 tests passed.
- Focused server tests: planner, planning-commit, figma-references, visual-qa-task, project-config, engine-runner; 102 passed using installed Node 22.23.0.
- The first server-test command used an incompatible Node/native SQLite ABI and failed to load SQLite. Rerunning with the repository's Node 22 version passed; dependencies were not rebuilt or changed.
- One mock planning message unexpectedly called the real planner; the UI reported $0.15. No further planner calls or actual task execution were initiated. Treat that amount as the UI-reported value, not an independently verified invoice.
- Existing Figma functionality has local implementation/test evidence. Its roadmap records owner EC2/Figma/browser live acceptance as unverified; Part 13 subsequently records owner deferral of the B46/B47 Figma checks. That deferral remains intact.
- Did not deploy AWS, authenticate new integrations, run live Figma/browser-agent compatibility checks, validate provider subscription support, or benchmark Jev. These remain explicit implementation acceptance work.
- The original audit changed no application code and was not a release verification. Full typecheck/build/lint/engine/adapter/server/e2e gates were not run during that audit; documentation-publication checks are recorded separately in Part 14 of the roadmap. Every implementation PR must run all AGENTS.md gates.
- Preserved the pre-existing untracked packages/server/.-hoopedorc-deps/ directory.
- Stopped the temporary audit server after inspection; its shutdown log reported no cleanup errors.
