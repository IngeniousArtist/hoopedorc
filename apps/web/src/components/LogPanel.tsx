import type { LogEvent } from "@orc/types";
import { useEffect, useRef } from "react";

const LEVEL_COLORS: Record<string, string> = {
  debug: "text-neutral-500",
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

export function LogPanel({
  logs,
  loading,
  onClose,
  taskTitle,
}: {
  logs: LogEvent[];
  loading: boolean;
  onClose: () => void;
  taskTitle?: string;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div className="fixed bottom-0 right-0 top-0 z-50 flex w-96 flex-col border-l border-neutral-700 bg-neutral-900 shadow-2xl">
      <div className="flex items-center justify-between border-b border-neutral-700 px-4 py-3">
        <div className="min-w-0 flex-1 text-sm font-medium text-neutral-200 truncate">
          {taskTitle ?? "Logs"}
        </div>
        <button
          onClick={onClose}
          className="ml-2 rounded p-1 text-neutral-400 hover:text-neutral-200"
          aria-label="Close log panel"
        >
          {"\u2715"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed">
        {loading && (
          <p className="text-neutral-500">Loading logs…</p>
        )}
        {!loading && logs.length === 0 && (
          <p className="text-neutral-500">No logs yet.</p>
        )}
        {logs.map((log) => (
          <div key={log.id} className="mb-1 flex gap-2">
            <span className="shrink-0 text-neutral-600">
              {new Date(log.ts).toLocaleTimeString()}
            </span>
            <span
              className={
                "shrink-0 " +
                (SOURCE_COLORS[log.source] ?? "text-neutral-500")
              }
            >
              [{log.source}]
            </span>
            <span
              className={
                LEVEL_COLORS[log.level] ?? "text-neutral-300"
              }
            >
              {log.message}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
