import type {
  CostAnalyticsResponse,
  EstimateResponse,
  ServerEvent,
} from "@orc/types";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { useWS } from "../hooks/useWS";

const usd = (n: number) => "$" + n.toFixed(4);
const fmtTokens = (n: number) =>
  n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);

export function CostView({ projectId }: { projectId: string }) {
  const [a, setA] = useState<CostAnalyticsResponse | null>(null);
  const [est, setEst] = useState<EstimateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [analytics, estimate] = await Promise.all([
        api<CostAnalyticsResponse>("costAnalytics", { params: { id: projectId } }),
        api<EstimateResponse>("estimatePlan", { params: { id: projectId } }),
      ]);
      setA(analytics);
      setEst(estimate);
    } catch (e) {
      setError(String(e));
    }
  }, [projectId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const onWS = useCallback(
    (event: ServerEvent) => {
      if (event.type === "cost.updated" || event.type === "task.updated") {
        fetchAll();
      }
    },
    [fetchAll],
  );
  useWS(projectId, onWS);

  if (error) return <div className="text-sm text-red-400">Error: {error}</div>;
  if (!a) return <div className="text-sm text-neutral-400">Loading costs…</div>;

  const budgetPct =
    a.budgetUsd && a.budgetUsd > 0
      ? Math.min(100, (a.totalUsd / a.budgetUsd) * 100)
      : null;
  const maxDaily = Math.max(1e-9, ...a.daily.map((d) => d.costUsd));

  return (
    <div className="max-w-3xl space-y-6">
      <h2 className="text-lg font-semibold">Costs &amp; Analytics</h2>

      {/* Headline + budget */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <div className="text-3xl font-semibold text-neutral-100">
            {usd(a.totalUsd)}
          </div>
          <div className="mt-1 text-xs text-neutral-500">Total spend</div>
        </div>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <div className="text-3xl font-semibold text-neutral-100">
            {fmtTokens(a.totalTokensIn)}
            <span className="text-base text-neutral-500"> / </span>
            {fmtTokens(a.totalTokensOut)}
          </div>
          <div className="mt-1 text-xs text-neutral-500">Tokens in / out</div>
        </div>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <div className="text-3xl font-semibold text-neutral-100">
            {a.completedTasks}
          </div>
          <div className="mt-1 text-xs text-neutral-500">
            tasks done · avg {usd(a.avgCostPerCompletedTask)}/task
          </div>
        </div>
      </div>

      {a.budgetUsd != null && (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="text-neutral-400">
              Budget {usd(a.totalUsd)} / {usd(a.budgetUsd)}
            </span>
            <span className="text-neutral-500">
              {a.remainingBudgetUsd != null && (
                <>{usd(a.remainingBudgetUsd)} left</>
              )}
              {a.tasksUntilCap != null && (
                <> · ~{a.tasksUntilCap} more tasks at this rate</>
              )}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded bg-neutral-800">
            <div
              className={
                "h-full " +
                ((budgetPct ?? 0) > 90
                  ? "bg-red-500"
                  : (budgetPct ?? 0) > 70
                    ? "bg-amber-500"
                    : "bg-green-600")
              }
              style={{ width: `${budgetPct ?? 0}%` }}
            />
          </div>
        </div>
      )}

      {/* Pre-run estimate */}
      {est && est.tasks.length > 0 && (
        <div className="rounded-lg border border-blue-900/60 bg-blue-950/20 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium text-blue-200">
              Pre-run estimate ({est.tasks.length} task
              {est.tasks.length === 1 ? "" : "s"} left)
            </h3>
            <span className="text-sm font-mono text-blue-100">
              {usd(est.totalExpectedUsd)}–{usd(est.totalHighUsd)}
            </span>
          </div>
          <p className="mb-3 text-[11px] text-neutral-400">
            {est.note}{" "}
            <span
              className={
                est.confidence === "high"
                  ? "text-green-400"
                  : "text-amber-400"
              }
            >
              ({est.confidence} confidence)
            </span>
          </p>
          <div className="space-y-1">
            {est.tasks.map((t) => (
              <div
                key={t.taskId}
                className="flex items-center gap-2 text-[11px]"
              >
                <span className="flex-1 truncate text-neutral-300">
                  {t.title}
                </span>
                <span className="text-neutral-500">
                  {t.model} → {t.validatorModel}
                </span>
                <span className="w-28 text-right font-mono text-neutral-200">
                  {usd(t.expectedUsd)}–{usd(t.highUsd)}
                </span>
                {!t.hasHistory && (
                  <span className="text-amber-500" title="no run history">
                    ≈
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Daily series */}
      {a.daily.length > 0 && (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
          <h3 className="mb-3 text-sm font-medium text-neutral-300">
            Spend over time
          </h3>
          <div className="space-y-1">
            {a.daily.map((d) => (
              <div key={d.date} className="flex items-center gap-2 text-[11px]">
                <span className="w-20 shrink-0 font-mono text-neutral-500">
                  {d.date}
                </span>
                <div className="h-3 flex-1 overflow-hidden rounded bg-neutral-800">
                  <div
                    className="h-full bg-blue-600"
                    style={{ width: `${(d.costUsd / maxDaily) * 100}%` }}
                  />
                </div>
                <span className="w-16 text-right font-mono text-neutral-300">
                  {usd(d.costUsd)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* By model */}
      <div className="rounded-lg border border-neutral-800 bg-neutral-900">
        <h3 className="border-b border-neutral-800 px-4 py-3 text-sm font-medium text-neutral-300">
          By model
        </h3>
        <div className="divide-y divide-neutral-800">
          {a.byModel.length === 0 && (
            <div className="px-4 py-3 text-xs text-neutral-500">No costs yet</div>
          )}
          {a.byModel.map((m) => (
            <div
              key={m.model}
              className="flex items-center gap-3 px-4 py-3 text-sm"
            >
              <span className="text-neutral-300">{m.model}</span>
              <span className="text-[11px] text-neutral-500">
                {m.runs} run{m.runs === 1 ? "" : "s"} ·{" "}
                {fmtTokens(m.tokensIn)}/{fmtTokens(m.tokensOut)} tok
              </span>
              <span className="ml-auto font-mono text-neutral-200">
                {usd(m.costUsd)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* By task */}
      {a.byTask.length > 0 && (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900">
          <h3 className="border-b border-neutral-800 px-4 py-3 text-sm font-medium text-neutral-300">
            By task
          </h3>
          <div className="divide-y divide-neutral-800">
            {a.byTask.map((t) => (
              <div
                key={t.taskId || t.title}
                className="flex items-center justify-between px-4 py-2 text-xs"
              >
                <span className="truncate text-neutral-300">{t.title}</span>
                <span className="ml-3 shrink-0 font-mono text-neutral-200">
                  {usd(t.costUsd)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
