import { expect, test } from "@playwright/test";
import type { CreateProjectResponse, GetProjectResponse, GetSettingsResponse } from "@orc/types";
import { expectFixedSurfacesInsideViewport, expectNoDocumentOverflow, expectPhoneTouchTargets, TARGET_VIEWPORTS } from "./helpers";

test("VW16: choose, edit, persist and review a backend environment without losing preview settings", async ({ page }) => {
  const preview = { command: "python3", args: ["server.py", "{port}"], readinessPath: "/health", startupTimeoutSeconds: 10 };
  const created = await page.request.post("/api/projects", { data: { name: "VW16 backend", repoUrl: "https://github.com/example/vw16", config: { preview, maxAttempts: 4 } } });
  const { project } = await created.json() as CreateProjectResponse;
  try {
    await page.goto(`/#/p/${project.id}/board`);
    await page.getByText("Project settings", { exact: false }).first().click();
    await page.getByRole("button", { name: "Advanced (setup, gates, retries, merge policy)" }).click();
    const preset = page.getByRole("button", { name: "Python backend preset" }); await preset.focus(); await page.keyboard.press("Enter");
    for (const viewport of TARGET_VIEWPORTS) { await page.setViewportSize(viewport); await expectNoDocumentOverflow(page); await expectFixedSurfacesInsideViewport(page); if (viewport.width < 640) await expectPhoneTouchTargets(page); }
    await page.getByRole("button", { name: "Apply preset" }).click();
    const args = page.getByLabel("tests arguments"); const good = await args.inputValue(); await args.fill("invalid arguments");
    await expect(page.getByRole("button", { name: "Save advanced settings" })).toBeDisabled(); await expect(args).toHaveValue("invalid arguments"); await args.fill(good);
    const save = page.getByRole("button", { name: "Save advanced settings" }); await save.click(); await expect(save).not.toBeVisible();
    const saved = await (await page.request.get(`/api/projects/${project.id}`)).json() as GetProjectResponse;
    expect(saved.project?.config?.preview).toEqual(preview); expect(saved.project?.config?.maxAttempts).toBe(4); expect(saved.project?.config?.environment?.runtime).toBe("python3");
    const { settings } = await (await page.request.get("/api/settings")).json() as GetSettingsResponse;
    const response = await page.request.post(`/api/projects/${project.id}/tasks`, { data: { title: "Backend checks", description: "No browser needed", difficulty: "easy", assignedModel: settings.routing.byDifficulty.easy } });
    const { task } = await response.json() as { task: { id: string } };
    await page.goto(`/#/p/${project.id}/review/${task.id}`);
    await expect(page.getByRole("button", { name: "Artifacts", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Browser check unavailable for artifact output" })).toBeDisabled();
    for (const viewport of TARGET_VIEWPORTS) { await page.setViewportSize(viewport); await expectNoDocumentOverflow(page); await expectFixedSurfacesInsideViewport(page); if (viewport.width < 640) await expectPhoneTouchTargets(page); await page.screenshot({ path: `/tmp/vw16-${viewport.width}.png`, fullPage: true }); }
  } finally { expect((await page.request.delete(`/api/projects/${project.id}`)).status()).toBe(204); }
});
