import { expect, test } from "@playwright/test";
import {
  expectFixedSurfacesInsideViewport,
  expectNoDocumentOverflow,
  expectPhoneTouchTargets,
  presentProjectAsPaused,
  presentProjectAsRunning,
} from "./helpers";

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
    await presentProjectAsPaused(page, projectId);
    await page.route(`**/api/projects/${projectId}/plan/session`, (route) => {
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
      });
    });

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
    // Stop all only renders while a project is running. Present that state
    // instead of relying on the seed: a CI retry replays this serial group
    // against a server where the VW01 scenario already paused the project.
    await presentProjectAsRunning(page, projectId);
    await page.goto("/#/settings");
    await page.getByRole("tab", { name: "Models & routing" }).click();
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
    await expect(page.getByLabel("Project", { exact: true })).toBeVisible();
    await expectNoDocumentOverflow(page);

    const setup = page.getByRole("button", { name: "Setup", exact: true });
    await setup.scrollIntoViewIfNeeded();
    await setup.click();
    await expect(page.getByRole("heading", { name: "Setup" })).toBeVisible();
    await expectNoDocumentOverflow(page);
  });

  test("task log drawer stays contained at phone and desktop widths", async ({
    page,
  }) => {
    for (const width of [390, 1280] as const) {
      await page.setViewportSize({
        width,
        height: width === 390 ? 844 : 800,
      });
      await page.goto(`/#/p/${projectId}/board`);
      await page.locator("article").filter({ hasText: "Kanban board UI" }).click();
      await expect(page.getByRole("button", { name: "Close task drawer" })).toBeVisible();
      await page.getByRole("button", { name: "Logs" }).click();
      await expect(page.getByText("auto-follow")).toBeVisible();
      await expect(page.getByTestId("task-log-scroller")).toBeVisible();
      await expectNoDocumentOverflow(page);
      await page.getByRole("button", { name: "Close task drawer" }).click();
    }
  });

  test("VW04: task inspection is a deep-linkable route with Back and truthful history states", async ({
    page,
  }) => {
    // Opening a card is a history entry: the URL carries the task, browser
    // Back closes the inspector, and a pasted link opens it directly.
    await page.goto(`/#/p/${projectId}/board`);
    await page.locator("article").filter({ hasText: "Kanban board UI" }).click();
    const drawer = page.getByRole("dialog", { name: "Kanban board UI" });
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/p/${projectId}/board/t1$`));
    await page.goBack();
    await expect(drawer).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`#/p/${projectId}/board$`));

    await page.goto(`/#/p/${projectId}/board/t2`);
    await expect(page.getByRole("dialog", { name: "Orchestrator engine" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close task drawer" })).toBeVisible();

    // A phone shows the same control as Back; the inspector is full-screen.
    await page.setViewportSize({ width: 360, height: 800 });
    // innerText honors the CSS that hides the ✕ glyph at phone widths.
    await expect(page.getByRole("button", { name: "Close task drawer" })).toHaveText("‹ Back", {
      useInnerText: true,
    });
    await expectNoDocumentOverflow(page);
    await expectFixedSurfacesInsideViewport(page);
    await expectPhoneTouchTargets(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    // A failed history read is reported as failed, not as "No runs yet". The
    // outage stays on until the test lifts it (the dev server's StrictMode
    // double-mount issues the first read twice), so Retry is what recovers.
    let runsOutage = true;
    let runsAttempts = 0;
    await page.route("**/api/tasks/t2/runs", async (route) => {
      runsAttempts += 1;
      if (runsOutage) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "injected history outage" }),
        });
        return;
      }
      await route.continue();
    });
    // The page is already on this task's URL, so a goto would be a same-document
    // navigation that never re-reads history; reload to exercise the read.
    await page.reload();
    const inspector = page.getByRole("dialog", { name: "Orchestrator engine" });
    await expect(inspector.getByRole("alert")).toContainText(
      "Could not load attempts: injected history outage",
    );
    await expect(inspector.getByText("No runs yet.")).toHaveCount(0);
    const failedReads = runsAttempts;
    expect(failedReads).toBeGreaterThanOrEqual(1);
    runsOutage = false;
    await inspector.getByRole("button", { name: "Retry" }).click();
    await expect(inspector.getByText("No runs yet.")).toBeVisible();
    await expect(inspector.getByRole("alert")).toHaveCount(0);
    expect(runsAttempts).toBe(failedReads + 1);
    await page.unroute("**/api/tasks/t2/runs");

    // A deep link to a task that is not on this board says so instead of
    // opening nothing.
    await page.goto(`/#/p/${projectId}/board/no-such-task`);
    await expect(page.getByRole("status")).toContainText(
      "Task no-such-task is not on this board",
    );
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page).toHaveURL(new RegExp(`#/p/${projectId}/board$`));
  });

  // Runs last in this serial suite: it pauses the seed project through the
  // real pause route, and the suite's earlier scenarios rely on it running.
  test("VW01: the mock planner answers the real planning routes without any model call", async ({
    page,
  }) => {
    // Nothing under /plan/* is intercepted: the deterministic mock service
    // behind the real routes must produce a usable plan on its own. The
    // planning lock is real behavior worth keeping, so the running seed
    // project is paused first. On a Playwright retry it is already paused.
    const planRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/projects\/[^/]+\/plan(\/|$)/.test(request.url())) {
        planRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
      }
    });
    await page.goto(`/#/p/${projectId}/board`);
    const pause = page.getByRole("button", { name: "⏸ Pause (finish current)" });
    const resume = page.getByRole("button", { name: "Resume" });
    await expect(pause.or(resume)).toBeVisible();
    if (await pause.isVisible()) {
      await pause.click();
    }
    await expect(resume).toBeVisible();

    await page.goto(`/#/p/${projectId}/plan`);
    const message = page.getByLabel("Planning message");
    await expect(message).toBeVisible();
    await message.fill("Add an API health endpoint.");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    await expect(
      page.getByText("Mock planner (no model, CLI, MCP, or repository was used).").first(),
    ).toBeVisible();
    await expect(page.getByText(/is done planning/)).toBeVisible();
    await expect(page.getByText("planning cost $0.00")).toBeVisible();
    // VW03: the Plan tab says what the planner actually planned against.
    await expect(page.getByTestId("repository-inspection")).toHaveText(
      "Planning against the existing codebase · main @ 0000000 · node, typescript · npm scripts: build, lint, test, typecheck",
    );

    // A replayed serial group already holds a draft table, so the control may
    // read "Re-generate"; wait for this round-trip either way.
    const deconstructed = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/projects/${projectId}/plan/deconstruct`) &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: /Generate task table →|Re-generate task table/ })
      .click();
    expect((await deconstructed).status()).toBe(200);
    await expect(page.getByLabel("Task 1 title")).toHaveValue(
      "Implement: Add an API health endpoint.",
    );
    await expect(page.getByLabel("Task 2 title")).toHaveValue(
      "Add regression coverage: Add an API health endpoint.",
    );
    await expect(page.getByLabel("Task 3 title")).toHaveValue("Project documentation");
    await expect(page.locator('input[value="Visual fidelity QA"]')).toHaveCount(0);
    await expect(page.getByText("planning cost $0.00")).toBeVisible();

    expect(planRequests).toContain(`POST /api/projects/${projectId}/plan/chat`);
    expect(planRequests).toContain(`POST /api/projects/${projectId}/plan/deconstruct`);
  });

  // Runs after the VW01 scenario: the seed project is already paused and the
  // planning session already holds a transcript and a draft table.
  test("VW02: planning input survives an injected send failure and saves report the truth", async ({
    page,
  }) => {
    await page.goto(`/#/p/${projectId}/board`);
    const pause = page.getByRole("button", { name: "⏸ Pause (finish current)" });
    const resume = page.getByRole("button", { name: "Resume" });
    await expect(pause.or(resume)).toBeVisible();
    if (await pause.isVisible()) await pause.click();
    await expect(resume).toBeVisible();

    // One injected 502 on the real chat route, then the mock planner answers.
    let chatAttempts = 0;
    await page.route(`**/api/projects/${projectId}/plan/chat`, async (route) => {
      chatAttempts += 1;
      if (chatAttempts === 1) {
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ error: "planner chat failed: injected outage" }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`/#/p/${projectId}/plan`);
    const composer = page.getByLabel("Planning message");
    await composer.fill("Add request logging.");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    const pendingTurn = page.getByTestId("pending-turn");
    await expect(pendingTurn).toContainText("Add request logging.");
    await expect(pendingTurn.getByRole("alert")).toContainText("injected outage");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    // The failed-turn state must stay contained and tappable at every width.
    for (const width of [360, 768, 1440] as const) {
      await page.setViewportSize({ width, height: width === 360 ? 800 : 900 });
      await expect(pendingTurn.getByRole("button", { name: "Retry send" })).toBeVisible();
      await expectNoDocumentOverflow(page);
      await expectFixedSurfacesInsideViewport(page);
      if (width === 360) await expectPhoneTouchTargets(page);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await composer.fill("Also add a test.");
    await pendingTurn.getByRole("button", { name: "Retry send" }).click();

    await expect(pendingTurn).toHaveCount(0);
    await expect(page.getByText("Brief: Add request logging.").first()).toBeVisible();
    await expect(composer).toHaveValue("Also add a test.");
    expect(chatAttempts).toBe(2);
    await page.unroute(`**/api/projects/${projectId}/plan/chat`);

    // One injected save failure on the real save-draft route, then retry.
    let saveAttempts = 0;
    await page.route(`**/api/projects/${projectId}/plan/save-draft`, async (route) => {
      saveAttempts += 1;
      if (saveAttempts === 1) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "injected save outage" }),
        });
        return;
      }
      await route.continue();
    });
    // The previous scenario left an identical draft on the server, so wait
    // for this re-generation's round-trip and re-enabled control before
    // editing; otherwise the response can replace the input mid-edit.
    const deconstructed = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/projects/${projectId}/plan/deconstruct`) &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: /Generate task table →|Re-generate task table/ })
      .click();
    expect((await deconstructed).status()).toBe(200);
    await expect(page.getByRole("button", { name: "Re-generate task table" })).toBeEnabled();
    const firstTitle = page.getByLabel("Task 1 title");
    await expect(firstTitle).toHaveValue("Implement: Add an API health endpoint.");
    const status = page.getByTestId("draft-save-status");
    await expect(status).toHaveText("Edits are saved automatically.");

    await firstTitle.fill("Implement: Add an API health endpoint (edited).");
    await expect(status).toHaveText("Save failed");
    const saveAlert = page.getByRole("alert").filter({ hasText: "Draft save failed" });
    await expect(saveAlert).toContainText("injected save outage");
    await expect(firstTitle).toHaveValue("Implement: Add an API health endpoint (edited).");
    // The save-failed state must stay contained and tappable at every width.
    for (const width of [360, 768, 1440] as const) {
      await page.setViewportSize({ width, height: width === 360 ? 800 : 900 });
      await expect(saveAlert.getByRole("button", { name: "Retry save" })).toBeVisible();
      await expectNoDocumentOverflow(page);
      await expectFixedSurfacesInsideViewport(page);
      if (width === 360) await expectPhoneTouchTargets(page);
    }
    await page.setViewportSize({ width: 1280, height: 800 });

    await saveAlert.getByRole("button", { name: "Retry save" }).click();
    await expect(status).toHaveText("Saved");
    await expect(saveAlert).toHaveCount(0);
    expect(saveAttempts).toBe(2);
    await page.unroute(`**/api/projects/${projectId}/plan/save-draft`);

    // The unsent composer is now protected too. Confirm the intentional
    // reload, then verify the acknowledged task draft survives it.
    let sawLeavePrompt = false;
    page.once("dialog", async (dialog) => {
      expect(dialog.type()).toBe("beforeunload");
      sawLeavePrompt = true;
      await dialog.accept();
    });
    await page.reload();
    expect(sawLeavePrompt).toBe(true);
    await expect(page.getByLabel("Task 1 title")).toHaveValue(
      "Implement: Add an API health endpoint (edited).",
    );
    await expect(page.getByTestId("draft-save-status")).toHaveText(
      "Edits are saved automatically.",
    );
  });
});
