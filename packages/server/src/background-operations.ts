export type BackgroundOperation = () => void | Promise<unknown>;
export type BackgroundFailureReporter = (label: string, error: unknown) => void;

/**
 * Own one fire-and-forget operation for its complete lifetime.
 *
 * The operation starts immediately so callers retain their existing ordering;
 * synchronous throws and returned promise rejections then take the same
 * reporting path. The rejection handler is attached in this call stack. The
 * owned wrapper always settles after reporting a failure, which keeps
 * process-level unhandledRejection reserved for genuinely unowned failures.
 */
export function runBackgroundOperation(
  pending: Set<Promise<void>>,
  label: string,
  operation: BackgroundOperation,
  reportFailure: BackgroundFailureReporter,
): void {
  let result: void | Promise<unknown>;
  try {
    result = operation();
  } catch (error) {
    result = Promise.reject(error);
  }
  const owned = Promise.resolve(result).then(
    () => {},
    (error) => {
      try {
        reportFailure(label, error);
      } catch {
        // A broken reporter must not recreate the unhandled rejection this
        // owner exists to prevent. Keep the fallback credential-free.
        console.error(`[hoopedorc] failed to report background operation: ${label}`);
      }
    },
  );
  pending.add(owned);
  void owned.then(() => pending.delete(owned));
}
