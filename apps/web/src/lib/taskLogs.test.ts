import { describe, expect, it } from "vitest";
import type { LogEvent } from "@orc/types";
import {
  TASK_LOG_LIMIT,
  appendTaskLog,
  retainNewestTaskLogs,
} from "./taskLogs";

function log(index: number, taskId = "task-a"): LogEvent {
  return {
    id: `log-${index}`,
    projectId: "proj-test",
    runId: "run-1",
    taskId,
    ts: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    level: "info",
    source: "engine",
    message: `line ${index}`,
  };
}

describe("bounded task logs", () => {
  it("keeps the newest 1,000 from an oversized initial response", () => {
    const incoming = Array.from({ length: TASK_LOG_LIMIT + 1 }, (_, i) => log(i));
    const bounded = retainNewestTaskLogs(incoming);
    expect(bounded.logs).toHaveLength(TASK_LOG_LIMIT);
    expect(bounded.logs[0]?.id).toBe("log-1");
    expect(bounded.logs[TASK_LOG_LIMIT - 1]?.id).toBe(`log-${TASK_LOG_LIMIT}`);
    expect(bounded.omittedOlder).toBe(true);
    expect(new Set(bounded.logs.map((row) => row.id)).size).toBe(TASK_LOG_LIMIT);
  });

  it("does not duplicate the boundary row when a live line is appended", () => {
    const initial = retainNewestTaskLogs(
      Array.from({ length: TASK_LOG_LIMIT }, (_, i) => log(i + 1)),
    );
    const next = appendTaskLog(initial.logs, log(TASK_LOG_LIMIT + 1), initial.omittedOlder);
    expect(next.logs).toHaveLength(TASK_LOG_LIMIT);
    expect(next.logs[0]?.id).toBe("log-2");
    expect(next.logs[TASK_LOG_LIMIT - 1]?.id).toBe(`log-${TASK_LOG_LIMIT + 1}`);
    expect(next.logs.filter((row) => row.id === "log-2")).toHaveLength(1);
    expect(next.omittedOlder).toBe(true);
  });

  it("ignores a streamed duplicate of the last retained row", () => {
    const current = [log(1), log(2)];
    const next = appendTaskLog(current, log(2), false);
    expect(next.logs.map((row) => row.id)).toEqual(["log-1", "log-2"]);
    expect(next.omittedOlder).toBe(false);
  });
});
