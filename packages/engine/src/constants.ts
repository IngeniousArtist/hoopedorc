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
