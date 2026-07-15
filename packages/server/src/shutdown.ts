export type RuntimeLifecycleState =
  | "starting"
  | "running"
  | "shutting_down"
  | "stopped";

export type ShutdownReason =
  | "SIGTERM"
  | "SIGINT"
  | "uncaught_exception"
  | "unhandled_rejection";

export interface ShutdownDependencies<EngineResult = unknown> {
  /** Synchronously flips request/dispatch admission before any await. */
  stopAccepting(reason: ShutdownReason): void | Promise<void>;
  stopEngine(reason: ShutdownReason): Promise<EngineResult>;
  stopTelegram(): void | Promise<void>;
  flushLogs(): void | Promise<void>;
  recordAudit(reason: ShutdownReason, result: EngineResult): void | Promise<void>;
  closeServer(): void | Promise<void>;
  checkpointDb(): void | Promise<void>;
  closeDb(): void | Promise<void>;
  log(message: string, error?: unknown): void;
  exit(code: number): void;
}

export interface ShutdownSnapshot {
  state: RuntimeLifecycleState;
  reason?: ShutdownReason;
  requestedAt?: string;
  errorCount: number;
}

/**
 * One idempotent, ordered shutdown transaction shared by signal and fatal
 * process handlers. Every step is attempted even if an earlier best-effort
 * cleanup fails; any cleanup failure upgrades a graceful exit to non-zero so
 * systemd can restart a degraded process.
 */
export class ShutdownCoordinator<EngineResult = unknown> {
  private snapshotValue: ShutdownSnapshot = {
    state: "starting",
    errorCount: 0,
  };
  private shutdownPromise?: Promise<void>;

  constructor(private readonly deps: ShutdownDependencies<EngineResult>) {}

  get snapshot(): ShutdownSnapshot {
    return { ...this.snapshotValue };
  }

  markRunning(): void {
    if (this.snapshotValue.state === "starting") {
      this.snapshotValue = { state: "running", errorCount: 0 };
    }
  }

  shutdown(reason: ShutdownReason, requestedExitCode: number): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.snapshotValue = {
      state: "shutting_down",
      reason,
      requestedAt: new Date().toISOString(),
      errorCount: 0,
    };

    this.shutdownPromise = this.perform(reason, requestedExitCode);
    return this.shutdownPromise;
  }

  private async perform(reason: ShutdownReason, requestedExitCode: number): Promise<void> {
    const errors: unknown[] = [];
    const step = async <T>(name: string, run: () => T | Promise<T>): Promise<T | undefined> => {
      try {
        return await run();
      } catch (error) {
        errors.push(error);
        this.snapshotValue.errorCount = errors.length;
        this.deps.log(`shutdown step failed: ${name}`, error);
        return undefined;
      }
    };

    this.deps.log(`shutdown requested: ${reason}`);
    await step("stop accepting work", () => this.deps.stopAccepting(reason));
    const engineResult = await step("stop engine", () => this.deps.stopEngine(reason));
    await step("stop Telegram", () => this.deps.stopTelegram());
    await step("flush logs", () => this.deps.flushLogs());
    if (engineResult !== undefined) {
      await step("write shutdown audit", () =>
        this.deps.recordAudit(reason, engineResult),
      );
    }
    await step("close server", () => this.deps.closeServer());
    await step("checkpoint database", () => this.deps.checkpointDb());
    await step("close database", () => this.deps.closeDb());

    this.snapshotValue.state = "stopped";
    const exitCode = requestedExitCode === 0 && errors.length > 0 ? 1 : requestedExitCode;
    this.deps.log(
      `shutdown complete: ${reason} (exit ${exitCode}, ${errors.length} cleanup error(s))`,
    );
    this.deps.exit(exitCode);
  }
}

export interface ProcessShutdownTarget {
  on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  on(event: "uncaughtException", listener: (error: Error) => void): unknown;
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  off(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  off(event: "uncaughtException", listener: (error: Error) => void): unknown;
  off(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
}

/** Install production process handlers while keeping the lifecycle reusable in
 * child-process integration tests. Fatal async errors are restart-worthy. */
export function installShutdownHandlers(
  coordinator: ShutdownCoordinator,
  target: ProcessShutdownTarget = process,
  logFatal: (message: string, error: unknown) => void = () => {},
): () => void {
  const sigterm = () => void coordinator.shutdown("SIGTERM", 0);
  const sigint = () => void coordinator.shutdown("SIGINT", 0);
  const uncaught = (error: Error) => {
    logFatal("uncaughtException", error);
    void coordinator.shutdown("uncaught_exception", 1);
  };
  const unhandled = (reason: unknown) => {
    logFatal("unhandledRejection", reason);
    void coordinator.shutdown("unhandled_rejection", 1);
  };
  target.on("SIGTERM", sigterm);
  target.on("SIGINT", sigint);
  target.on("uncaughtException", uncaught);
  target.on("unhandledRejection", unhandled);
  return () => {
    target.off("SIGTERM", sigterm);
    target.off("SIGINT", sigint);
    target.off("uncaughtException", uncaught);
    target.off("unhandledRejection", unhandled);
  };
}
