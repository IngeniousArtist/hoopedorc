import { useEffect, useRef } from "react";
import type { ServerEvent } from "@orc/types";

export function useWS(
  projectId: string,
  onEvent: (e: ServerEvent) => void,
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe", projectId }));
    };

    ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as ServerEvent;
        onEventRef.current(event);
      } catch {
        /* ignore malformed messages */
      }
    };

    return () => {
      ws.send(
        JSON.stringify({ type: "unsubscribe", projectId }),
      );
      ws.close();
    };
  }, [projectId]);
}
