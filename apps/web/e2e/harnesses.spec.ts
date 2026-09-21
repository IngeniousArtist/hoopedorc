import { expect, test } from "@playwright/test";
import type { HarnessCompatibilityResponse, GetSettingsResponse } from "@orc/types";
import { expectFixedSurfacesInsideViewport, expectNoDocumentOverflow, expectPhoneTouchTargets, TARGET_VIEWPORTS } from "./helpers";

test("VW17: discover harness limits, recover a failed check and save an explicit Gemini profile", async ({ page }) => {
  const previous = await (await page.request.get("/api/settings")).json() as GetSettingsResponse;
  const compatibility = await (await page.request.get("/api/setup/harnesses")).json() as HarnessCompatibilityResponse;
  expect(compatibility.harnesses).toHaveLength(4); expect(compatibility.harnesses.every((entry) => entry.probe === "mock")).toBe(true);
  let fail = true;
  await page.route("**/api/setup/harnesses", (route) => fail ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Version discovery unavailable" }) }) : route.continue());
  try {
    await page.goto("/"); await page.getByRole("button", { name: "Setup", exact: true }).click(); await page.getByRole("tab", { name: "Harnesses", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Version discovery unavailable"); fail = false;
    const refresh = page.getByRole("button", { name: "Refresh versions" }); await refresh.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Gemini CLI", exact: true })).toBeVisible();
    for (const viewport of TARGET_VIEWPORTS) {
      await page.setViewportSize(viewport); await expectNoDocumentOverflow(page); await expectFixedSurfacesInsideViewport(page); if (viewport.width < 640) await expectPhoneTouchTargets(page);
      await page.screenshot({ path: `/tmp/vw17-${viewport.width}.png`, fullPage: true });
    }
    await page.getByRole("button", { name: "Settings", exact: true }).click(); await page.getByRole("tab", { name: "Models & routing", exact: true }).click();
    await page.getByRole("button", { name: "+ Add model" }).click(); await page.getByLabel("New model runner").selectOption("gemini");
    await page.getByLabel("New model Gemini model").fill("owned-model"); await expect(page.getByLabel("New model reasoning effort")).toBeDisabled();
    const card = page.getByLabel("New model Gemini model").locator("xpath=ancestor::div[contains(@class,'rounded')][1]"); await card.getByRole("checkbox", { name: "enabled", exact: true }).uncheck();
    await page.getByRole("button", { name: "Save Settings", exact: true }).click(); await expect(page.getByText("Settings saved.", { exact: true })).toBeVisible();
    const saved = await (await page.request.get("/api/settings")).json() as GetSettingsResponse; expect(saved.settings.models.at(-1)).toMatchObject({ runner: "gemini", geminiModel: "owned-model", enabled: false });
  } finally { await page.request.put("/api/settings", { data: previous }); }
});
