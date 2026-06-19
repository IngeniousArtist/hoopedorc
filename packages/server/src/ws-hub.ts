import type { ServerEvent } from "@orc/types";
import type WebSocket from "ws";

type Client = {
  ws: WebSocket;
  projectId?: string;
};

export class WsHub {
  private clients = new Set<Client>();

  add(ws: WebSocket): () => void {
    const client: Client = { ws };
    this.clients.add(client);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "subscribe" && msg.projectId) {
          client.projectId = msg.projectId;
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
