import type { ServerEvent } from "@orc/types";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { projectFixture } from "../test/fixtures";
import { AuditView } from "./AuditView";

const wsState = vi.hoisted(() => ({
  handler: undefined as ((event: ServerEvent) => void) | undefined,
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("../hooks/useWS", () => ({
  useWS: (_projectId: string, handler: (event: ServerEvent) => void) => {
    wsState.handler = handler;
  },
}));

const apiMock = vi.mocked(api);

describe("AuditView reconnect catch-up", () => {
  beforeEach(() => {
    apiMock.mockReset();
    wsState.handler = undefined;
  });

  it("refreshes REST-only audit state without accepting the older read", async () => {
    let resolveInitial!: (value: { entries: [] }) => void;
    const initialRead = new Promise<{ entries: [] }>((resolve) => {
      resolveInitial = resolve;
    });
    const restoredEntry = {
      id: "audit-restored-after-reconnect",
      projectId: projectFixture.id,
      ts: "2026-08-17T00:00:00.000Z",
      kind: "stopped",
      actor: "engine",
      summary: "Shutdown completed while the browser was offline",
    };
    apiMock
      .mockReturnValueOnce(initialRead)
      .mockResolvedValue({ entries: [restoredEntry] });
    render(<AuditView projectId={projectFixture.id} />);
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));

    act(() => {
      wsState.handler?.({
        type: "projects.snapshot",
        payload: { projects: [projectFixture] },
      });
    });
    expect(apiMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInitial({ entries: [] });
      await initialRead;
    });

    expect(
      await screen.findByText(
        "Shutdown completed while the browser was offline",
      ),
    ).toBeVisible();
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(apiMock).toHaveBeenLastCalledWith("auditLog", {
      params: { id: projectFixture.id },
      signal: expect.any(AbortSignal),
    });
  });

  it("coalesces a live burst into one in-flight fetch and one trailing fetch", async () => {
    let resolveFirst!: (value: { entries: [] }) => void;
    const first = new Promise<{ entries: [] }>((resolve) => {
      resolveFirst = resolve;
    });
    const trailingEntry = {
      id: "audit-trailing-after-burst",
      projectId: projectFixture.id,
      ts: "2026-08-17T00:00:00.000Z",
      kind: "stopped",
      actor: "engine",
      summary: "Final audit row after the burst",
    };
    let calls = 0;
    apiMock.mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? first : { entries: [trailingEntry] };
    });

    render(<AuditView projectId={projectFixture.id} />);
    await waitFor(() => expect(calls).toBe(1));
    act(() => {
      for (let i = 0; i < 6; i += 1) {
        wsState.handler?.({
          type: "task.updated",
          payload: { id: `task-${i}` } as never,
        });
      }
    });
    expect(calls).toBe(1);

    await act(async () => {
      resolveFirst({ entries: [] });
      await first;
    });

    expect(
      await screen.findByText("Final audit row after the burst"),
    ).toBeVisible();
    expect(calls).toBe(2);
  });
});
