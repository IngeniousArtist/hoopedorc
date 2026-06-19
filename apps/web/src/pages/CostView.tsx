import type {
  CostRecord,
  CostsResponse,
  ServerEvent,
} from "@orc/types";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { useWS } from "../hooks/useWS";

export function CostView({ projectId }: { projectId: string }) {
  const [costs, setCosts] = useState<CostsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchCosts = useCallback(async () => {
    try {
      const data = await api<CostsResponse>("costs", {
        params: { id: projectId },
      });
      setCosts(data);
    } catch (e) {
      setError(String(e));
    }
  }, [projectId]);

  useEffect(() => {
    fetchCosts();
  }, [fetchCosts]);

  const handleWSEvent = useCallback(
    (event: ServerEvent) => {
      if (event.type === "cost.updated") {
        fetchCosts();
      }
    },
    [fetchCosts],
  );

  useWS(projectId, handleWSEvent);

  if (error) {
    return (
      <div className="text-sm text-red-400">Error: {error}</div>
    );
  }

  if (!costs) {
    return (
      <div className="text-sm text-neutral-400">
        Loading costs…
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h2 className="mb-6 text-lg font-semibold">
        Cost Tracking
      </h2>

      <div className="mb-6 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <div className="text-3xl font-semibold text-neutral-100">
          ${costs.totalUsd.toFixed(4)}
        </div>
        <div className="mt-1 text-xs text-neutral-500">
          Total spend
        </div>
      </div>

      <div className="rounded-lg border border-neutral-800 bg-neutral-900">
        <h3 className="border-b border-neutral-800 px-4 py-3 text-sm font-medium text-neutral-300">
          By Model
        </h3>
        <div className="divide-y divide-neutral-800">
          {Object.entries(costs.byModel).length === 0 && (
            <div className="px-4 py-3 text-xs text-neutral-500">
              No costs yet
            </div>
          )}
          {Object.entries(costs.byModel).map(
            ([model, amount]) => (
              <div
                key={model}
                className="flex items-center justify-between px-4 py-3"
              >
                <span className="text-sm text-neutral-300">
                  {model}
                </span>
                <span className="text-sm font-mono text-neutral-200">
                  ${amount.toFixed(4)}
                </span>
              </div>
            ),
          )}
        </div>
      </div>

      {costs.records.length > 0 && (
        <div className="mt-6 space-y-4">
          <h3 className="text-sm font-medium text-neutral-300">
            Recent Charges
          </h3>
          <div className="space-y-2">
            {costs.records.slice(0, 20).map((r: CostRecord) => (
              <div
                key={r.id}
                className="flex items-center gap-3 rounded border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-xs"
              >
                <span className="text-neutral-500 font-mono">
                  {new Date(r.ts).toLocaleString()}
                </span>
                <span className="text-neutral-400">
                  {r.model}
                </span>
                <span className="ml-auto font-mono text-neutral-200">
                  ${r.costUsd.toFixed(4)}
                </span>
                <span className="text-neutral-500">
                  {r.tokensIn} in / {r.tokensOut} out
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
