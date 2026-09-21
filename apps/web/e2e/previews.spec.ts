import { expect, test } from "@playwright/test";
import { expectFixedSurfacesInsideViewport, expectNoDocumentOverflow, expectPhoneTouchTargets, TARGET_VIEWPORTS } from "./helpers";

test("VW09: configure, review, open and stop a preview at five widths", async ({ page }) => {
  const created = await page.request.post("/api/projects", { data: { name: "VW09 previews", repoUrl: "https://github.com/example/vw09" } });
  expect(created.status()).toBe(201);
  const { project } = await created.json();
  const { task } = await (await page.request.post(`/api/projects/${project.id}/tasks`, { data: { title: "Preview workspace" } })).json();
  const previewUrl = `/api/projects/${project.id}/workspaces/${task.id}/preview`;
  try {
    await page.goto(`/#/p/${project.id}/workspaces`);
    await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(task.id);
    const preview = page.getByRole("region", { name: "Workspace preview", exact: true });
    await preview.getByText("Preview command", { exact: true }).click();
    await preview.getByLabel("Command", { exact: true }).fill("mock-command-never-executed");
    await preview.getByRole("button", { name: "Save preview command" }).click();
    await expect(preview.getByText(/Preview command saved/)).toBeVisible();
    await preview.getByRole("button", { name: "Start preview", exact: true }).click();
    await expect(preview.getByRole("group", { name: "Confirm start preview" })).toContainText("mock-command-never-executed");
    await preview.getByRole("button", { name: "Confirm start" }).focus();
    await page.keyboard.press("Enter");
    await expect(preview.getByRole("button", { name: "Show preview here" })).toBeEnabled();
    for (const viewport of TARGET_VIEWPORTS) {
      await page.setViewportSize(viewport);
      await expectNoDocumentOverflow(page); await expectFixedSurfacesInsideViewport(page);
      if (viewport.width < 640) await expectPhoneTouchTargets(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `/tmp/vw09-${viewport.width}.png`, fullPage: true });
    }
    await preview.getByRole("button", { name: "Show preview here" }).click();
    await expect(page.frameLocator('iframe[title="Task workspace preview"]').getByRole("heading", { name: "Mock workspace preview" })).toBeVisible();
    await page.reload();
    await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(task.id);
    await expect(preview.getByRole("button", { name: "Show preview here" })).toBeEnabled();
    const popupPromise = page.waitForEvent("popup");
    await preview.getByRole("button", { name: "Open in new tab" }).click();
    const popup = await popupPromise;
    await expect(popup.getByRole("heading", { name: "Mock workspace preview" })).toBeVisible(); await popup.close();
    await preview.getByRole("button", { name: "Stop preview", exact: true }).click();
    await preview.getByRole("button", { name: "Confirm stop" }).click();
    await expect(preview.getByText("Preview stopped. Workspace files are preserved.")).toBeVisible();
  } finally {
    await page.request.post(`${previewUrl}/stop`);
    expect((await page.request.delete(`/api/projects/${project.id}`)).status()).toBe(204);
  }
});
