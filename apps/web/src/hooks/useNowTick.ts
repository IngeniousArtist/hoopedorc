import { useEffect, useState } from "react";

/** Re-render the caller once a second while enabled. Isolated so a live
 *  heartbeat/elapsed label does not refresh the rest of the Board. */
export function useNowTick(enabled: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [enabled]);
}
