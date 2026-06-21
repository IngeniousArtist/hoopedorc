// WebSocket contract for realtime updates (live logs, board changes, alerts).

import type {
  CostRecord,
  LogEvent,
  MergeDecision,
  Notification,
  Project,
  Run,
  Task,
} from "./domain";

/** Server -> client events, pushed over the WS connection at WS_PATH. */
export type ServerEvent =
  | { type: "log"; payload: LogEvent }
  | { type: "task.updated"; payload: Task }
  | { type: "run.updated"; payload: Run }
  | { type: "project.updated"; payload: Project }
  | { type: "project.deleted"; payload: { id: string } }
  | { type: "merge.decision"; payload: MergeDecision }
  | { type: "notification"; payload: Notification }
  | { type: "cost.updated"; payload: CostRecord };

export type ServerEventType = ServerEvent["type"];

/** Client -> server messages. */
export type ClientEvent =
  | { type: "subscribe"; projectId: string }
  | { type: "unsubscribe"; projectId: string }
  | { type: "ping" };

export const WS_PATH = "/ws";
