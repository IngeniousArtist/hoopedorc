import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { HarnessCompatibilityPanel } from "./HarnessCompatibilityPanel";
import { api } from "../api/client";
vi.mock("../api/client", () => ({ api: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
it("VW17: shows loading, actionable failure, empty data and capability limits without model calls", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(api).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  render(<HarnessCompatibilityPanel />);
  expect(screen.getByRole("button", { name: "Checking versions…" })).toBeDisabled(); expect(screen.getByRole("status")).toBeVisible();
  reject(new Error("Server unavailable")); expect(await screen.findByRole("alert")).toHaveTextContent("Server unavailable");
  vi.mocked(api).mockResolvedValueOnce({ generatedAt: "now", harnesses: [] }); fireEvent.click(screen.getByRole("button", { name: "Refresh versions" })); expect(await screen.findByText(/No compatibility information/)).toBeVisible();
  vi.mocked(api).mockResolvedValueOnce({ generatedAt: "now", harnesses: [{ runner: "gemini", label: "Gemini CLI", installedVersion: "0.60.0", verifiedVersion: "0.60.0", probe: "available", native: true, selective: false, isolated: false, plugins: false, detail: "Native only; inherited configuration.", providerAcceptance: "operator-check-required" }] });
  fireEvent.click(screen.getByRole("button", { name: "Refresh versions" })); expect(await screen.findByText("Installed 0.60.0")).toBeVisible(); expect(screen.getByText("Model test required")).toBeVisible();
  await waitFor(() => expect(api).toHaveBeenCalledTimes(3)); expect(vi.mocked(api).mock.calls.every(([key]) => key === "harnessCompatibility")).toBe(true);
});
