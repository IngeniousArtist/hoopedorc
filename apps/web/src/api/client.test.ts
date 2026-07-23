import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiRequestError,
  api,
  apiMethod,
  apiUrl,
  setUnauthorizedHandler,
} from "./client";

afterEach(() => {
  setUnauthorizedHandler(null);
});

describe("API route contract", () => {
  it("maps settings and project actions to the canonical server routes", () => {
    expect(apiMethod("updateSettings")).toBe("PUT");
    expect(apiUrl("updateSettings")).toBe("/api/settings");
    expect(apiUrl("startProject", { id: "proj-1" })).toBe("/api/projects/proj-1/start");
    expect(apiUrl("respondNotification", { id: "notif-1" })).toBe(
      "/api/notifications/notif-1/respond",
    );
    expect(apiMethod("startSelfUpdate")).toBe("POST");
    expect(apiUrl("selfUpdateStatus")).toBe("/api/setup/self-update");
    expect(apiUrl("startSelfUpdate")).toBe("/api/setup/self-update");
  });

  it("opens one auth gate for concurrent 401 responses and retries every request", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.Authorization === "Bearer owner-token") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const auth = vi.fn(async () => "owner-token");
    setUnauthorizedHandler(auth);

    await expect(
      Promise.all([api<{ ok: boolean }>("listProjects"), api<{ ok: boolean }>("getSettings")]),
    ).resolves.toEqual([{ ok: true }, { ok: true }]);

    expect(auth).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(localStorage.getItem("hoopedorc.apiToken")).toBe("owner-token");
  });

  it("surfaces the server error from a failed request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "Settings could not be saved" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(api("updateSettings", { body: { settings: {} } })).rejects.toThrow(
      "Settings could not be saved",
    );
  });

  it("preserves typed error details for recoverable planning failures", async () => {
    const details = {
      issue: {
        stage: "deconstruction",
        code: "figma_auth_required",
        message: "Figma authentication is required.",
      },
      costUsd: 0.02,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: "Figma authentication is required.",
            code: "FIGMA_VERIFICATION_FAILED",
            details,
          }),
          {
            status: 409,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    const error = await api("planDeconstruct").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      status: 409,
      code: "FIGMA_VERIFICATION_FAILED",
      details,
    });
  });
});
