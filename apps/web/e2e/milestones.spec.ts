import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../../../packages/server/src/db/index";
import * as repo from "../../../packages/server/src/db/repo";
import { defaultSettings, ENV } from "../../../packages/server/src/config";
import { buildApp } from "../../../packages/server/src/index";
import { EngineRunner } from "../../../packages/server/src/engine-runner";
import { SelfUpdater } from "../../../packages/server/src/self-update";
import { WsHub } from "../../../packages/server/src/ws-hub";
import { expect, test } from "@playwright/test";
import { DEFAULT_MILESTONE_POLICY } from "@orc/types";
import { expectFixedSurfacesInsideViewport, expectNoDocumentOverflow, expectPhoneTouchTargets, TARGET_VIEWPORTS } from "./helpers";

test("VW15: original criteria, bounded repair confirmation, planning metadata and exact reviewed apply work at five widths", async ({ page }) => {
  // Real Fastify routes and SQLite state, injected from the real browser. Only
  // Git persistence is mocked; no provider invocation or shared mock data mutation.
  const root = mkdtempSync(join(tmpdir(), "vw15-browser-")); const db = initDb(":memory:");
  const settings = defaultSettings(); repo.upsertSettings(db, settings);
  const project = repo.createProject(db, { id: "milestone-browser", name: "VW15 milestone smoke", repoUrl: "https://github.com/example/vw15-milestone", localPath: root, defaultBranch: "main", status: "paused" });
  repo.updateProject(db, project.id, { prd: "# Checkout\nComplete checkout including declined-payment recovery." });
  const base = { projectId: project.id, description: "Verify the complete checkout flow", difficulty: "medium" as const, assignedModel: settings.routing.byDifficulty.medium, acceptanceCriteria: ["A customer can complete checkout and recover after a declined payment"], scopePaths: ["src/**", "test/**"], attempts: 1, maxAttempts: 1 };
  repo.createTask(db, { ...base, id: "checkout", title: "Checkout", status: "done", dependsOn: [] });
  repo.createTask(db, { ...base, id: "outcome", title: "Verify checkout outcome", status: "failed", dependsOn: ["checkout"], milestone: DEFAULT_MILESTONE_POLICY });
  const hub = new WsHub(); const app = await buildApp({ db, hub, engine: new EngineRunner(db, hub), selfUpdater: new SelfUpdater({ repoRoot: root, mock: true, statusFile: join(root, "update.json") }), env: { ...ENV, mock: true, apiToken: undefined, dbPath: ":memory:", dbBackupDir: join(root, "backups") }, repoRoot: root, version: "test", logger: false, planningGitPersistence: { async commitFiles() {} } });
  await page.routeWebSocket(/\/ws(?:\?|$)/, () => {});
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request(); const url = new URL(request.url());
    const response = await app.inject({ method: request.method() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: url.pathname + url.search, headers: { ...request.headers(), host: url.host }, payload: request.postData() ?? undefined });
    await route.fulfill({ status: response.statusCode, headers: { "content-type": String(response.headers["content-type"] ?? "application/json") }, body: response.body });
  });
  try {
    await page.goto(`/#/p/${project.id}/review`); const panel = page.getByRole("region", { name: "Milestone acceptance" });
    await expect(panel.getByText("0 of 1 accepted")).toBeVisible(); await expect(panel.getByText("No criterion evidence recorded.")).toBeVisible();
    await panel.getByRole("button", { name: "Prepare repair draft" }).focus(); await page.keyboard.press("Enter");
    await expect(panel.getByRole("group", { name: "Confirm milestone repair" })).toBeVisible();
    for (const viewport of TARGET_VIEWPORTS) {
      await page.setViewportSize(viewport); await panel.scrollIntoViewIfNeeded(); await expectNoDocumentOverflow(page); await expectFixedSurfacesInsideViewport(page);
      if (viewport.width < 640) await expectPhoneTouchTargets(page);
      await page.screenshot({ path: `/tmp/vw15-${viewport.width}.png`, fullPage: true });
    }
    await panel.getByRole("button", { name: "Confirm repair draft" }).click(); await expect(panel.getByRole("status")).toContainText("Repair draft saved");
    await panel.getByRole("link", { name: "Review repair in Plan" }).click();
    await expect(page.getByText(/Bounded repair round 1/).first()).toBeVisible(); await expect(page.getByRole("checkbox", { name: "Verification milestone" }).nth(1)).toBeChecked();
    await expect(page.getByLabel("Task 2 Repair rounds")).toHaveValue(String(DEFAULT_MILESTONE_POLICY.maxRepairRounds));
    for (const viewport of TARGET_VIEWPORTS) {
      await page.setViewportSize(viewport); await page.getByLabel("Task 2 Repair rounds").scrollIntoViewIfNeeded();
      await expectNoDocumentOverflow(page); await expectFixedSurfacesInsideViewport(page); if (viewport.width < 640) await expectPhoneTouchTargets(page);
    }
    await page.getByRole("button", { name: "Review plan changes" }).click(); await page.getByRole("button", { name: "Prepare change comparison" }).click();
    await expect(page.getByRole("heading", { name: "2 added · 0 revised · 2 retained" })).toBeVisible();
    await page.getByRole("button", { name: "Apply reviewed changes", exact: true }).click(); await page.getByRole("button", { name: "Confirm apply", exact: true }).click();
    await expect(page.getByRole("button", { name: "Go to Board →" })).toBeVisible();
    const after = repo.getTasks(db, project.id); expect(after).toHaveLength(4); expect(repo.getTask(db, "outcome")?.acceptanceCriteria).toEqual(base.acceptanceCriteria);
  } finally { await page.goto("about:blank"); await page.unrouteAll({ behavior: "wait" }); await app.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
