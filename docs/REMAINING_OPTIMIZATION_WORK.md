# Remaining optimization work

This is the execution handoff for the unfinished items in
`docs/OPTIMIZATION_PLAN.md` after merge commit
`621a1bcad573e1e7ec04eda7d99bc6da5a178d87` (PR #244). It is intentionally
shorter than the historical roadmap. The full item text, decisions, and prior
evidence remain in `docs/OPTIMIZATION_PLAN.md`; `AGENTS.md` remains the
authoritative contributor workflow.

The goal is to let a new implementation model work through the remaining
items without repeating repository-wide discovery or repeatedly rerunning
already-green checks. Complete one item or explicitly paired group at a time.

## Current baseline

- `main` and `origin/main` match `94f5f80` after merging PR #245.
- PR #244 completed O6, O12, and O26's project-owned WebSocket sub-item.
- PR #245 closed the three leftover reconnect-authority checkpoints.
- O5 already completed the shared dialog-semantics sub-item of O26.
- The remaining implementation items are O8, O10, O22, O23, O25, and
  three small O26 sub-items.
- O27 has no remaining implementation, but its authorized deployment evidence
  is still outstanding.
- Do not reopen completed items unless a regression is first reproduced.

## Better implementation and verification workflow

Use this sequence for every item.

1. **Start clean and scope one item.** Fetch `origin/main`, verify clean/equal
   `main`, and create one descriptive branch. Combine only the pairs named in
   this document.
2. **Read only the owning paths.** Read the item's current roadmap section,
   its owning source files, focused tests, and directly affected contract or
   architecture documentation. Do not audit unrelated packages.
3. **Prove the problem first.** Add one failing regression or a reproducible
   benchmark. Evidence-gated items O8, O10, and O22 must not receive a
   production refactor unless the baseline demonstrates the stated problem.
4. **Iterate narrowly.** Run the changed test file or owning package while
   coding. Do not run every repository gate after each edit.
5. **Review the final diff once.** Check acceptance criteria, stale/retry/error
   paths, documentation, and `git diff --check`. Fix all findings before the
   final gate. Do not start another broad review after the final gate unless
   that gate or CI exposes new evidence.
6. **Run the repository gate once on the frozen tree.** Run every command from
   `AGENTS.md` exactly once after implementation and review are complete. Save
   the tested commit hash and exact counts. If code changes afterward, rerun
   only the affected focused checks while editing, then run the complete gate
   once more on the new frozen tree.
7. **Use browser checks proportionally.** For UI behavior, test the changed
   flow at the required widths. Reuse Playwright for unchanged responsive
   coverage. Add a manual browser check only for behavior the automated test
   cannot establish, such as real reconnect timing or reduced-motion behavior.
8. **Push once, then rely on CI as the independent full run.** Open the PR with
   the regression/benchmark, final local gate, browser evidence, and deferred
   live checks. Do not rerun successful local gates while CI is pending.
9. **Merge only on green.** Review the final GitHub diff and required checks,
   merge, then verify local `main` equals `origin/main`. A substantial wave
   still needs the merged-commit verification required by `AGENTS.md`, but do
   not repeat unrelated manual testing when the merge tree is identical to the
   reviewed head.

### Rerun rule

- Test failed: rerun that failed test after diagnosing and fixing it.
- Focused source changed: rerun its focused test/package.
- Final tree changed after the full gate: perform one new full gate after the
  tree is frozen again.
- No source change: do not rerun successful tests merely for reassurance.
- Flake suspected: reproduce the same command and record both outcomes; do not
  hide the first failure behind a blanket suite rerun.

## First: close PR #244's audit trail — complete

Recorded under O6/O12/O26 in `docs/OPTIMIZATION_PLAN.md`: PR #244, merge
`621a1bc`, Linux `build-and-test` on the reviewed head and on `main`, the PR's
final local gate (web 69/69, server 326/326, E2E 18/18, 330-finding lint), and
the existing 390px reconnect browser evidence.

All three leftover checkpoints reproduced with failing regressions first and
are corrected in the same reconnect-authority PR:

- CostView now refetches on `cost.snapshot`.
- PlanView ignores an older initial `getProject` after a newer snapshot or
  `project.updated`.
- Pending-creation `404` retirement selects from projects still present at
  retirement time.

Do not reopen this audit. O24 is next after #245.

## Implementation order

### 1. O24 — request ownership and stale-response protection — complete

PlanView's five-request load, CostView `fetchAll`, and Board `fetchEstimates`
now abort on project change/unmount and ignore superseded or aborted
responses. AuditView's generation guard is unchanged. Deterministic A→B,
A→B→A, overlapping-refresh, and abort-error tests cover the owners.

The next implementation item is O23.

### 2. O23 — coalesce CostView and AuditView refreshes

**Depends on:** O24.

Implement a small trailing coalescer per view with an in-flight flag and
monotonic requested/completed generations. A burst may cause one active fetch
and one trailing fetch; it must never lose the final invalidation.

**Acceptance**

- Deterministic tests cover events before a fetch, during it, and at settlement.
- Bursts produce a bounded request count and the final state is fetched.
- Stale/unmounted/project-switched responses cannot publish.
- Reconnect markers refresh REST-only state even when no live delta follows.
- The freshness interval is documented and tested.

### 3. O25 + O26 reduced-motion log behavior — bounded task logs

These items share the same `Board`/`LogPanel` ownership and may be one PR.

- Retain exactly the newest 1,000 task log rows after initial load and live
  appends.
- Show an accurate notice when older rows were omitted.
- Preserve ordering, filtering, autoscroll, and task isolation.
- Scroll the log container explicitly.
- Honor `prefers-reduced-motion` by avoiding smooth scrolling.

**Acceptance**

- Initial responses and streamed bursts keep the newest 1,000 with no boundary
  duplicate.
- Switching tasks never mixes rows or omission state.
- Reduced-motion and normal autoscroll each have interaction coverage.
- Browser verification covers the drawer at phone and desktop widths.

### 4. O26 — remaining independent web follow-ups

Keep these small; they may share one PR if the diff remains easy to review.

**Toast timer ownership**

- Track every dismissal timer and clear it on provider unmount.
- Test unmount with pending timers and normal dismissal.

**Dead New Project control**

- Wire PlanView's `New Project` control to the existing New Project route, or
  remove it if the same action is already clearly available beside the view.
- The control must have one real, keyboard-accessible outcome.

Do not redo dialog semantics or WebSocket ownership; those O26 sub-items are
complete.

### 5. O8 — cancelled/stuck invocation cost evidence

This is evidence-gated. Start with production-shaped adapter/orchestrator tests
that emit usage, hang, trigger stuck cancellation, and inspect the terminal
invocation ledger.

**Decision**

- If accumulated usage already survives, close O8 with evidence or remove only
  the fabricated-zero fallback demonstrated by the test.
- If parsable partial usage is lost, preserve it through a typed additive
  result/error and keep exactly one terminal ledger row.
- If the real CLI provides no usage, represent it as unavailable/unknown; do
  not present invented zero as measured usage.

**Acceptance**

- Every cancelled invocation has exactly one terminal ledger row.
- Observed partial usage survives; genuinely unavailable usage is honest.
- Normal and resolved-abort behavior is unchanged.
- No cross-layer type/schema change is made without a reproduced need.

### 6. O10 — measure synchronous worktree preparation

Create a reproducible large-repository fixture and measure event-loop delay and
worktree-preparation wall time under concurrent dispatch.

**Decision**

- If impact is material on the target 1-2 GB host, convert only the measured
  synchronous walkers/hashing to bounded async I/O while preserving exact
  fingerprints and deterministic ordering.
- If impact is immaterial, record the numbers and defer without production
  code.

**Acceptance**

- Baseline and after/defer measurements use the same fixture and concurrency.
- npm, yarn, pnpm, and custom-setup fingerprints remain byte-identical if code
  changes.
- No speculative cache or broad worktree-manager rewrite is introduced.

### 7. O22 — measure Board live-run rendering

Instrument a representative Board fixture for render counts, estimate request
counts, and browser main-thread timing during a fixed log/task-event burst.

Change only bottlenecks demonstrated by the measurement. Candidate fixes are
coalesced activity publication, estimate invalidation only for fields that
affect estimates, clock isolation, and memoization where prop identity is
proven costly.

**Acceptance**

- Before/after numbers use the same fixture and event burst.
- Final activity and estimate state is never lost.
- Interaction behavior and heartbeat freshness remain unchanged.
- Immaterial candidates are documented and deferred instead of implemented.

### 8. O27 — outstanding live deployment evidence

This is operator-authorized evidence, not a coding task. Do not deploy without
explicit authorization.

- Run the canonical `scripts/update.sh` path on the authorized host.
- Record deployed commit, `GET /api/health`, and dashboard behavior.
- Confirm updater protections and service ownership remain intact.
- Add the evidence to O27's status trail.

## Definition of done for the remaining roadmap

- Every confirmed implementation item above is merged through a green PR.
- Evidence-gated items are either fixed from a reproduced baseline or closed
  with recorded measurements and no speculative production code.
- O26 has no unfinished timer, log-motion, or dead-control bullet.
- O27's live evidence is recorded, or explicitly remains outstanding with the
  authorization blocker named.
- `docs/OPTIMIZATION_PLAN.md` contains the final PR, merge commit, verification,
  and deferred-work trail for every item.
- No new optimization item is started merely because the previous model had
  time remaining.
