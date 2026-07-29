# Durable retry accounting

O34 keeps an operator's configured attempt policy separate from the recovery
allowance granted while one logical task run moves through rate-limit waits and
fallback models.

## Terms and invariants

- `maxAttempts` is immutable policy for a task. Engine control flow never
  changes it.
- `attempts` is the number of author invocations reserved in the current
  logical run. It is persisted before an author subprocess may start.
- `runExtraAttempts` is the durable recovery allowance granted in the current
  logical run. The effective attempt limit is
  `maxAttempts + runExtraAttempts`.
- `runModel`, `runExhaustedModels`, and `runRateLimitRetries` are the durable
  fallback position and same-model rate-limit state for the current logical
  run.
- `runGeneration` identifies the logical run. Initial execution is generation
  zero. Each accepted manual Retry increments it exactly once.

The task row is the transaction boundary for an engine transition. A
rate-limit allowance, fallback selection, exhausted-model update, requeue or
terminal status is persisted in one row update before another attempt can
start. A restart therefore resumes from the stored model and effective limit,
not from process memory.

## State transitions

| Boundary | Durable transition |
| --- | --- |
| Reserve an author invocation | Increment `attempts`, persist, then invoke |
| Wait and retry the same rate-limited model | Increment `runRateLimitRetries` and `runExtraAttempts` together before waiting |
| Switch to a fallback | Add the old model to `runExhaustedModels`, set `runModel`, reset `runRateLimitRetries`, and persist the stage decision's recovery allowance. Author failure adds one only when no effective headroom remains; no-change, gate, and self-review recovery retain their existing one-slot allowance |
| Requeue after merge conflict | Preserve the logical run, grant one recovery attempt, reset fallback position to the assigned model, and clear stale PR execution coordinates |
| Budget/quota/pause interruption | Preserve the complete task-run state |
| Terminal failure | Preserve the complete task-run state for diagnosis |
| Accepted manual Retry | Atomically increment `runGeneration`; reset `attempts`, `runExtraAttempts`, fallback position, and stale execution coordinates; set durable scheduler intent; create one retry audit entry |

Changing live routing may remove a stored model. Normal enabled-model
resolution still applies, but it must persist the replacement before invoking
it. Disabled or missing candidates consume no author attempt.

## Run identity and migration

Generation zero retains the historical `run-<task>-<attempt>` identifier so
existing persisted approvals remain recoverable. Later generations use
`run-<task>-g<generation>-<attempt>`. Documenter runs use the same generation
component. This prevents a genuine Retry from overwriting invocation, run, or
merge-decision history from an earlier logical run.

The SQLite migration adds non-null zero defaults for generation, recovery
allowance, and rate-limit retries; a nullable current model; and a JSON
exhausted-model list defaulting to `[]`. Existing `attempts` and
`max_attempts` values are preserved. Historical `max_attempts` inflation
cannot be distinguished safely from operator policy, so migration does not
guess or reduce it.

## API and board semantics

The canonical `Task` contract exposes all task-run fields. The board describes
`attempts` as consumed author invocations and `maxAttempts` as policy, showing
any `runExtraAttempts` recovery allowance separately. It never presents the
effective limit as if it were user policy.

## Non-goals

- Do not change fallback ordering, rate-limit wait duration, or the number of
  same-model rate-limit retries.
- Do not rewrite historical task rows or reconstruct unavailable provenance.
- Do not add a second scheduler or retry endpoint.
- Do not make task failure, validation, gates, or destructive-change policy
  more permissive.
