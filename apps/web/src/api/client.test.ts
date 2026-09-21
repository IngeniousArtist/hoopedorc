import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiRequestError,
  api,
  apiBlob,
  apiMethod,
  apiUrl,
  isAbortError,
  setUnauthorizedHandler,
} from "./client";

afterEach(() => {
  setUnauthorizedHandler(null);
});

describe("API route contract", () => {
  it("retries an authenticated artifact download through the shared token gate", async () => {
    localStorage.removeItem("hoopedorc.apiToken");
    const fetchMock = vi.fn<typeof fetch>(async (_input, options) => (options?.headers as Record<string, string>)?.Authorization === "Bearer artifact-token"
      ? new Response("artifact bytes", { headers: { "Content-Type": "text/plain" } }) : new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock); setUnauthorizedHandler(async () => "artifact-token");
    const blob = await apiBlob("reviewArtifact", { params: { id: "p", taskId: "t", artifactId: "a" } });
    expect(await blob.text()).toBe("artifact bytes"); expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/projects/p/tasks/t/review/artifacts/a");
  });
  it("encodes workspace file paths as query data, keeping auth and route identity", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ content: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await api("workspaceFile", { params: { id: "p", workspaceId: "primary" }, query: { path: "src/name with &?#.ts" } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/projects/p/workspaces/primary/file?path=src%2Fname+with+%26%3F%23.ts");
  });
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

  it("recognizes abort errors without treating other failures as aborted", () => {
    expect(isAbortError(new DOMException("The operation was aborted.", "AbortError"))).toBe(
      true,
    );
    expect(isAbortError(Object.assign(new Error("Aborted"), { name: "AbortError" }))).toBe(
      true,
    );
    expect(isAbortError(new Error("network down"))).toBe(false);
  });
});
