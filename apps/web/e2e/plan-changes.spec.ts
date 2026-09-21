import { expect, test } from "@playwright/test";
import type { CreateProjectResponse, GetSettingsResponse, ListTasksResponse, PlanChangeReviewResponse } from "@orc/types";
import { expectFixedSurfacesInsideViewport, expectNoDocumentOverflow, expectPhoneTouchTargets, TARGET_VIEWPORTS } from "./helpers";

test("VW07: review a pending-task revision, refuse intervening changes, then apply exactly once", async ({ page }) => {
  const created = await page.request.post("/api/projects", { data: { name: "VW07 review smoke", repoUrl: "https://github.com/example/vw07-review" } });
  expect(created.status()).toBe(201);
  const { project } = await created.json() as CreateProjectResponse;
  try {
    const { settings } = await (await page.request.get("/api/settings")).json() as GetSettingsResponse;
    const taskInput = { title: "Existing pending health check", description: "Keep my task identity", difficulty: "medium", assignedModel: settings.routing.byDifficulty.medium };
    await page.request.post(`/api/projects/${project.id}/tasks`, { data: taskInput });
    const before = await (await page.request.get(`/api/projects/${project.id}/tasks`)).json() as ListTasksResponse;
    await page.goto(`/#/p/${project.id}/plan`);
    await page.getByLabel("Planning message").fill("Improve the health endpoint using existing components.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Generate task table →" }).click();
    await expect(page.getByLabel("Planning brief")).toBeEnabled();
    await page.getByRole("button", { name: "Review plan changes" }).click();
    await page.getByLabel("Apply task 1 as").selectOption(before.tasks[0]!.id);
    await page.getByRole("button", { name: "Prepare change comparison" }).click();
    await expect(page.getByRole("heading", { name: "3 added · 1 revised · 0 retained" })).toBeVisible();
    for (const viewport of TARGET_VIEWPORTS) {
      await page.setViewportSize(viewport);
      await expectNoDocumentOverflow(page); await expectFixedSurfacesInsideViewport(page);
      if (viewport.width < 640) await expectPhoneTouchTargets(page);
    }
    await page.request.post(`/api/projects/${project.id}/tasks`, { data: { ...taskInput, title: "Intervening task" } });
    await page.getByRole("button", { name: "Apply reviewed changes", exact: true }).click();
    await page.getByRole("button", { name: "Confirm apply", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "task state changed" })).toBeVisible();
    await page.getByRole("button", { name: "Refresh task state" }).click();
    const comparison = page.waitForResponse((response) => response.url().endsWith("/plan/changes/review") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Prepare change comparison" }).click();
    const { review } = await (await comparison).json() as PlanChangeReviewResponse;
    await expect(page.getByRole("heading", { name: "3 added · 1 revised · 1 retained" })).toBeVisible();
    await page.getByRole("button", { name: "Apply reviewed changes", exact: true }).click();
    await page.getByRole("button", { name: "Confirm apply", exact: true }).click();
    await expect(page.getByRole("button", { name: "Go to Board →" })).toBeVisible();
    const after = await (await page.request.get(`/api/projects/${project.id}/tasks`)).json() as ListTasksResponse;
    expect(after.tasks).toHaveLength(5);
    expect(after.tasks.find((t) => t.id === before.tasks[0]!.id)?.title).toContain("Improve the health endpoint");
    expect(after.tasks.some((t) => t.title === "Intervening task")).toBe(true);
    const replay = await page.request.post(`/api/projects/${project.id}/plan/changes/apply`, { data: { reviewId: review.id } });
    expect(replay.status()).toBe(200);
    expect((await (await page.request.get(`/api/projects/${project.id}/tasks`)).json() as ListTasksResponse).tasks).toHaveLength(5);
  } finally {
    // The shared mock server outlives this test. Remove only this test's own
    // project so subsequent workflows do not inherit an extra project row.
    const removed = await page.request.delete(`/api/projects/${project.id}`);
    expect(removed.status()).toBe(204);
  }
});
