import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { ModelCatalogView } from "./ModelCatalogView";

vi.mock("../api/client", () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

describe("ModelCatalogView", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockResolvedValue({
      generatedAt: "2026-07-16T08:00:00.000Z",
      catalogs: [
        {
          runner: "codex",
          label: "Codex",
          source: "codex debug models --bundled",
          models: [
            {
              slug: "gpt-5.6-sol",
              displayName: "GPT-5.6-Sol",
              kind: "model",
              reasoningEfforts: ["low", "high"],
            },
          ],
        },
        {
          runner: "claude-code",
          label: "Claude Code",
          source: "documented aliases",
          models: [
            {
              slug: "sonnet",
              displayName: "Sonnet (latest alias)",
              kind: "alias",
            },
          ],
        },
        {
          runner: "opencode",
          label: "OpenCode",
          source: "opencode models",
          models: [
            {
              slug: "xai/grok-4.5",
              displayName: "grok-4.5",
              provider: "xai",
              kind: "model",
            },
          ],
        },
      ],
    });
  });

  it("shows all runner slugs, filters them, and copies an exact value", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<ModelCatalogView />);

    expect(await screen.findByText("gpt-5.6-sol")).toBeVisible();
    expect(screen.getByText("sonnet")).toBeVisible();
    expect(screen.getByText("xai/grok-4.5")).toBeVisible();

    await user.type(screen.getByLabelText("Filter models"), "grok");
    expect(screen.queryByText("gpt-5.6-sol")).not.toBeInTheDocument();
    expect(screen.getByText("xai/grok-4.5")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Copy xai/grok-4.5" }));
    expect(writeText).toHaveBeenCalledWith("xai/grok-4.5");
    expect(screen.getByRole("button", { name: "Copy xai/grok-4.5" })).toHaveTextContent(
      "Copied",
    );
  });

  it("falls back to the browser copy command when clipboard permission is denied", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    });
    render(<ModelCatalogView />);

    await user.click(
      await screen.findByRole("button", { name: "Copy xai/grok-4.5" }),
    );

    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(screen.getByRole("button", { name: "Copy xai/grok-4.5" })).toHaveTextContent(
      "Copied",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
