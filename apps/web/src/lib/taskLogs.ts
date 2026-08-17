import type { LogEvent } from "@orc/types";

export const TASK_LOG_LIMIT = 1000;

export type BoundedTaskLogs = {
  logs: LogEvent[];
  omittedOlder: boolean;
};

export function retainNewestTaskLogs(
  logs: LogEvent[],
  limit = TASK_LOG_LIMIT,
): BoundedTaskLogs {
  if (logs.length <= limit) return { logs, omittedOlder: false };
  return { logs: logs.slice(-limit), omittedOlder: true };
}

export function appendTaskLog(
  current: LogEvent[],
  event: LogEvent,
  alreadyOmitted: boolean,
  limit = TASK_LOG_LIMIT,
): BoundedTaskLogs {
  if (current.some((log) => log.id === event.id)) {
    return { logs: current, omittedOlder: alreadyOmitted };
  }
  const next = retainNewestTaskLogs([...current, event], limit);
  return {
    logs: next.logs,
    omittedOlder: alreadyOmitted || next.omittedOlder,
  };
}
