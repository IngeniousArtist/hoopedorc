import { expect, test } from "@playwright/test";
import { expectFixedSurfacesInsideViewport, expectNoDocumentOverflow, expectPhoneTouchTargets, TARGET_VIEWPORTS } from "./helpers";

test("VW08: inspect workspace code at five widths and preserve the planning composer on handoff", async ({ page }) => {
  const created = await page.request.post("/api/projects", { data: { name: "VW08 inspection", repoUrl: "https://github.com/example/vw08" } });
  expect(created.status()).toBe(201);
  const { project } = await created.json();
  try {
    await page.goto(`/#/p/${project.id}/plan`);
    await page.getByLabel("Planning message").fill("Keep this unsent idea.");
    await page.getByRole("button", { name: "Workspaces", exact: true }).click();
    await page.getByRole("button", { name: "src/App.tsx", exact: true }).click();
    await expect(page.getByLabel("File contents")).toContainText("Hello from your workspace");
    for (const viewport of TARGET_VIEWPORTS) {
      await page.setViewportSize(viewport);
      await expectNoDocumentOverflow(page); await expectFixedSurfacesInsideViewport(page);
      if (viewport.width < 640) await expectPhoneTouchTargets(page);
      await page.screenshot({ path: `/tmp/vw08-${viewport.width}.png`, fullPage: true });
    }
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await expect(page.getByLabel("File changes")).toContainText("+Hello");
    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.getByLabel("To line").fill("3");
    await page.getByRole("button", { name: "Add lines to plan" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Planning message")).toHaveValue(/Keep this unsent idea\.[\s\S]*Workspace reference:[\s\S]*Hello from your workspace/);
    expect(await page.getByRole("button", { name: "Send", exact: true }).isEnabled()).toBe(true);
  } finally {
    expect((await page.request.delete(`/api/projects/${project.id}`)).status()).toBe(204);
  }
});
