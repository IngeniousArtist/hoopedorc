import { expect, test } from "@playwright/test";
import { expectFixedSurfacesInsideViewport, expectNoDocumentOverflow, expectPhoneTouchTargets, TARGET_VIEWPORTS } from "./helpers";

test("VW14: execution profile draft, save, mock refusal and confirmation work at five widths", async ({ page }) => {
  const previous = await (await page.request.get("/api/settings")).json();
  try {
    await page.goto("/"); await page.getByRole("button", { name: "Settings", exact: true }).click(); await page.getByRole("tab", { name: "Resources", exact: true }).click();
    await page.getByRole("button", { name: "Add account pool" }).click(); await page.getByLabel("Account 1 name").fill("Worker subscription");
    await page.getByRole("button", { name: "Add Docker profile" }).click(); await page.getByLabel("Worker 1 name").fill("My isolated worker"); await page.getByLabel("Worker 1 image").fill(`sha256:${"a".repeat(64)}`);
    await expect(page.getByRole("button", { name: "Verify worker" })).toBeDisabled();
    for (const viewport of TARGET_VIEWPORTS) {
      await page.setViewportSize(viewport); await page.getByRole("heading", { name: "Where agents run" }).scrollIntoViewIfNeeded();
      await expectNoDocumentOverflow(page); await expectFixedSurfacesInsideViewport(page); if (viewport.width < 640) await expectPhoneTouchTargets(page);
      await page.screenshot({ path: `/tmp/vw14-${viewport.width}.png`, fullPage: true });
    }
    await page.getByRole("button", { name: "Save Settings", exact: true }).focus(); await page.keyboard.press("Enter"); await expect(page.getByText("Settings saved.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Verify worker" })).toBeEnabled();
    await page.getByRole("button", { name: "Verify worker" }).click(); await expect(page.getByRole("alert").filter({ hasText: "mock mode" })).toBeVisible();
    await expect(page.getByLabel("Worker 1 name")).toHaveValue("My isolated worker");
    await page.getByRole("button", { name: "Remove execution profile" }).click(); await expect(page.getByRole("group", { name: "Confirm execution profile removal" })).toBeVisible(); await page.getByRole("button", { name: "Cancel", exact: true }).click(); await expect(page.getByLabel("Worker 1 name")).toHaveValue("My isolated worker");
    const saved = await (await page.request.get("/api/execution")).json(); expect(saved.profiles[0].state).toBe("unavailable"); expect(saved.workers).toEqual([]); expect(saved.host.filesystemIsolated).toBe(false);
  } finally { await page.request.put("/api/settings", { data: previous }); }
});
