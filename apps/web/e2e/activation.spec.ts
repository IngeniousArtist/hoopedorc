import { expect, test } from "@playwright/test";
import { expectFixedSurfacesInsideViewport, expectNoDocumentOverflow, expectPhoneTouchTargets, TARGET_VIEWPORTS } from "./helpers";

test("VW12: configure selective capabilities and preserve drafts at five widths", async ({ page }) => {
  const created = await page.request.post("/api/projects", { data: { name: "VW12 activation", repoUrl: "https://github.com/example/vw12" } });
  const { project } = await created.json(); expect(created.status()).toBe(201);
  try {
    await page.goto(`/#/p/${project.id}/plan`); await page.getByLabel("Planning message").fill("Keep my brief.");
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await page.getByRole("button", { name: "Agent capabilities", exact: true }).click();
    await page.getByLabel("Configuration mode").selectOption("selected");
    await page.getByRole("button", { name: "Register MCP" }).click();
    await page.getByLabel("MCP 1 name").fill("design-server");
    await page.getByLabel("MCP URL").fill("https://example.com/mcp");
    await page.getByLabel("Activate in selective mode").check();
    for (const viewport of TARGET_VIEWPORTS) {
      await page.setViewportSize(viewport); await page.evaluate(() => window.scrollTo(0, 0));
      await expectNoDocumentOverflow(page); await expectFixedSurfacesInsideViewport(page);
      if (viewport.width < 640) await expectPhoneTouchTargets(page);
      await page.screenshot({ path: `/tmp/vw12-${viewport.width}.png`, fullPage: true });
    }
    await page.getByRole("button", { name: "Save activation" }).click();
    await expect(page.getByText(/Activation saved/)).toBeVisible();
    await page.getByText("Saved revisions and invocation history").click();
    await page.getByRole("button", { name: "Use revision 1 in Plan" }).focus(); await page.keyboard.press("Enter");
    await expect(page.getByLabel("Planning message")).toHaveValue(/Keep my brief\.[\s\S]*hoop-activation:1/);
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await page.getByRole("button", { name: "Agent capabilities", exact: true }).click();
    await page.getByLabel("MCP 1 name").fill("unsaved-change");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await page.getByRole("button", { name: "Agent capabilities", exact: true }).click();
    await expect(page.getByLabel("MCP 1 name")).toHaveValue("unsaved-change");
    await page.getByRole("button", { name: "Discard draft" }).click();
    await page.getByRole("button", { name: "Discard edits" }).click();
    await expect(page.getByLabel("MCP 1 name")).toHaveValue("design-server");
    const settings = (await (await page.request.get(`/api/projects/${project.id}/activation`)).json());
    expect(settings.manifests).toHaveLength(0);
  } finally { await page.request.delete(`/api/projects/${project.id}`); }
});
