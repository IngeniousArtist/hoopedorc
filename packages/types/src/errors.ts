/**
 * B46: thrown when persisting a model-invocation lifecycle event to the
 * ledger fails (SQLite write/CAS failure), as distinct from a domain-level
 * verification failure (e.g. Figma access denied). Code that wraps
 * invocation recording inside a capability check must let this propagate
 * instead of mislabeling a persistence/accounting failure as that
 * capability being unavailable. Lives in @orc/types (not @orc/server) so
 * @orc/engine, which may not depend on @orc/server, can `instanceof`-check
 * it too.
 */
export class InvocationLedgerError extends Error {
  override readonly name = "InvocationLedgerError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
