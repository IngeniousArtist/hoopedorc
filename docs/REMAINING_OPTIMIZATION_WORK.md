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

- `main` and `origin/main` match `07cfcf6` after merging PR #254.
- PR #244 completed O6, O12, and O26's project-owned WebSocket sub-item.
- PR #245 closed the three leftover reconnect-authority checkpoints.
- PR #246 completed O24 request ownership.
- PR #247 completed O23 trailing refreshes.
- PR #248 completed O25 and O26's reduced-motion log bullet.
- PR #249 completed O26's toast-timer and New Project bullets.
- PR #250 closed O8 with evidence and no production refactor.
- PR #251 recorded O8 merge and main CI evidence.
- PR #252 deferred O10 with measured worktree-prep numbers.
- PR #253 recorded O10 merge and main CI evidence.
- PR #254 completed O22's measured Board live-run fixes.
- O5 already completed the shared dialog-semantics sub-item of O26.
- O8 is closed with evidence and no production refactor.
- O10 is deferred with recorded measurements and no production refactor.
- O22's measured Board live-run burst is fixed; clock isolation and card memo
  are deferred.
- There are no remaining implementation items.
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
   benchmark.     Evidence-gated items must not receive a
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

### 2. O23 — coalesce CostView and AuditView refreshes — complete

Both views use `createTrailingRefresh`: one in-flight fetch plus at most one
trailing fetch, `TRAILING_REFRESH_INTERVAL_MS = 0`. Reconnect markers still
refresh REST-only state.

### 3. O25 + O26 reduced-motion log behavior — complete

Board retains the newest 1,000 task log rows after load and live appends, with
an omission notice and per-task isolation. LogPanel scrolls its container and
uses `auto` behavior under `prefers-reduced-motion`.

### 4. O26 — remaining independent web follow-ups — complete

Toast timers are tracked and cleared on provider unmount. PlanView's New
Project control is a keyboard-accessible `#/new-project` link. Dialog,
LogPanel, and `useWS` bullets were already complete.

### 5. O8 — cancelled/stuck invocation cost evidence — complete

Production adapters resolve aborted runs with accumulated usage. Stuck
detection spreads that result onto one terminal author row, and the ledger
CAS bills it once. The throw-`AbortError` zeros are unreachable after emitted
usage. No production refactor. Next implementation item is O10.

### 6. O10 — measure synchronous worktree preparation — complete

A 10,202-file / 201-package fixture measures 34 ms per inspect and 147 ms for
four stacked inspect+hash calls on `darwin/arm64`. That is below the
hundreds-of-ms bar on this host class, and the walk already hashes only
manifests/lockfiles. Deferred; no production refactor. Next item is O22.

### 7. O22 — measure Board live-run rendering — complete

A 12-task fixture showed 200 Board commits / 2,400 card renders / 20 wasted
estimate fetches on a 200-log + 20 same-status burst. Activity now flushes once
per animation frame; estimates refetch only on status/model/difficulty/
maxAttempts. After: 1 commit, 12 card renders, 0 same-status estimate fetches.
Clock isolation and TaskCard memo are deferred.

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
