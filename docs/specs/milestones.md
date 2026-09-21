# Milestone acceptance (VW15)

Task remains the scheduling unit. A Task with `milestone` is a read-only
verification job against combined committed work. Its acceptance criteria map
to all its `dependsOn` contributors. Normal deconstruction appends explicit
verification drafts before review; no work is inserted at commit time. A user
may remove or edit these drafts before approval. Every reviewed payload is
Git-persisted with the brief. Existing plans are not retroactively accepted.

A check requires a clean owned worktree, passing gates with an executed test
command, an independent successful reviewer, concrete evidence for each exact
criterion and an unchanged combined revision. Failure, skipped commands,
provider interruption, stale dependencies or changed HEAD cannot become an
acceptance receipt through human merge approval. Evidence is historical when
its revision or dependency generations no longer match. The local observed
checkout is authoritative for freshness; unobserved remote changes are not
claimed current.

Repair is a deterministic two-task proposal (one scoped author, one verifier)
through the existing versioned plan comparison and apply flow. It includes the
original brief/criteria, dependency mapping, scope, limits and failure reasons.
Only title, description and eligible model choice are editable. A receipt
uniquely identifies root milestone, round and planning revision. Exactly-once
apply happens after Git push, in the same transaction as task creation. Existing
planning text is preserved; stale versions and conflicting drafts are refused.

One durable deadline, call allowance and observed-spend cutoff govern all
verification and repair activity. Each admission is counted once even if the
provider never reports usage. A lost process cannot reset budgets; cleanup and
capacity remain owned by VW13/VW14. Reviewer failures preserve independent
contributions. A failed repair's dependent verifier can remain historical while
a later approved repair proceeds; active repair ownership must settle first.

Validation includes a real local Git/worktree/process journey and no-model
fixtures for failure, restart, cancellation, bounded repair and stale proof.
Live provider calls and AWS deployment are separate pending acceptance checks.
