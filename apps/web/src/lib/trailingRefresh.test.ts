import { describe, expect, it, vi } from "vitest";
import {
  TRAILING_REFRESH_INTERVAL_MS,
  createTrailingRefresh,
} from "./trailingRefresh";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("trailing refresh coalescer", () => {
  it("documents a zero-ms freshness interval", () => {
    expect(TRAILING_REFRESH_INTERVAL_MS).toBe(0);
  });

  it("starts immediately when idle and coalesces a burst into one trailing fetch", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const runs: AbortSignal[] = [];
    const results: string[] = [];
    const refresh = createTrailingRefresh({
      run: (signal) => {
        runs.push(signal);
        return runs.length === 1 ? first.promise : second.promise;
      },
      onResult: (value) => {
        results.push(value);
      },
    });

    refresh.request();
    refresh.request();
    refresh.request();
    refresh.request();
    expect(runs).toHaveLength(1);

    first.resolve("stale");
    await first.promise;
    await Promise.resolve();
    expect(runs).toHaveLength(2);
    expect(results).toEqual([]);

    second.resolve("final");
    await second.promise;
    await Promise.resolve();
    expect(runs).toHaveLength(2);
    expect(results).toEqual(["final"]);
    refresh.dispose();
  });

  it("starts a trailing fetch for an event that arrives as the in-flight fetch settles", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let runCount = 0;
    const results: string[] = [];
    const refresh = createTrailingRefresh({
      run: () => {
        runCount += 1;
        return runCount === 1 ? first.promise : second.promise;
      },
      onResult: (value) => {
        results.push(value);
      },
    });

    refresh.request();
    first.resolve("first");
    refresh.request();
    await first.promise;
    await Promise.resolve();
    expect(runCount).toBe(2);

    second.resolve("after-settle");
    await second.promise;
    await Promise.resolve();
    expect(results).toEqual(["after-settle"]);
    refresh.dispose();
  });

  it("does not start a trailing fetch after dispose and ignores abort errors", async () => {
    const first = deferred<string>();
    const onResult = vi.fn();
    const onError = vi.fn();
    const refresh = createTrailingRefresh({
      run: (signal) => {
        signal.addEventListener("abort", () => {
          first.reject(new DOMException("The operation was aborted.", "AbortError"));
        });
        return first.promise;
      },
      onResult,
      onError,
    });

    refresh.request();
    refresh.request();
    refresh.dispose();
    await first.promise.catch(() => undefined);
    await Promise.resolve();

    expect(onResult).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
