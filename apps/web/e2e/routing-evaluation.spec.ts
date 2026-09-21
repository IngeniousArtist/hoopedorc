import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { GetSettingsResponse, RoutingEvaluationsResponse } from "@orc/types";
import { expectFixedSurfacesInsideViewport, expectNoDocumentOverflow, expectPhoneTouchTargets, TARGET_VIEWPORTS } from "./helpers";

test("VW18: inspect a synthetic comparison, recover failures and reopen immutable evidence without changing routing", async ({ page }) => {
  const before = await (await page.request.get("/api/settings")).json() as GetSettingsResponse;
  await page.goto("/"); await page.getByRole("button", { name: "Settings", exact: true }).click(); await page.getByRole("tab", { name: "Routing evaluation", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save Settings", exact: true })).not.toBeVisible();
  const input = page.getByLabel("Recorded routing dataset"); await input.fill("invalid JSON"); await page.getByRole("button", { name: "Evaluate and save report" }).click(); await expect(page.getByRole("alert")).toContainText("valid JSON");
  const draftDownload = page.waitForEvent("download"); await page.getByRole("button", { name: "Download input", exact: true }).click(); expect(await readFile((await (await draftDownload).path())!, "utf8")).toBe("invalid JSON");
  await page.getByRole("button", { name: "Load synthetic example" }).click(); await page.getByRole("button", { name: "Replace draft", exact: true }).focus(); await page.keyboard.press("Enter");
  let fail = true;
  await page.route("**/api/routing/evaluations", (route) => route.request().method() === "POST" && fail ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Evaluation temporarily unavailable" }) }) : route.continue());
  await page.getByRole("button", { name: "Evaluate and save report" }).click(); await expect(page.getByRole("alert")).toContainText("temporarily unavailable"); await expect(input).toHaveValue(/Synthetic routing example/);
  fail = false; await page.getByRole("button", { name: "Evaluate and save report" }).click(); await expect(page.getByRole("heading", { name: "More evidence needed" })).toBeVisible();
  const history = await (await page.request.get("/api/routing/evaluations")).json() as RoutingEvaluationsResponse; const id = history.evaluations[0]!.id;
  await page.getByText("Allocation and fallback details", { exact: true }).click();
  for (const viewport of TARGET_VIEWPORTS) { await page.setViewportSize(viewport); await page.evaluate(() => window.scrollTo(0, 0)); await expectNoDocumentOverflow(page); await expectFixedSurfacesInsideViewport(page); if (viewport.width < 640) await expectPhoneTouchTargets(page); await page.screenshot({ path: `/tmp/vw18-${viewport.width}.png`, fullPage: false }); }
  await page.getByRole("heading", { name: "More evidence needed" }).scrollIntoViewIfNeeded(); await page.screenshot({ path: "/tmp/vw18-report-1440.png" });
  const downloadPromise = page.waitForEvent("download"); await page.getByRole("button", { name: "Download report", exact: true }).click(); expect((await downloadPromise).suggestedFilename()).toBe(`routing-evaluation-${id}.json`);
  await page.reload(); await page.getByRole("tab", { name: "Routing evaluation", exact: true }).click(); await expect(input).toHaveValue(/Synthetic routing example/);
  await page.getByRole("button", { name: /Synthetic routing example · synthetic/ }).first().click(); await expect(page.getByRole("heading", { name: "More evidence needed" })).toBeVisible();
  await page.getByRole("button", { name: "Evaluate and save report" }).click(); await expect(page.getByRole("button", { name: "Evaluate and save report" })).toBeEnabled();
  const after = await (await page.request.get("/api/routing/evaluations")).json() as RoutingEvaluationsResponse; expect(after.evaluations.filter((item) => item.id === id)).toHaveLength(1); expect(after.evaluations).toHaveLength(history.evaluations.length);
  expect(await (await page.request.get("/api/settings")).json()).toEqual(before);
});
