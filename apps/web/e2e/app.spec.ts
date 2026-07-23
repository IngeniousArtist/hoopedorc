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
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(attempts).toBe(2);
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
