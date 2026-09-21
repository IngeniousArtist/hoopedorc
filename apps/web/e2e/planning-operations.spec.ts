import { expect, test } from "@playwright/test";
import { expectFixedSurfacesInsideViewport, expectNoDocumentOverflow, expectPhoneTouchTargets, presentProjectAsPaused, TARGET_VIEWPORTS } from "./helpers";

test("VW06: planning survives navigation, edits the brief, and refuses stale-tab saves", async ({ page, context }) => {
  const projectId = "proj-hoopedorc";
  await presentProjectAsPaused(page, projectId);
  // The engine is real even in mock mode; pausing the seed is a local DB action.
  await page.request.post(`/api/projects/${projectId}/pause`);
  await page.goto(`/#/p/${projectId}/plan`);
  await page.getByLabel("Planning message").fill("VW06: add a clear health indicator to this existing app.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("region", { name: "Planning operation" })).toBeVisible();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await expect(page.getByText("Planning reply: succeeded")).toBeVisible();
  await expect(page.getByRole("button", { name: /Generate task table →|Re-generate task table/ })).toBeEnabled();
  await page.getByRole("button", { name: /Generate task table →|Re-generate task table/ }).click();
  await expect(page.getByText("Task generation: succeeded")).toBeVisible();
  const brief = page.getByLabel("Planning brief");
  await expect(brief).toBeEnabled();
  for (const viewport of TARGET_VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expectNoDocumentOverflow(page);
    await expectFixedSurfacesInsideViewport(page);
    if (viewport.width < 640) await expectPhoneTouchTargets(page);
  }
  const second = await context.newPage();
  await presentProjectAsPaused(second, projectId);
  await second.goto(`/#/p/${projectId}/plan`);
  await expect(second.getByLabel("Planning brief")).toBeEnabled();
  await brief.fill("# The current accepted editing draft\nKeep the existing components.");
  await expect(page.getByTestId("draft-save-status")).toHaveText("Saved");
  await second.getByLabel("Planning brief").fill("# My stale tab edits must survive");
  await expect(second.getByTestId("draft-save-status")).toHaveText("Save failed");
  await expect(second.getByLabel("Planning brief")).toHaveValue("# My stale tab edits must survive");
  await second.getByRole("button", { name: "Reload session", exact: true }).click();
  await expect(second.getByLabel("Planning brief")).toHaveValue("# The current accepted editing draft\nKeep the existing components.");
  await second.getByText("Recovered conflicting edits — copy before continuing", { exact: true }).click();
  await expect(second.getByLabel("Recovered planning edits")).toContainText("# My stale tab edits must survive");
  await second.close();
  await page.reload();
  await expect(brief).toHaveValue("# The current accepted editing draft\nKeep the existing components.");
});
