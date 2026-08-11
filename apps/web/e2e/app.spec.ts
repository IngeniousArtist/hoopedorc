import { expect, test } from "@playwright/test";
import { expectNoDocumentOverflow } from "./helpers";

test.describe.serial("critical operator workflows", () => {
  const projectId = "proj-hoopedorc";

  test("global and project deep links stay mapped to the expected views", async ({ page }) => {
    await page.goto("/#/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page).toHaveURL(/#\/settings$/);

    await page.getByRole("button", { name: "Model Slugs" }).click();
    await expect(page.getByRole("heading", { name: "Model Slugs" })).toBeVisible();
    await expect(page).toHaveURL(/#\/model-slugs$/);

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

  test("Figma capability failure keeps the draft and retries to a verified frame", async ({
    page,
  }) => {
    await page.route(`**/api/projects/${projectId}`, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = (await response.json()) as {
        project: Record<string, unknown>;
      };
      await route.fulfill({
        response,
        json: { project: { ...body.project, status: "paused" } },
      });
    });
    await page.route(`**/api/projects/${projectId}/plan/session`, (route) =>
      route.fulfill({
        json: {
          revisionId: "11111111-1111-4111-8111-111111111111",
          messages: [
            {
              role: "user",
              content:
                "Match https://www.figma.com/design/File123/Login?node-id=10-20",
            },
            { role: "assistant", content: "Ready. [PLAN_COMPLETE]" },
          ],
          prd: "# Existing draft",
          agentsMd: "# Agents",
          draftTasks: [
            {
              title: "Build login",
              description: "Keep this draft during retry.",
              difficulty: "medium",
              assignedModel: "deepseek-flash",
              scopePaths: ["apps/web/**"],
              acceptanceCriteria: ["Login works"],
              dependsOn: [],
            },
          ],
          planCostUsd: 0,
        },
      }),
    );

    let attempts = 0;
    await page.route(
      `**/api/projects/${projectId}/plan/deconstruct`,
      async (route) => {
        attempts += 1;
        if (attempts === 1) {
          await route.fulfill({
            status: 409,
            json: {
              error: "The selected runner's Figma MCP needs authentication.",
              code: "FIGMA_VERIFICATION_FAILED",
              details: {
                costUsd: 0.02,
                issue: {
                  stage: "deconstruction",
                  code: "figma_auth_required",
                  model: "codex",
                  runner: "codex",
                  nodeId: "10:20",
                  message:
                    "The selected runner's Figma MCP needs authentication.",
                  actions: [
                    "Fix or re-authenticate Figma MCP for this runner, then retry.",
                    "Select another Figma-capable planner/deconstructor model in Settings.",
                    "Attach screenshots, then continue with attachment-only visual context.",
                  ],
                },
              },
            },
          });
          return;
        }
        await route.fulfill({
          json: {
            prdMarkdown: "# Verified plan",
            agentsMd: "# Agents",
            tasks: [
              {
                title: "Build login",
                description:
                  "Implement login.\n\n### Relevant references\n- Login desktop — https://www.figma.com/design/File123/Login?node-id=10-20",
                difficulty: "medium",
                assignedModel: "deepseek-flash",
                scopePaths: ["apps/web/**"],
                acceptanceCriteria: ["Closely matches the verified frame"],
                dependsOn: [],
              },
              {
                title: "Visual fidelity QA",
                description:
                  "Run the real app and compare the verified login node in a browser.",
                difficulty: "hard",
                role: "frontend",
                assignedModel: "glm",
                scopePaths: ["apps/web/**"],
                acceptanceCriteria: [
                  "Capture and repair the login screen at 1440×900.",
                  "Do not claim mobile Figma fidelity.",
                ],
                dependsOn: [0],
              },
            ],
            costUsd: 0.04,
            verifiedFigmaReferences: [
              {
                canonicalUrl:
                  "https://www.figma.com/design/File123/Login?node-id=10-20",
                fileKey: "File123",
                nodeId: "10:20",
                name: "Login desktop",
                width: 1440,
                height: 900,
                verifiedModel: "codex",
                verifiedRunner: "codex",
                verifiedAt: "2026-07-23T12:00:00.000Z",
              },
            ],
          },
        });
      },
    );

    await page.goto(`/#/p/${projectId}/plan`);
    await expect(page.getByLabel("Task 1 title")).toHaveValue("Build login");
    await page.getByRole("button", { name: "Re-generate task table" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Figma verification needs attention",
    );
    await expect(page.getByLabel("Task 1 title")).toHaveValue("Build login");
    await page.getByRole("button", { name: "Retry verification" }).click();
    await expect(
      page.getByRole("heading", { name: "Verified Figma screens" }),
    ).toBeVisible();
    await expect(page.getByText("node 10:20 · 1440×900")).toBeVisible();
    await expect(page.getByLabel("Task 2 title")).toHaveValue(
      "Visual fidelity QA",
    );
    await page
      .getByLabel("Assigned model for Visual fidelity QA")
      .selectOption("deepseek-pro");
    await expect(
      page.getByLabel("Assigned model for Visual fidelity QA"),
    ).toHaveValue("deepseek-pro");
    await page
      .getByRole("button", { name: "Remove Visual fidelity QA" })
      .click();
    await expect(
      page.locator('input[value="Visual fidelity QA"]'),
    ).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(attempts).toBe(2);
  });

  test("no-Figma plan review contains no automatic visual QA task", async ({
    page,
  }) => {
    await page.route(`**/api/projects/${projectId}`, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = (await response.json()) as {
        project: Record<string, unknown>;
      };
      await route.fulfill({
        response,
        json: { project: { ...body.project, status: "paused" } },
      });
    });
    await page.route(`**/api/projects/${projectId}/plan/session`, (route) =>
      route.fulfill({
        json: {
          revisionId: "22222222-2222-4222-8222-222222222222",
          messages: [
            { role: "user", content: "Add an API health endpoint." },
            { role: "assistant", content: "Ready. [PLAN_COMPLETE]" },
          ],
          prd: "# API health",
          draftTasks: [
            {
              title: "Add health endpoint",
              description: "Implement the endpoint and tests.",
              difficulty: "medium",
              assignedModel: "deepseek-pro",
              scopePaths: ["packages/server/**"],
              acceptanceCriteria: ["The endpoint reports health."],
              dependsOn: [],
            },
          ],
          planCostUsd: 0,
          verifiedFigmaReferences: [],
        },
      }),
    );

    await page.goto(`/#/p/${projectId}/plan`);
    await expect(page.getByLabel("Task 1 title")).toHaveValue(
      "Add health endpoint",
    );
    await expect(
      page.locator('input[value="Visual fidelity QA"]'),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Verified Figma screens" }),
    ).toHaveCount(0);
  });

  test("destructive dialogs preserve settings and recover stop-all and rollback failures", async ({
    page,
  }) => {
    await page.goto("/#/settings");
    const effort = page.getByLabel("Claude (planner / reviewer) reasoning effort");
    const nextEffort = (await effort.inputValue()) === "high" ? "medium" : "high";
    await effort.selectOption(nextEffort);
    const boardNav = page.getByRole("button", { name: "Board", exact: true });

    await boardNav.click();
    const discard = page.getByRole("dialog", {
      name: "Discard unsaved settings changes?",
    });
    await expect(discard).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(discard).toHaveCount(0);
    await expect(boardNav).toBeFocused();
    await expect(effort).toHaveValue(nextEffort);

    await page.evaluate(
      (id) => {
        location.hash = `#/p/${id}/board`;
      },
      projectId,
    );
    await expect(discard).toBeVisible();
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(page).toHaveURL(new RegExp(`#/p/${projectId}/board$`));

    let stopAllAttempts = 0;
    await page.route("**/api/engine/stop-all", async (route) => {
      stopAllAttempts += 1;
      if (stopAllAttempts === 1) {
        await route.fulfill({
          status: 500,
          json: { error: "Injected Stop-all failure" },
        });
        return;
      }
      await route.fulfill({ status: 204 });
    });

    const stopAllTrigger = page.getByRole("button", { name: "⏹ Stop all" });
    await stopAllTrigger.click();
    await expect(
      page.getByRole("dialog", { name: "Stop all running projects now?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^Stop all$/ }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Could not stop all running projects: Injected Stop-all failure",
    );
    await expect(
      page.getByRole("dialog", { name: "Stop all running projects now?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^Stop all$/ }).click();
    await expect(
      page.getByRole("dialog", { name: "Stop all running projects now?" }),
    ).toHaveCount(0);
    expect(stopAllAttempts).toBe(2);
    await expect(stopAllTrigger).toBeFocused();
  });

  test("rollback confirmation retains its drawer context after a rejected action", async ({
    page,
  }) => {
    const now = new Date().toISOString();
    const rollbackTask = {
      id: "t-rollback",
      projectId,
      title: "Merged feature",
      description: "A completed task with a merged PR.",
      difficulty: "medium",
      status: "done",
      dependsOn: [],
      acceptanceCriteria: ["Can be rolled back"],
      assignedModel: "deepseek-flash",
      scopePaths: ["apps/web/**"],
      attempts: 1,
      maxAttempts: 3,
      runGeneration: 0,
      runExtraAttempts: 0,
      runExhaustedModels: [],
      runRateLimitRetries: 0,
      prNumber: 77,
      createdAt: now,
      updatedAt: now,
    };
    await page.route(`**/api/projects/${projectId}/tasks`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        tasks: Array<Record<string, unknown>>;
      };
      await route.fulfill({
        response,
        json: { tasks: [...body.tasks, rollbackTask] },
      });
    });
    let rollbackAttempts = 0;
    await page.route("**/api/tasks/t-rollback/rollback", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: { rollback: null } });
        return;
      }
      rollbackAttempts += 1;
      if (rollbackAttempts === 1) {
        await route.fulfill({
          status: 409,
          json: { error: "Injected rollback failure" },
        });
        return;
      }
      await route.fulfill({
        status: 202,
        json: {
          task: rollbackTask,
          rollback: {
            id: "rollback-1",
            projectId,
            taskId: rollbackTask.id,
            sourcePrNumber: rollbackTask.prNumber,
            branch: "rollback/t-rollback",
            worktreePath: "/tmp/rollback-t-rollback",
            status: "requested",
            createdAt: now,
            updatedAt: now,
          },
        },
      });
    });

    await page.goto(`/#/p/${projectId}/board`);
    await page.locator("article").filter({ hasText: "Merged feature" }).click();
    await page.getByRole("button", { name: "PR", exact: true }).click();
    const rollbackTrigger = page.getByRole("button", { name: "↩ Rollback merge" });
    await rollbackTrigger.click();
    await expect(
      page.getByRole("dialog", { name: "Create a rollback PR for #77?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Create rollback PR" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Could not start the rollback: Injected rollback failure",
    );
    await expect(rollbackTrigger).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create rollback PR" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Create rollback PR" }).click();
    await expect(page.getByText("Rollback requested")).toBeVisible();
    expect(rollbackAttempts).toBe(2);
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
