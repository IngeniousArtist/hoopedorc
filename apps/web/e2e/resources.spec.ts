import { expect, test } from "@playwright/test";
import { expectFixedSurfacesInsideViewport, expectNoDocumentOverflow, expectPhoneTouchTargets, TARGET_VIEWPORTS } from "./helpers";

test("VW13: resource settings save, preserve cross-section edits and work at five widths", async ({ page }) => {
  const previous = await (await page.request.get("/api/settings")).json();
  try {
    await page.goto("/"); await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Resources", exact: true }).click();
    await page.getByRole("button", { name: "Add account pool" }).click();
    await page.getByLabel("Account 1 name").fill("Shared development account");
    const member = page.getByLabel(/account pool$/).first(); await member.selectOption({ label: "Shared development account" });
    await page.getByLabel("Account 1 call limit").fill("20");
    for (const viewport of TARGET_VIEWPORTS) {
      await page.setViewportSize(viewport); await page.evaluate(() => window.scrollTo(0, 0));
      await expectNoDocumentOverflow(page); await expectFixedSurfacesInsideViewport(page);
      if (viewport.width < 640) await expectPhoneTouchTargets(page);
      await page.screenshot({ path: `/tmp/vw13-${viewport.width}.png`, fullPage: true });
    }
    await page.getByRole("tab", { name: "Guidelines", exact: true }).click();
    await page.getByRole("tab", { name: "Resources", exact: true }).click();
    await expect(page.getByLabel("Account 1 name")).toHaveValue("Shared development account");
    await page.getByRole("button", { name: "Save Settings", exact: true }).focus(); await page.keyboard.press("Enter");
    await expect(page.getByText("Settings saved.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Refresh usage" }).click();
    await expect(page.getByLabel("Account 1 saved usage")).toContainText("0 active");
    const saved = await (await page.request.get("/api/resources")).json(); expect(saved.pools).toHaveLength(1); expect(saved.pools[0].models).toHaveLength(1);
  } finally { await page.request.put("/api/settings", { data: previous }); }
});
