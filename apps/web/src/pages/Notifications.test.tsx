import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { notificationFixture, projectFixture } from "../test/fixtures";
import { Notifications } from "./Notifications";

vi.mock("../api/client", () => ({ api: vi.fn() }));
vi.mock("../hooks/useWS", () => ({ useWS: vi.fn() }));

const apiMock = vi.mocked(api);

describe("approval decisions", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation(async (key) => {
      if (key === "listNotifications") return { notifications: [notificationFixture] };
      if (key === "respondNotification") return undefined;
      throw new Error(`Unexpected API call: ${key}`);
    });
  });

  it("submits and reflects an approval", async () => {
    const user = userEvent.setup();
    render(<Notifications projectId={projectFixture.id} />);
    await user.click(await screen.findByRole("button", { name: "Approve" }));

    expect(apiMock).toHaveBeenCalledWith("respondNotification", {
      params: { id: notificationFixture.id },
      body: { choice: "approve" },
    });
    expect(await screen.findByText("Responded: approve")).toBeVisible();
  });

  it("keeps the decision available and surfaces a failed response", async () => {
    apiMock.mockImplementation(async (key) => {
      if (key === "listNotifications") return { notifications: [notificationFixture] };
      if (key === "respondNotification") throw new Error("Approval delivery failed");
      throw new Error(`Unexpected API call: ${key}`);
    });
    const user = userEvent.setup();
    render(<Notifications projectId={projectFixture.id} />);
    await user.click(await screen.findByRole("button", { name: "Approve" }));

    expect(await screen.findByText("Error: Error: Approval delivery failed")).toBeVisible();
  });
});
