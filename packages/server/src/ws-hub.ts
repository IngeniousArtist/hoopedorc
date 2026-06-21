import type { ServerEvent } from "@orc/types";
import type WebSocket from "ws";

type Client = {
  ws: WebSocket;
  projectId?: string;
};

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
    for (const client of this.clients) {
      if (
        client.ws.readyState === 1 // WebSocket.OPEN
      ) {
        client.ws.send(payload);
      }
    }
  }
}
