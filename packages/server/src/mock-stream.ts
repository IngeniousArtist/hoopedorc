import { randomUUID } from "node:crypto";
import type { ServerEvent } from "@orc/types";

export type MockLogTarget = {
  projectId: string;
  taskId: string;
};

/** Emit one correctly scoped synthetic log for each project in a mock run. */
export function emitMockLogs(
  targets: readonly MockLogTarget[],
  broadcast: (event: ServerEvent) => void,
  now: () => Date = () => new Date(),
): void {
  const ts = now().toISOString();
  for (const target of targets) {
    broadcast({
      type: "log",
      payload: {
        id: randomUUID(),
        projectId: target.projectId,
        runId: "run-mock",
        taskId: target.taskId,
        ts,
        level: "info",
        source: "agent",
        message: `mock log @ ${now().toLocaleTimeString()}`,
      },
    });
  }
}

/** Start one server-owned mock stream; shutdown clears the returned timer. */
export function startMockLogStream(
  getTargets: () => readonly MockLogTarget[],
  broadcast: (event: ServerEvent) => void,
  intervalMs = 2_000,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    emitMockLogs(getTargets(), broadcast);
  }, intervalMs);
  timer.unref();
  return timer;
}
