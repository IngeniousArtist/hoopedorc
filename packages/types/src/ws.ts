// WebSocket contract for realtime updates (live logs, board changes, alerts).

import type {
  CostRecord,
  LogEvent,
  MergeDecision,
  Notification,
  Project,
  RollbackJob,
  Run,
  Task,
} from "./domain";

/** Authoritative project-level spend used to reseed clients after a
 * reconnect. Unlike cost.updated, this is a total rather than a delta. */
export type CostSnapshot = {
  projectId: string;
  totalUsd: number;
};

/** Durable global notification state used to reseed clients after reconnect. */
export type NotificationSnapshot = {
  notifications: Notification[];
};

/** Authoritative global project state used to reseed clients after reconnect.
 * Replacing the client list from this snapshot also removes projects whose
 * deletion event was missed while the socket was offline. */
export type ProjectSnapshot = {
  projects: Project[];
};

/** Server -> client events, pushed over the WS connection at WS_PATH. */
export type ServerEvent =
  | { type: "log"; payload: LogEvent }
  | { type: "task.updated"; payload: Task }
  | { type: "run.updated"; payload: Run }
  | { type: "project.updated"; payload: Project }
  | { type: "project.deleted"; payload: { id: string } }
  | { type: "projects.snapshot"; payload: ProjectSnapshot }
  | { type: "merge.decision"; payload: MergeDecision }
  | { type: "rollback.updated"; payload: RollbackJob }
  | { type: "notification"; payload: Notification }
  | { type: "notifications.snapshot"; payload: NotificationSnapshot }
  | { type: "cost.updated"; payload: CostRecord }
  | { type: "cost.snapshot"; payload: CostSnapshot };

export type ServerEventType = ServerEvent["type"];

/** Client -> server messages. */
export type ClientEvent =
  | { type: "subscribe"; projectId: string }
  | { type: "unsubscribe"; projectId: string }
  | { type: "ping" };

export const WS_PATH = "/ws";
