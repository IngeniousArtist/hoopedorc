import type {
  ModelCatalogEntry,
  ModelCatalogResponse,
  RunnerModelCatalog,
} from "@orc/types";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

function fallbackCopy(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

function matchesQuery(
  model: ModelCatalogEntry,
  catalog: RunnerModelCatalog,
  query: string,
): boolean {
  if (!query) return true;
  return [
    model.slug,
    model.displayName,
    model.description,
    model.provider,
    catalog.label,
  ].some((value) => value?.toLowerCase().includes(query));
}

export function ModelCatalogView() {
  const [catalog, setCatalog] = useState<ModelCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCatalog(await api<ModelCatalogResponse>("modelCatalog"));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function copySlug(slug: string) {
    setCopyError(null);
    try {
      let copied = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(slug);
          copied = true;
        } catch {
          // Plain HTTP and locked-down browsers may expose the API but reject
          // permission. Fall through to the selection-based copy command.
        }
      }
      if (!copied) copied = fallbackCopy(slug);
      if (!copied) {
        throw new Error("Browser copy command was rejected");
      }
      setCopiedSlug(slug);
    } catch {
      setCopiedSlug(null);
      setCopyError("Could not copy automatically. Select the slug and copy it manually.");
    }
  }

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = catalog?.catalogs.flatMap((runner) => {
    const models = runner.models.filter((model) =>
      matchesQuery(model, runner, normalizedQuery),
    );
    return normalizedQuery && models.length === 0 ? [] : [{ ...runner, models }];
  });
  const matchCount =
    filtered?.reduce((total, runner) => total + runner.models.length, 0) ?? 0;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold">Model Slugs</h2>
          <p className="mt-1 text-sm text-neutral-300">
            Exact values for Claude Code, Codex, and the Z.AI, xAI, and
            DeepSeek providers in OpenCode.
          </p>
          <p className="mt-1 text-xs text-neutral-400">
            Availability still depends on the subscriptions and credentials
            configured on this machine.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          aria-busy={loading}
          className="min-h-10 w-full rounded border border-neutral-700 px-3 py-2 text-xs text-neutral-200 transition-colors hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 sm:w-auto"
        >
          {loading && catalog ? "Refreshing…" : "Refresh catalog"}
        </button>
      </div>

      <div>
        <label
          htmlFor="model-catalog-search"
          className="mb-1 block text-xs font-medium text-neutral-300"
        >
          Filter models
        </label>
        <input
          id="model-catalog-search"
          type="search"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search a slug, provider, or runner"
          className="min-h-10 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus-visible:ring-2 focus-visible:ring-blue-500"
        />
      </div>

      {copyError && (
        <div
          role="alert"
          className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-300"
        >
          {copyError}
        </div>
      )}

      {error && !catalog ? (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-red-800 bg-red-950/30 p-4"
        >
          <div>
            <p className="text-sm font-medium text-red-300">
              Could not load the model catalog
            </p>
            <p className="mt-1 break-words text-xs text-red-200">{error}</p>
          </div>
          <button
            type="button"
            onClick={load}
            className="min-h-10 rounded border border-red-700 px-3 py-2 text-xs font-medium text-red-200 hover:bg-red-900/40 focus-visible:ring-2 focus-visible:ring-red-400"
          >
            Try again
          </button>
        </div>
      ) : loading && !catalog ? (
        <div aria-label="Loading model catalog" className="space-y-4">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="h-40 animate-pulse rounded-lg border border-neutral-800 bg-neutral-900 motion-reduce:animate-none"
            />
          ))}
        </div>
      ) : filtered ? (
        <>
          {normalizedQuery && matchCount === 0 && (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6 text-center">
              <p className="text-sm font-medium text-neutral-200">
                No matching model slugs
              </p>
              <p className="mt-1 text-xs text-neutral-400">
                Clear the filter to view the complete catalog.
              </p>
              <button
                type="button"
                onClick={() => setQuery("")}
                className="mt-3 min-h-10 rounded border border-neutral-700 px-3 py-2 text-xs text-neutral-200 hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                Clear filter
              </button>
            </div>
          )}

          <div className="space-y-4">
            {filtered.map((runner) => (
              <section
                key={runner.runner}
                className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900"
              >
                <div className="border-b border-neutral-800 px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-semibold text-neutral-100">
                      {runner.label}
                    </h3>
                    <span className="text-xs text-neutral-400">
                      {runner.models.length} model
                      {runner.models.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p className="mt-1 break-words font-mono text-xs text-neutral-400">
                    {runner.source}
                  </p>
                  {runner.error && (
                    <p className="mt-2 rounded border border-amber-800 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                      Catalog probe failed: {runner.error}
                    </p>
                  )}
                </div>

                {runner.models.length > 0 ? (
                  <div className="divide-y divide-neutral-800">
                    {runner.models.map((model) => (
                      <div
                        key={model.slug}
                        className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium text-neutral-100">
                              {model.displayName}
                            </p>
                            {model.kind === "alias" && (
                              <span className="rounded border border-blue-800 bg-blue-950/40 px-1.5 py-0.5 text-xs text-blue-200">
                                alias
                              </span>
                            )}
                            {model.provider && (
                              <span className="rounded border border-neutral-700 px-1.5 py-0.5 text-xs text-neutral-300">
                                {model.provider}
                              </span>
                            )}
                          </div>
                          {model.description && (
                            <p className="mt-1 text-xs text-neutral-400">
                              {model.description}
                            </p>
                          )}
                          {model.reasoningEfforts?.length ? (
                            <p className="mt-1 text-xs text-neutral-400">
                              Effort: {model.reasoningEfforts.join(", ")}
                            </p>
                          ) : null}
                          <code className="mt-2 block select-all break-all rounded bg-neutral-950 px-2 py-1.5 font-mono text-sm text-emerald-300">
                            {model.slug}
                          </code>
                        </div>
                        <button
                          type="button"
                          onClick={() => copySlug(model.slug)}
                          aria-label={`Copy ${model.slug}`}
                          className="min-h-10 w-full shrink-0 rounded border border-neutral-700 px-3 py-2 text-xs font-medium text-neutral-200 transition-colors hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-blue-500 sm:w-24"
                        >
                          {copiedSlug === model.slug ? "Copied" : "Copy"}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : !normalizedQuery ? (
                  <div className="px-4 py-6 text-center">
                    <p className="text-sm font-medium text-neutral-200">
                      No models reported
                    </p>
                    <p className="mt-1 text-xs text-neutral-400">
                      Install and authenticate this CLI, then refresh the catalog.
                    </p>
                  </div>
                ) : null}
              </section>
            ))}
          </div>

          {catalog?.generatedAt && (
            <p className="text-xs text-neutral-500">
              Catalog generated {new Date(catalog.generatedAt).toLocaleString()}.
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}
