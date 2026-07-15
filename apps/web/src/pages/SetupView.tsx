import type {
  HealthResponse,
  ModelHealthResponse,
  SetupHealthResponse,
  TestModelsResponse,
} from "@orc/types";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  // Round the total first, then split — rounding the remainder independently
  // can produce "9m 60s" instead of "10m 0s" right at a minute boundary.
  const totalSeconds = Math.round(ms / 1000);
  return totalSeconds < 60
    ? `${totalSeconds}s`
    : `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

export function SetupView({
  onRerunSetup,
}: {
  /** Jump back into the first-run onboarding wizard (F1) on demand. */
  onRerunSetup?: () => void;
}) {
  const [health, setHealth] = useState<SetupHealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelTest, setModelTest] = useState<TestModelsResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const [modelHealth, setModelHealth] = useState<ModelHealthResponse | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  // F24/B41: deployed version plus live lifecycle/dependency state from the
  // unauthenticated uptime endpoint. This contains no credentials.
  const [runtimeHealth, setRuntimeHealth] = useState<HealthResponse | null>(null);

  const fetchModelHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      setModelHealth(await api<ModelHealthResponse>("modelHealth"));
    } catch {
      /* non-critical panel — leave stale/empty rather than surfacing an error */
    } finally {
      setHealthLoading(false);
    }
  }, []);

  const check = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [setup, runtime] = await Promise.all([
        api<SetupHealthResponse>("setupHealth"),
        api<HealthResponse>("health"),
      ]);
      setHealth(setup);
      setRuntimeHealth(runtime);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const testAllModels = useCallback(async () => {
    setTesting(true);
    setError(null);
    setModelTest(null);
    try {
      setModelTest(await api<TestModelsResponse>("testModels"));
      fetchModelHealth(); // results just got persisted server-side — refresh
    } catch (e) {
      setError(String(e));
    } finally {
      setTesting(false);
    }
  }, [fetchModelHealth]);

  useEffect(() => {
    check();
  }, [check]);

  useEffect(() => {
    fetchModelHealth();
  }, [fetchModelHealth]);

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold">
          Setup &amp; Health
          {runtimeHealth && (
            <span className="ml-2 align-middle text-xs font-normal text-neutral-500">
              Hoopedorc v{runtimeHealth.version}
            </span>
          )}
        </h2>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {onRerunSetup && (
            <button
              onClick={onRerunSetup}
              className="flex-1 rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800 sm:flex-none"
            >
              Re-run setup wizard
            </button>
          )}
          <button
            onClick={check}
            disabled={loading}
            className="flex-1 rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50 sm:flex-none"
          >
            {loading ? "Checking…" : "Re-check"}
          </button>
        </div>
      </div>

      <p className="text-xs text-neutral-400">
        These external CLIs must be authenticated before the orchestrator can
        spend money or touch GitHub. See{" "}
        <a
          href="https://github.com/IngeniousArtist/hoopedorc/blob/main/docs/USER_GUIDE.md"
          target="_blank"
          rel="noreferrer"
          className="text-blue-400 hover:underline"
        >
          the User Guide ↗
        </a>{" "}
        for install steps, a first-project walkthrough, and troubleshooting.
      </p>

      {loading && !runtimeHealth ? (
        <div
          className="h-16 animate-pulse rounded-lg border border-neutral-800 bg-neutral-900"
          aria-label="Loading runtime status"
        />
      ) : runtimeHealth ? (
        <div
          className={
            "rounded-lg border px-4 py-3 " +
            (runtimeHealth.ok
              ? "border-green-800 bg-green-950/30"
              : "border-amber-800 bg-amber-950/30")
          }
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p
              className={
                "text-sm font-medium " +
                (runtimeHealth.ok ? "text-green-300" : "text-amber-300")
              }
            >
              {runtimeHealth.state === "running"
                ? runtimeHealth.degraded.length > 0
                  ? "Runtime degraded"
                  : "Runtime healthy"
                : `Runtime ${runtimeHealth.state.replace("_", " ")}`}
            </p>
            <span className="text-xs text-neutral-300">
              Docker: {runtimeHealth.dependencies.docker.available ? "available" : "unavailable"}
              {runtimeHealth.dependencies.docker.required ? " · required" : " · optional"}
            </span>
            <span className="text-xs text-neutral-300">
              Telegram: {runtimeHealth.dependencies.telegram.state.replace("_", " ")}
            </span>
          </div>
          <p className="mt-1 text-xs text-neutral-300">
            {runtimeHealth.dependencies.docker.detail}
          </p>
          {runtimeHealth.degraded.map((detail) => (
            <p key={detail} className="mt-1 text-xs text-amber-200">
              {detail}
            </p>
          ))}
        </div>
      ) : null}

      {error && <div className="text-sm text-red-400">Error: {error}</div>}

      {health && (
        <>
          <div
            className={
              "rounded-lg border px-4 py-2 text-sm " +
              (health.allOk
                ? "border-green-800 bg-green-950/30 text-green-300"
                : "border-amber-800 bg-amber-950/30 text-amber-300")
            }
          >
            {health.allOk
              ? "All systems go — ready to run."
              : "Some checks failed — fix before starting a run."}
          </div>

          <div className="divide-y divide-neutral-800 rounded-lg border border-neutral-800 bg-neutral-900">
            {health.checks.map((c) => (
              <div key={c.name} className="flex items-start gap-3 px-4 py-3">
                <span
                  className={
                    "mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full " +
                    (c.ok ? "bg-green-500" : "bg-red-500")
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-neutral-200">{c.name}</div>
                  <div className="mt-0.5 break-words font-mono text-[11px] text-neutral-400">
                    {c.detail}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Live model test */}
      <div className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-medium text-neutral-300">
              Test each model
            </h3>
            <p className="text-[11px] text-neutral-400">
              Asks every enabled model to say hello and name itself. Costs a
              few cents.
            </p>
            <p className="mt-0.5 text-[10px] text-neutral-600">
              Models self-identify approximately — some report a family or an
              older base-model name rather than the exact marketing name. The
              cost/latency next to the reply is the real signal that the
              wiring reached a live model; an exact name match isn't promised.
            </p>
          </div>
          <button
            onClick={testAllModels}
            disabled={testing}
            className="w-full rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 sm:w-auto"
          >
            {testing ? "Testing… (up to a minute)" : "Test models"}
          </button>
        </div>

        {modelTest && (
          <>
            <div className="text-[11px] text-neutral-400">
              Total cost ${modelTest.totalCostUsd.toFixed(4)}
            </div>
            <div className="divide-y divide-neutral-800 rounded border border-neutral-800">
              {modelTest.results.map((r) => (
                <div key={r.id} className="flex items-start gap-3 px-3 py-2">
                  <span
                    className={
                      "mt-1 h-2 w-2 shrink-0 rounded-full " +
                      (r.ok ? "bg-green-500" : "bg-red-500")
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-neutral-200">{r.displayName}</div>
                    {r.ok ? (
                      <div className="mt-0.5 break-words text-sm text-neutral-100">
                        “{r.reply || "(empty reply)"}”
                      </div>
                    ) : (
                      <div className="mt-0.5 break-words font-mono text-[11px] text-red-400">
                        error: {r.error}
                      </div>
                    )}
                    <div className="mt-1 font-mono text-[10px] text-neutral-500">
                      effort {r.effort} · {(r.ms / 1000).toFixed(1)}s · ${r.costUsd.toFixed(4)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Model health (F6) */}
      <div className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-medium text-neutral-300">
              Model Health
            </h3>
            <p className="text-[11px] text-neutral-400">
              Reliability across every run ever recorded — for juggling
              several model subscriptions at once.
            </p>
          </div>
          <button
            onClick={fetchModelHealth}
            disabled={healthLoading}
            className="w-full rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-50 sm:w-auto"
          >
            {healthLoading ? "…" : "Refresh"}
          </button>
        </div>

        {modelHealth && modelHealth.models.length > 0 && (
          <div className="divide-y divide-neutral-800 rounded border border-neutral-800">
            {modelHealth.models.map((m) => {
              const failureRate =
                m.totalRuns > 0
                  ? Math.round((m.failedRuns / m.totalRuns) * 100)
                  : null;
              return (
                <div key={m.id} className="space-y-1 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={
                        "text-xs font-medium " +
                        (m.enabled ? "text-neutral-200" : "text-neutral-500")
                      }
                    >
                      {m.displayName}
                      {!m.enabled && " (disabled)"}
                    </span>
                    {m.coolingDownUntil && (
                      <span className="rounded bg-amber-900/50 px-1.5 py-0.5 text-[10px] text-amber-300">
                        cooling down
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-neutral-400">
                    <span>effort: {m.effort}</span>
                    {m.lastCheck ? (
                      <span className={m.lastCheck.ok ? "text-green-400" : "text-red-400"}>
                        last check {m.lastCheck.ok ? "✓" : "✗"} · {timeAgo(m.lastCheck.ts)}
                      </span>
                    ) : (
                      <span>never tested</span>
                    )}
                    <span>
                      {m.totalRuns} call{m.totalRuns === 1 ? "" : "s"}
                      {failureRate !== null && ` · ${failureRate}% failed`}
                    </span>
                    {m.medianDurationMs != null && (
                      <span>median {fmtDuration(m.medianDurationMs)}</span>
                    )}
                    {m.windowUsage && (
                      <span
                        className={
                          (m.windowUsage.maxRuns != null &&
                            m.windowUsage.runs >= m.windowUsage.maxRuns) ||
                          (m.windowUsage.maxCostUsd != null &&
                            m.windowUsage.costUsd >= m.windowUsage.maxCostUsd)
                            ? "text-amber-400"
                            : undefined
                        }
                      >
                        quota: {m.windowUsage.runs}
                        {m.windowUsage.maxRuns != null && `/${m.windowUsage.maxRuns}`} calls
                        {(m.windowUsage.maxCostUsd != null || m.windowUsage.costUsd > 0) &&
                          `, $${m.windowUsage.costUsd.toFixed(2)}${
                            m.windowUsage.maxCostUsd != null
                              ? `/$${m.windowUsage.maxCostUsd.toFixed(2)}`
                              : ""
                          }`}{" "}
                        in the last {m.windowUsage.windowHours}h
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
