import { expect, test } from "@playwright/test";
import {
  expectFixedSurfacesInsideViewport,
  expectNoDocumentOverflow,
  expectPhoneTouchTargets,
  TARGET_VIEWPORTS,
} from "./helpers";

test("VW05: settings sections preserve the draft and setup separates health from actions", async ({ page }) => {
  let saveAttempts = 0;
  let healthUnavailable = true;
  let actionRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/(setup\/(test-models|self-update)|telegram\/test)/.test(request.url())) actionRequests++;
  });
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "PUT" && ++saveAttempts === 1) {
      await route.fulfill({ status: 400, json: { error: "Injected settings validation error" } });
    } else await route.continue();
  });
  // Setup checks can inspect real installed CLIs even in mock mode. This
  // UI-only scenario supplies connection/update observations explicitly.
  await page.route("**/api/setup", (route) => route.fulfill({ json: {
    checks: [{ name: "GitHub", ok: false, detail: "Sign in on the server, then re-check." }], allOk: false,
  } }));
  await page.route("**/api/setup/model-health", (route) => route.fulfill(healthUnavailable
    ? { status: 503, json: { error: "Model health unavailable" } }
    : { json: { models: [] } }));
  await page.route("**/api/setup/self-update", (route) => route.fulfill({ json: {
    available: false, state: "idle", message: "Local installation.",
    unavailableReason: "UI updates require the Linux systemd deployment.",
  } }));

  await page.goto("/#/settings");
  const guidelines = page.getByRole("tab", { name: "Guidelines", exact: true });
  await guidelines.click();
  await page.getByLabel("Coding", { exact: true }).fill("VW05: keep the edited guidelines across every section.");
  for (const viewport of TARGET_VIEWPORTS) {
    await page.setViewportSize(viewport);
    for (const name of ["Run policy", "Models & routing", "Guidelines", "Notifications", "Installation"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      await expect(page.getByRole("tabpanel", { name, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Save Settings" })).toBeEnabled();
      await expectNoDocumentOverflow(page);
      await expectFixedSurfacesInsideViewport(page);
      if (viewport.width < 640) await expectPhoneTouchTargets(page);
    }
  }
  await page.getByRole("tab", { name: "Run policy" }).focus();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Installation" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Run policy" })).toBeFocused();
  await page.getByRole("button", { name: "Save Settings" }).click();
  await expect(page.getByRole("alert")).toContainText("Injected settings validation error");
  await guidelines.click();
  await expect(page.getByLabel("Coding", { exact: true })).toHaveValue("VW05: keep the edited guidelines across every section.");
  await page.getByRole("button", { name: "Save Settings" }).click();
  await expect(page.getByRole("status")).toHaveText("Settings saved.");
  expect(saveAttempts).toBe(2);
  await page.reload();
  await guidelines.click();
  await expect(page.getByLabel("Coding", { exact: true })).toHaveValue("VW05: keep the edited guidelines across every section.");

  await page.goto("/#/setup");
  await expect(page.getByText("Needs attention", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Test models" })).toHaveCount(0);
  for (const viewport of TARGET_VIEWPORTS) {
    await page.setViewportSize(viewport);
    for (const name of ["Overview", "Models", "Updates"]) {
      await page.getByRole("tab", { name, exact: true }).click();
      await expect(page.getByRole("tabpanel", { name, exact: true })).toBeVisible();
      await expectNoDocumentOverflow(page);
      await expectFixedSurfacesInsideViewport(page);
      if (viewport.width < 640) await expectPhoneTouchTargets(page);
    }
  }
  await expect(page.getByRole("button", { name: "Update & restart" })).toBeDisabled();
  await expect(page.getByText("npm run update")).toBeVisible();
  await page.getByRole("tab", { name: "Models", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Model health unavailable");
  healthUnavailable = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText(/No configured models were reported/)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(actionRequests).toBe(0);
});
