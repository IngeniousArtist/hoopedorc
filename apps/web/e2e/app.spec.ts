import { expect, test, type Page } from "@playwright/test";

async function overflowDetails(page: Page) {
  return page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => !element.closest("[data-horizontal-scroll]"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, text: element.innerText.slice(0, 60), left: rect.left, right: rect.right };
      })
      .filter(({ left, right }) => left < -1 || right > viewportWidth + 1)
      .slice(0, 10);
    return {
      viewportWidth,
      documentWidth: document.documentElement.scrollWidth,
      offenders,
    };
  });
}

async function expectNoDocumentOverflow(page: Page) {
  const details = await overflowDetails(page);
  expect(details.documentWidth, JSON.stringify(details, null, 2)).toBeLessThanOrEqual(
    details.viewportWidth + 1,
  );
  expect(details.offenders, JSON.stringify(details, null, 2)).toEqual([]);
}

test.describe.serial("critical operator workflows", () => {
  test("global and project deep links stay mapped to the expected views", async ({ page }) => {
    await page.goto("/#/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page).toHaveURL(/#\/settings$/);

    await page.getByRole("button", { name: "Board" }).click();
    await expect(page).toHaveURL(/#\/p\/proj-hoopedorc\/board$/);
    await expect(page.locator("article").filter({ hasText: "Kanban board UI" })).toBeVisible();
  });

  test("failed settings saves remain dirty and explain how to recover", async ({ page }) => {
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() === "PUT") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Injected settings save failure" }),
        });
        return;
      }
      await route.continue();
    });
    await page.goto("/#/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    const mergePolicy = page.locator("section").filter({ hasText: "Merge Policy" }).locator("select");
    await mergePolicy.selectOption("always_ask");
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    await page.getByRole("button", { name: "Save Settings" }).click();

    await expect(page.getByText("Error: Injected settings save failure")).toBeVisible();
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save Settings" })).toBeEnabled();
  });

  test("approval actions update immediately without losing their context", async ({ page }) => {
    await page.route("**/api/notifications/*/respond", (route) => route.fulfill({ status: 204 }));
    await page.goto("/#/p/proj-hoopedorc/notifications");
    await expect(page.getByText("Needs response")).toBeVisible();
    await expect(page.getByRole("link", { name: "View PR ↗" })).toBeVisible();
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Responded: approve")).toBeVisible();
  });

  test("phone navigation is usable without accidental document overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/#/p/proj-hoopedorc/board");
    await expect(page.getByLabel("Project")).toBeVisible();
    await expectNoDocumentOverflow(page);

    const setup = page.getByRole("button", { name: "Setup", exact: true });
    await setup.scrollIntoViewIfNeeded();
    await setup.click();
    await expect(page.getByRole("heading", { name: "Setup" })).toBeVisible();
    await expectNoDocumentOverflow(page);
  });
});
