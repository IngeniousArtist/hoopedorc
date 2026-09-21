import { expect, test } from "@playwright/test";
import { expectFixedSurfacesInsideViewport, expectNoDocumentOverflow, expectPhoneTouchTargets, TARGET_VIEWPORTS } from "./helpers";

test("VW11: versioned project sources and draft-safe plan handoff at five widths", async ({ page }) => {
  const created = await page.request.post("/api/projects", { data: { name: "VW11 library", repoUrl: "https://github.com/example/vw11" } });
  expect(created.status()).toBe(201); const { project } = await created.json();
  try {
    await page.goto(`/#/p/${project.id}/plan`);
    await page.getByLabel("Planning message").fill("Keep this plan note.");
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await expect(page.getByText(/No references yet/)).toBeVisible();
    await page.getByRole("button", { name: "Import existing sources" }).click();
    await expect(page.getByText("Imported 1 revisions; 0 unchanged.")).toBeVisible();
    await page.getByRole("button", { name: "New reference" }).click();
    await page.getByLabel("Reference title").fill("Product rules");
    await page.getByLabel("Reference kind").selectOption("rules");
    await page.getByLabel("When should this apply?").fill("All product UI");
    await page.getByLabel("Reference text").fill("Use existing components and explain unavailable actions.");
    await page.getByRole("button", { name: "Save reference" }).click();
    await expect(page.getByRole("heading", { name: "Product rules", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit reference", exact: true }).click();
    await page.getByLabel("Reference text").fill("Use existing components and keep keyboard focus visible.");
    await page.getByRole("button", { name: "Save reference" }).click();
    await page.getByRole("button", { name: "View Product rules" }).click();
    await page.getByText("Version history", { exact: true }).click();
    await expect(page.getByText("Use existing components and explain unavailable actions.", { exact: true })).toBeVisible();
    await page.getByLabel("Select Product rules").check();
    for (const viewport of TARGET_VIEWPORTS) {
      await page.setViewportSize(viewport); await page.evaluate(() => window.scrollTo(0, 0));
      await expectNoDocumentOverflow(page); await expectFixedSurfacesInsideViewport(page);
      if (viewport.width < 640) await expectPhoneTouchTargets(page);
      await page.screenshot({ path: `/tmp/vw11-${viewport.width}.png`, fullPage: true });
    }
    await page.getByRole("button", { name: "Add selected to plan" }).focus(); await page.keyboard.press("Enter");
    await expect(page.getByLabel("Planning message")).toContainText("Keep this plan note.");
    await expect(page.getByLabel("Planning message")).toContainText("hoop-reference:");
    await expect(page.getByLabel("Planning message")).toContainText("keep keyboard focus visible");
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await page.getByRole("button", { name: "View Product rules" }).click();
    await page.getByRole("button", { name: "Archive reference" }).click();
    await page.getByRole("button", { name: "Confirm archive" }).click();
    await expect(page.getByLabel("Select Product rules")).toBeDisabled();
    await page.getByRole("button", { name: "New reference" }).click();
    await page.getByLabel("Reference title").fill("Unsent library draft");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await expect(page.getByLabel("Reference title")).toHaveValue("Unsent library draft");
  } finally { await page.request.delete(`/api/projects/${project.id}`); }
});
