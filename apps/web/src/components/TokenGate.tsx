import { useState } from "react";
import { apiUrl } from "../api/client";

/**
 * S6: replaces the old blocking browser-prompt stopgap. Rendered by App.tsx
 * only after a real 401 (never on auth-off, the default). Validates the entered
 * token itself — via a raw `fetch`, not `api()`, to avoid recursing back
 * into the unauthorized-handler — before calling `onAuthenticated`, so by
 * the time `client.ts`'s single retry runs, the token is already known-good.
 */
export function TokenGate({
  onAuthenticated,
}: {
  onAuthenticated: (token: string) => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function submit() {
    const candidate = value.trim();
    if (!candidate || checking) return;
    setChecking(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("getSettings"), {
        headers: { Authorization: `Bearer ${candidate}` },
      });
      if (res.ok) {
        onAuthenticated(candidate);
      } else if (res.status === 401) {
        setError("Incorrect token.");
      } else {
        setError(`Unexpected server response (${res.status}).`);
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/80 p-4">
      <div className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-6">
        <h2 className="text-sm font-semibold text-neutral-100">
          Hoopedorc requires a token
        </h2>
        <p className="mt-1 text-xs text-neutral-400">
          This server is configured with an API token. Enter it to continue.
        </p>
        <label htmlFor="api-token-gate" className="mt-4 block text-xs text-neutral-300">
          API token
        </label>
        <input
          id="api-token-gate"
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="API token"
          className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200"
        />
        {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
        <button
          onClick={submit}
          disabled={!value.trim() || checking}
          className="mt-4 w-full rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {checking ? "Checking…" : "Continue"}
        </button>
      </div>
    </div>
  );
}
