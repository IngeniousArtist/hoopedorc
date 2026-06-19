# Spec — `@orc/engine` (assigned: Deepseek v4 Pro)

You are implementing the **orchestrator engine**: the hardest module. Work only
inside `packages/engine/`. Do not modify other packages. Treat `@orc/types` as a
fixed, read-only contract.

## Setup
```bash
git checkout -b feat/engine
npm install
npm run build -w @orc/types   # the contract must be built before you can import it
```

## What to build
Implement the interfaces already stubbed in `packages/engine/src/index.ts`:
`WorktreeManager`, `GitService`, `GateRunner`, `Validator`, and the `Orchestrator`
class (`start`, `pause`). Split into multiple files under `src/` and re-export
from `src/index.ts`.

1. **WorktreeManager** — using `git worktree add .worktrees/<taskId> -b <branch>`
   off the project's default branch; `remove` cleans it up; `changedFilesInScope`
   compares `git diff --name-only` against `task.scopePaths` (use `minimatch`).
2. **GitService** — wrap `git` + the `gh` CLI (`child_process`): commit, push,
   `gh pr create`, `gh pr merge --squash`, and `revertMerge`.
3. **GateRunner** — run inside the worktree and return a `GateResult`:
   `typecheck` (`npm run typecheck`), `lint`, `build`, `tests`, `noConflicts`
   (merge-base check vs default branch), `inScope` (from WorktreeManager). Capture
   output into `details`. Missing scripts = treat as pass-with-note, never crash.
4. **Validator** — given a task + `GateResult`, call the validator model through
   an `AgentAdapter` (injected) to grade against `task.acceptanceCriteria`; return
   a `MergeDecision` with `verdict`, `reasons`, and `confidence`. Must refuse to
   review code it authored (assert `validatorModel !== task.assignedModel`).
5. **Orchestrator.start** — the loop described in the stub's TODO: ready tasks →
   respect `ModelConfig.maxConcurrent` → run author model via adapter (with the
   `STUCK_DETECTION` limits + `AbortSignal`) → commit/push/PR → gates → fix-loop
   (feed `reasons` back, retry ≤ `maxAttempts`) → validator → apply `mergePolicy`
   + `riskyChangeRules` (escalate via `events.requestApproval`) → merge → mark
   `done` → recompute. Emit `events.onLog/onTaskUpdated/onRunUpdated/onMergeDecision`
   throughout.

Adapters come from `@orc/adapters` (`makeAdapter`). Do not call models directly.

## Constraints
- Pure, injectable, unit-testable: all side effects behind the injected `deps`.
- Never touch `main` directly. Never auto-merge when a risky-change rule trips and
  policy isn't `fully_autonomous`.
- Keep `readyTasks` semantics (already implemented) intact.

## Acceptance criteria
- [ ] `npm run typecheck -w @orc/engine` passes.
- [ ] `Orchestrator.start` runs a 2-task DAG end-to-end against **fake** injected
      deps (provide them in a `*.test.ts`) and reaches `done`.
- [ ] Fix-loop retries on a failing gate and stops at `maxAttempts`.
- [ ] Validator throws if asked to review its own author model's work.
- [ ] Risky change (e.g. out-of-scope edit) triggers `requestApproval`, not merge.
- [ ] No imports from `@orc/server` or `@orc/web`.

## Done
Commit to `feat/engine`, push, open a PR titled `engine: scheduler + gates +
validator`. Leave the PR for integration review.
