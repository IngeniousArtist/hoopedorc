import { expect, test } from "@playwright/test";
import { expectFixedSurfacesInsideViewport, expectNoDocumentOverflow, expectPhoneTouchTargets, TARGET_VIEWPORTS } from "./helpers";

test("VW10: review evidence, code, checks and repair handoff at five widths", async ({ page }) => {
  const created = await page.request.post("/api/projects", { data: { name: "VW10 review", repoUrl: "https://github.com/example/vw10" } });
  expect(created.status()).toBe(201); const { project } = await created.json();
  const { task } = await (await page.request.post(`/api/projects/${project.id}/tasks`, { data: { title: "Review journey", acceptanceCriteria: ["Show the expected screen"] } })).json();
  const saved = await page.request.put(`/api/projects/${project.id}/preview-profile`, { data: { projectUpdatedAt: project.updatedAt, profile: { command: "never-executed", args: [], readinessPath: "/", startupTimeoutSeconds: 5 } } });
  expect(saved.status()).toBe(200);
  const previewUrl = `/api/projects/${project.id}/workspaces/${task.id}/preview`;
  expect((await page.request.post(`${previewUrl}/start`, { data: { projectUpdatedAt: (await saved.json()).projectUpdatedAt } })).status()).toBe(202);
  try {
    await page.goto(`/#/p/${project.id}/plan`);
    await page.getByLabel("Planning message").fill("Keep my existing note.");
    await page.getByRole("button", { name: "Workspaces", exact: true }).click();
    await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(task.id);
    await page.getByRole("link", { name: "Open full review", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/review/${task.id}$`));
    const browser = page.getByRole("region", { name: "Browser check", exact: true });
    await browser.getByLabel("Width", { exact: true }).fill("390");
    await browser.getByLabel("Height", { exact: true }).fill("844");
    await browser.getByRole("button", { name: "Add interaction" }).click();
    await browser.getByLabel("Step 1 target").fill("Expected screen");
    await browser.getByRole("button", { name: "Run browser check" }).click();
    await browser.getByRole("button", { name: "Confirm browser check" }).focus(); await page.keyboard.press("Enter");
    const evidence = page.getByRole("region", { name: "Review evidence", exact: true });
    await expect(evidence.getByText("Mock browser check completed. No real application was verified.")).toBeVisible();
    await evidence.getByRole("button", { name: "Read diagnostics" }).click();
    await expect(evidence.getByText("Mock browser evidence. No browser, host command or model was used.")).toBeVisible();

    await page.getByText("Attach an artifact", { exact: true }).click();
    await page.getByLabel("Artifact file").setInputFiles({ name: "native-build.txt", mimeType: "text/plain", buffer: Buffer.from("Native build completed.") });
    await page.getByLabel("What does this artifact show?").fill("Native build output for the design review");
    await page.getByRole("button", { name: "Save artifact" }).click();
    await expect(evidence.getByText("Native build output for the design review")).toBeVisible();
    for (const viewport of TARGET_VIEWPORTS) {
      await page.setViewportSize(viewport); await page.evaluate(() => window.scrollTo(0, 0));
      await expectNoDocumentOverflow(page); await expectFixedSurfacesInsideViewport(page);
      if (viewport.width < 640) {
        await expectPhoneTouchTargets(page);
        expect((await page.getByLabel("Step 1 target").boundingBox())!.width).toBeGreaterThan(200);
      }
      await page.screenshot({ path: `/tmp/vw10-${viewport.width}.png`, fullPage: true });
    }
    const sections = page.getByRole("navigation", { name: "Review sections" });
    await sections.getByRole("button", { name: "Changes", exact: true }).click();
    await page.getByRole("button", { name: /src\/App\.tsx/ }).click();
    await expect(page.getByLabel("File contents")).toContainText("Hello from your workspace");
    await sections.getByRole("button", { name: "Checks", exact: true }).click();
    await expect(page.getByText("No code-check decisions recorded yet.")).toBeVisible();
    await sections.getByRole("button", { name: "Activity", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Recent activity" })).toBeVisible();
    await sections.getByRole("button", { name: "Preview", exact: true }).click();
    await page.request.post(`${previewUrl}/stop`);
    await page.getByRole("button", { name: "Refresh review", exact: true }).click();
    await expect(evidence.getByText("stale", { exact: true })).toBeVisible();
    await evidence.getByRole("button", { name: "Reference in repair" }).last().click();
    await page.getByLabel("What should change?").fill("Make the primary action clearer.");
    await page.getByRole("button", { name: "Add repair to plan" }).click();
    await expect(page.getByLabel("Planning message")).toHaveValue(/Keep my existing note\.[\s\S]*Review follow-up[\s\S]*Make the primary action clearer/);
  } finally {
    await page.request.post(`${previewUrl}/stop`);
    expect((await page.request.delete(`/api/projects/${project.id}`)).status()).toBe(204);
  }
});
