import type { SetupHealthResponse, TestModelsResponse } from "@orc/types";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

export function SetupView() {
  const [health, setHealth] = useState<SetupHealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelTest, setModelTest] = useState<TestModelsResponse | null>(null);
  const [testing, setTesting] = useState(false);

  const check = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHealth(await api<SetupHealthResponse>("setupHealth"));
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
    } catch (e) {
      setError(String(e));
    } finally {
      setTesting(false);
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Setup &amp; Health</h2>
        <button
          onClick={check}
          disabled={loading}
          className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
        >
          {loading ? "Checking…" : "Re-check"}
        </button>
      </div>

      <p className="text-xs text-neutral-500">
        These external CLIs must be authenticated before the orchestrator can
        spend money or touch GitHub.
      </p>

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
                  <div className="mt-0.5 break-words font-mono text-[11px] text-neutral-500">
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
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-neutral-300">
              Test each model
            </h3>
            <p className="text-[11px] text-neutral-500">
              Sends a one-word prompt to every enabled model. Costs a few cents.
            </p>
          </div>
          <button
            onClick={testAllModels}
            disabled={testing}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {testing ? "Testing… (up to a minute)" : "Test models"}
          </button>
        </div>

        {modelTest && (
          <>
            <div className="text-[11px] text-neutral-500">
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
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-neutral-200">{r.displayName}</span>
                      <span className="font-mono text-[11px] text-neutral-500">
                        {(r.ms / 1000).toFixed(1)}s · ${r.costUsd.toFixed(4)}
                      </span>
                    </div>
                    <div className="mt-0.5 break-words font-mono text-[11px] text-neutral-500">
                      {r.ok ? `reply: ${r.reply ?? "(empty)"}` : `error: ${r.error}`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
