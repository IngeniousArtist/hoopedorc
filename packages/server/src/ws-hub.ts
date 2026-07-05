import type { ServerEvent } from "@orc/types";
import type WebSocket from "ws";

type Client = {
  ws: WebSocket;
  projectId?: string;
};

/**
 * Which project an event belongs to, for broadcast scoping (B15) —
 * `undefined` for the event types treated as global (see broadcast()).
 */
function eventProjectId(event: ServerEvent): string | undefined {
  switch (event.type) {
    case "log":
    case "task.updated":
    case "run.updated":
    case "cost.updated":
    case "merge.decision":
      return event.payload.projectId;
    case "project.updated":
    case "project.deleted":
      return event.payload.id;
    case "notification":
      return undefined;
  }
}

/** Broadcast to every client regardless of subscription: project-level
 *  events (useful even to a client that hasn't picked a project yet, e.g. a
 *  projects list page) and notifications (the "needs you" channel). */
function isGlobalEvent(event: ServerEvent): boolean {
  return (
    event.type === "project.updated" ||
    event.type === "project.deleted" ||
    event.type === "notification"
  );
}

export class WsHub {
  private clients = new Set<Client>();

  /**
   * Returns the catch-up snapshot for a project a client just subscribed to.
   * Set once by the server; kept here so the hub doesn't depend on the db.
   */
  private snapshotFor?: (projectId: string) => ServerEvent[];

  setSnapshotProvider(fn: (projectId: string) => ServerEvent[]): void {
    this.snapshotFor = fn;
  }

  add(ws: WebSocket): () => void {
    const client: Client = { ws };
    this.clients.add(client);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "subscribe" && msg.projectId) {
          client.projectId = msg.projectId;
          // Send the catch-up snapshot for JUST this project on subscribe,
          // rather than replaying every project's full task+run history to
          // every client on connect (which scaled with total project count).
          if (this.snapshotFor && ws.readyState === 1) {
            for (const event of this.snapshotFor(msg.projectId)) {
              ws.send(JSON.stringify(event));
            }
          }
        } else if (msg.type === "unsubscribe") {
          client.projectId = undefined;
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on("close", () => {
      this.clients.delete(client);
    });

    return () => this.clients.delete(client);
  }

  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    const global = isGlobalEvent(event);
    const scopeId = eventProjectId(event);
    for (const client of this.clients) {
      if (client.ws.readyState !== 1 /* WebSocket.OPEN */) continue;
      // Project-scoped events (logs, task/run updates, merge decisions, cost)
      // only go to clients subscribed to that same project — previously every
      // client got every project's events and relied on client-side filtering,
      // which meant N running projects meant N× the WS traffic per tab and a
      // (harmless today, but latent) cross-project log/task-id collision risk.
      if (!global && client.projectId !== scopeId) continue;
      client.ws.send(payload);
    }
  }
}
