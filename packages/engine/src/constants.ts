export const STUCK_DETECTION = {
  // Hard ceiling on a single author run.
  maxRunMs: 30 * 60 * 1000,
  // How long with NO output before we treat the run as hung. Raised from 3m
  // to 6m: capable-but-slower models (e.g. GLM) can think/generate quietly
  // for several minutes on a hard task, and killing them at 3m needlessly
  // burned the attempt and bounced to a fallback.
  idleMs: 6 * 60 * 1000,
  // Kill if the exact same log line repeats this many times (a real spin-loop).
  maxRepeats: 8,
} as const;

/**
 * F30: hard timeout for the per-task documentation stage. Docs, not a
 * feature — much shorter than STUCK_DETECTION.maxRunMs so a stuck documenter
 * can't hold up a validated merge for anywhere near as long as an author run.
 */
export const DOCS_STAGE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * F32: how many times a rate-limited author run waits and retries the SAME
 * model before giving up on it and falling back to the next model in the
 * chain. `stuck`/`error` exit reasons skip this entirely and fall back
 * immediately, same as before — a hung or crashing model won't be fixed by
 * waiting, so the misclassification risk only runs one way.
 */
export const RATE_LIMIT_RETRIES = 2;

/**
 * F32: how long each rate-limit wait-and-retry pauses before trying the same
 * model again. Overridable per-orchestrator via `SchedulerDeps.rateLimitWaitMs`
 * — production leaves it unset (uses this real 5-minute default); unit tests
 * shrink it drastically so a retry test doesn't sleep for real.
 */
export const RATE_LIMIT_WAIT_MS = 5 * 60 * 1000;
