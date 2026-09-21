# Shared account resources (VW13)

A pool groups model profiles using the same operator-authenticated CLI account.
It is an admission policy, not a credential store or account switcher. Existing
installations start with no pools and keep their individual limits. Configure
pool membership and limits in Settings → Resources, then Save Settings.

## Scheduling and accounting

SQLite transactions reserve each unique invocation before any model prompt.
Authors reserve before consuming an attempt; a busy pool returns them to the
existing scheduler without losing their worktree. Planning, deconstruction,
Figma verification (a health-stage call), validation and documentation wait
abortably for capacity. Model health checks fail immediately when unavailable.
No second task scheduler is introduced. Per-model author concurrency and legacy
quotas remain in place; shared pool limits also cover non-author model calls.

Validator slots are withheld from every non-review stage. They protect review
concurrency, not a separate quota allowance: an exhausted rolling call or cost
limit blocks reviews too. Set limits with enough room for validation and repair.
A rate-limited call puts every profile sharing the pool on a five-minute durable
cooldown. Current pool limits apply to new admission; changing membership,
billing or token prices cannot rewrite an admitted call's accounting snapshot.
Removing a pool is refused while it has occupied or unresolved slots.

Reservations count once toward the rolling call window, then the durable
invocation replaces that provisional count. A refused or cancelled unstarted
reservation is released without a ledger call. Each started invocation and
terminal charge is idempotent. Subscription billing records calls and tokens,
with zero incremental USD; the raw CLI estimate remains available in the ledger.
Metered pools use snapshotted manual prices when configured, otherwise reported
cost. Historical calls without a pool remain unpooled.

Observed cost is an admission threshold, not a prepaid reservation or guarantee
that in-flight calls cannot exceed it. The app cannot see outside usage or the
provider's remaining subscription allowance. Interrupted calls have incomplete
usage; releasing their slot does not erase that uncertainty.

## Restart and explicit recovery

A process crash does not prove a CLI child exited. On startup, ledger-backed
interrupted workers become unresolved and continue occupying capacity. Unstarted
reservations with no ledger are safe to release. Subsequent restarts do not
expire unresolved slots. Normal terminal ledger transactions settle known calls.

The Resources panel lists unresolved invocations. Verify or stop the worker on
its host, then use Resolve worker and confirm release. The action asserts that
operator check; it does not claim to inspect or kill a PID. The API requires the
exact reservation version, explicit confirmation and UUID request ID; retries
return the durable receipt. Capacity changes and receipts commit atomically.
Project removal and pool removal refuse occupied/unresolved workers.

Full worker isolation and verified process ownership are VW14. This policy does
not turn host CLI execution into a sandbox. AWS checks remain deferred because
the owner has no running installation. No provider login, paid model call or
Telegram message is needed to configure or test the admission policy locally.

VW13 project deletion retains detached pooled invocation usage so cleanup cannot
reset a shared rolling quota. Project/task/run identifiers are removed from those
ledger rows; deleting occupied or unresolved workers remains refused.
