import type { LogEvent } from "@orc/types";
import { useEffect, useRef, useState } from "react";

const LEVEL_COLORS: Record<string, string> = {
  debug: "text-neutral-400",
  info: "text-neutral-200",
  warn: "text-amber-400",
  error: "text-red-400",
};

const SOURCE_COLORS: Record<string, string> = {
  agent: "text-blue-400",
  engine: "text-neutral-400",
  git: "text-green-400",
  gate: "text-yellow-400",
  validator: "text-purple-400",
};

const SOURCES = ["all", "agent", "engine", "git", "gate", "validator"];

/**
 * The Logs tab of TaskDrawer — a source filter + auto-follow toggle over the
 * live+historical log list. No outer chrome (fixed positioning, header, close
 * button) here; TaskDrawer owns that since it's shared across all tabs now.
 */
export function LogPanel({
  logs,
  loading,
}: {
  logs: LogEvent[];
  loading: boolean;
}) {
  const [source, setSource] = useState("all");
  const [autoFollow, setAutoFollow] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const filtered =
    source === "all" ? logs : logs.filter((l) => l.source === source);

  useEffect(() => {
    if (autoFollow) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [filtered.length, autoFollow]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-800 px-3 py-2">
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-300"
        >
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-[11px] text-neutral-400">
          <input
            type="checkbox"
            checked={autoFollow}
            onChange={(e) => setAutoFollow(e.target.checked)}
          />
          auto-follow
        </label>
      </div>

      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed">
        {loading && <p className="text-neutral-400">Loading logs…</p>}
        {!loading && filtered.length === 0 && (
          <p className="text-neutral-400">No logs yet.</p>
        )}
        {filtered.map((log) => (
          <div key={log.id} className="mb-1 flex gap-2">
            <span className="shrink-0 text-neutral-600">
              {new Date(log.ts).toLocaleTimeString()}
            </span>
            <span
              className={
                "shrink-0 " + (SOURCE_COLORS[log.source] ?? "text-neutral-400")
              }
            >
              [{log.source}]
            </span>
            <span className={LEVEL_COLORS[log.level] ?? "text-neutral-300"}>
              {log.message}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
