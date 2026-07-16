import { expect, test, type Page } from "@playwright/test";
import {
  TARGET_VIEWPORTS,
  captureViewport,
  expectFixedSurfacesInsideViewport,
  expectNoDocumentOverflow,
  expectPhoneTouchTargets,
} from "./helpers";

const projectId = "proj-hoopedorc";

async function expectResponsivePage(page: Page, phone: boolean) {
  await expectNoDocumentOverflow(page);
  await expectFixedSurfacesInsideViewport(page);
  if (phone) await expectPhoneTouchTargets(page);
}

async function seedTaskActions(page: Page) {
  let tasks: Array<Record<string, unknown>> = [];
  await page.route(`**/api/projects/${projectId}/tasks`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as { tasks: Array<Record<string, unknown>> };
    tasks = body.tasks;
    await route.fulfill({ response, json: { tasks } });
  });
  await page.route("**/api/tasks/t1/stop", async (route) => {
    const task = tasks.find((candidate) => candidate.id === "t1")!;
    await route.fulfill({ json: { task: { ...task, status: "blocked" } } });
  });
  await page.route("**/api/tasks/t1/retry", async (route) => {
    const task = tasks.find((candidate) => candidate.id === "t1")!;
    await route.fulfill({ json: { task: { ...task, status: "ready" } } });
  });
}

async function seedEditablePlan(page: Page) {
  await page.route(`**/api/projects/${projectId}`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as { project: Record<string, unknown> };
    await route.fulfill({ response, json: { project: { ...body.project, status: "paused" } } });
  });
  await page.route(`**/api/projects/${projectId}/plan/session`, (route) =>
    route.fulfill({
      json: {
        messages: [
          { role: "user", content: "Make the operator UI responsive." },
          { role: "assistant", content: "The plan is ready." },
        ],
        prd: "# Responsive operator UI",
        agentsMd: "# AGENTS.md\nKeep mobile controls operable.",
        draftTasks: [
          {
            title: "Responsive editing pass",
            description: "Exercise the complete editable task card.",
            difficulty: "medium",
            assignedModel: "deepseek-flash",
            scopePaths: ["apps/web/**"],
            acceptanceCriteria: ["Works at every target viewport"],
            dependsOn: [],
          },
        ],
        planCostUsd: 0.0123,
      },
    }),
  );
}

for (const viewport of TARGET_VIEWPORTS) {
  test.describe(`${viewport.name} responsive workflows`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("all primary routes remain contained and readable", async ({ page }, testInfo) => {
      const routes = [
        { path: `/#/p/${projectId}/board`, heading: null, name: "board" },
        { path: `/#/p/${projectId}/plan`, heading: /Plan —/, name: "plan" },
        { path: `/#/p/${projectId}/costs`, heading: "Costs & Analytics", name: "costs" },
        { path: `/#/p/${projectId}/audit`, heading: "Audit Log", name: "audit" },
        { path: `/#/p/${projectId}/notifications`, heading: "Notifications", name: "notifications" },
        { path: "/#/projects", heading: "Projects", name: "projects" },
        { path: "/#/settings", heading: "Settings", name: "settings" },
        { path: "/#/model-slugs", heading: "Model Slugs", name: "model-slugs" },
        { path: "/#/setup", heading: /Setup/, name: "setup" },
        { path: "/#/new-project", heading: "New Project", name: "new-project" },
      ] as const;

      for (const route of routes) {
        await page.goto(route.path);
        if (route.heading) {
          await expect(page.getByRole("heading", { name: route.heading }).first()).toBeVisible();
        } else {
          await expect(page.locator("article").filter({ hasText: "Kanban board UI" })).toBeVisible();
        }
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
        await expectResponsivePage(page, viewport.width < 640);
        await captureViewport(page, testInfo, `${viewport.name}-${route.name}`);
      }
    });

    test("editing, drawer, approvals, Stop, retry, setup, and deletion stay operable", async ({ page }, testInfo) => {
      test.setTimeout(60_000);
      await seedTaskActions(page);
      await page.goto(`/#/p/${projectId}/board`);

      await page.getByRole("button", { name: "+ Add task" }).click();
      await expect(page.getByLabel("Title *")).toBeVisible();
      await expectResponsivePage(page, viewport.width < 640);
      await captureViewport(page, testInfo, `${viewport.name}-add-task`);
      await page.getByRole("button", { name: "Cancel" }).click();

      const activeTask = page.locator("article").filter({ hasText: "Kanban board UI" });
      await activeTask.click();
      await expect(page.getByRole("button", { name: "Close task drawer" })).toBeVisible();
      await expectResponsivePage(page, viewport.width < 640);
      await captureViewport(page, testInfo, `${viewport.name}-task-drawer`);
      await page.getByRole("button", { name: "Close task drawer" }).click();

      page.once("dialog", (dialog) => dialog.accept());
      await activeTask.getByRole("button", { name: "Stop" }).click();
      await expect(page.getByText("Stopped — task moved to Blocked.")).toBeVisible();

      await activeTask.click();
      await page.getByRole("button", { name: /Retry/ }).click();
      await expect(page.getByText("Retry queued with priority.")).toBeVisible();
      await page.getByRole("button", { name: "Close task drawer" }).click();

      await page.route("**/api/notifications/*/respond", (route) => route.fulfill({ status: 204 }));
      await page.goto(`/#/p/${projectId}/notifications`);
      await page.getByRole("button", { name: "Approve" }).click();
      await expect(page.getByText("Responded: approve")).toBeVisible();
      await expectResponsivePage(page, viewport.width < 640);

      await seedEditablePlan(page);
      await page.goto(`/#/p/${projectId}/plan`);
      const planningMessage = page.getByLabel("Planning message");
      await expect(planningMessage).toBeVisible();
      await expect(planningMessage).toHaveCSS("resize", "vertical");
      expect((await planningMessage.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(100);
      await expect(page.getByLabel("Task 1 title")).toHaveValue("Responsive editing pass");
      await expect(page.getByLabel("Assigned model for Responsive editing pass")).toBeVisible();
      await expectResponsivePage(page, viewport.width < 640);
      await captureViewport(page, testInfo, `${viewport.name}-plan-editing`);

      await page.goto("/#/settings");
      const effort = page.getByLabel("Claude (planner / reviewer) reasoning effort");
      await expect(effort).toBeVisible();
      const nextEffort = (await effort.inputValue()) === "high" ? "medium" : "high";
      await effort.selectOption(nextEffort);
      await expect(page.getByText("Unsaved changes")).toBeVisible();
      await expectResponsivePage(page, viewport.width < 640);
      await page.getByRole("button", { name: "Save Settings" }).click();
      await expect(page.getByText("Settings saved.")).toBeVisible();

      await page.goto("/#/setup");
      await page.getByRole("button", { name: "Re-run setup wizard" }).click();
      await expect(page.getByRole("heading", { name: "Welcome to Hoopedorc" })).toBeVisible();
      await expectResponsivePage(page, viewport.width < 640);

      await page.route("**/api/projects", async (route) => {
        if (route.request().method() !== "GET") {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        const body = (await response.json()) as { projects: Array<Record<string, unknown>> };
        await route.fulfill({
          response,
          json: { projects: body.projects.map((project) => ({ ...project, status: "paused" })) },
        });
      });
      await page.route(`**/api/projects/${projectId}`, async (route) => {
        if (route.request().method() === "DELETE") {
          await route.fulfill({ status: 204 });
          return;
        }
        await route.continue();
      });
      await page.goto("/#/projects");
      await page.getByRole("button", { name: "Delete" }).click();
      await expect(page.getByText("Delete + remove local clone?")).toBeVisible();
      await page.getByRole("button", { name: "Confirm" }).click();
      await expect(page.getByText("Hoopedorc Orchestrator deleted.")).toBeVisible();
      await expectResponsivePage(page, viewport.width < 640);
    });
  });
}
