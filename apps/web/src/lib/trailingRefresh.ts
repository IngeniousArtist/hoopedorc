import { isAbortError } from "../api/client";

/** O23: no extra debounce timer. Freshness lag is at most one in-flight refresh. */
export const TRAILING_REFRESH_INTERVAL_MS = 0;

export type TrailingRefresh = {
  request: () => void;
  dispose: () => void;
};

/**
 * One in-flight fetch plus at most one trailing fetch. Events during a request
 * increment the requested generation and never skip the final invalidation.
 */
export function createTrailingRefresh<T>(options: {
  run: (signal: AbortSignal) => Promise<T>;
  onResult: (value: T) => void;
  onError?: (error: unknown) => void;
}): TrailingRefresh {
  let requestedGeneration = 0;
  let completedGeneration = 0;
  let inFlight = false;
  let disposed = false;
  let controller: AbortController | null = null;

  async function pump(): Promise<void> {
    if (inFlight || disposed) return;
    inFlight = true;
    const generation = requestedGeneration;
    controller = new AbortController();
    try {
      const value = await options.run(controller.signal);
      if (!disposed && requestedGeneration === generation) {
        options.onResult(value);
      }
    } catch (error) {
      if (
        disposed ||
        isAbortError(error) ||
        requestedGeneration !== generation
      ) {
        return;
      }
      options.onError?.(error);
    } finally {
      completedGeneration = generation;
      inFlight = false;
      controller = null;
      if (!disposed && requestedGeneration > completedGeneration) {
        void pump();
      }
    }
  }

  return {
    request() {
      if (disposed) return;
      requestedGeneration += 1;
      void pump();
    },
    dispose() {
      disposed = true;
      controller?.abort();
      controller = null;
    },
  };
}
