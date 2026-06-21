import { useEffect, useRef } from "react";
import type { ServerEvent } from "@orc/types";

/** Reconnect backoff: 1s → 2s → 4s … capped at 15s. */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 15_000;

/**
 * Subscribe to the server's event stream for a project. Auto-reconnects with
 * capped exponential backoff so a server restart, laptop sleep, or network
 * blip during a long autonomous run doesn't silently freeze the UI — on
 * reconnect it re-subscribes and the server replays the project snapshot.
 */
export function useWS(
  projectId: string,
  onEvent: (e: ServerEvent) => void,
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let closed = false; // set on cleanup so we stop reconnecting

    const connect = () => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${protocol}//${location.host}/ws`);

      ws.onopen = () => {
        attempts = 0; // reset backoff once a connection succeeds
        ws?.send(JSON.stringify({ type: "subscribe", projectId }));
      };

      ws.onmessage = (msg) => {
        try {
          onEventRef.current(JSON.parse(msg.data) as ServerEvent);
        } catch {
          /* ignore malformed messages */
        }
      };

      const scheduleReconnect = () => {
        if (closed || reconnectTimer) return;
        const delay = Math.min(
          BACKOFF_BASE_MS * 2 ** attempts,
          BACKOFF_MAX_MS,
        );
        attempts++;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      };

      // close fires after error too, so reconnecting here covers both.
      ws.onclose = scheduleReconnect;
      ws.onerror = () => ws?.close();
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        // Drop handlers so the cleanup close() doesn't trigger a reconnect.
        ws.onclose = null;
        ws.onerror = null;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "unsubscribe", projectId }));
        }
        ws.close();
      }
    };
  }, [projectId]);
}
