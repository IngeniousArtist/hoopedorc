import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const webPort = 5183;
const apiPort = 4327;
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "line",
  outputDir: "../../test-results",
  use: {
    baseURL,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `PORT=${apiPort} DB_PATH=:memory: API_TOKEN= CORS_ORIGINS=${baseURL} HOOPEDORC_WEB_PORT=${webPort} HOOPEDORC_API_PORT=${apiPort} npm run mock`,
    cwd: rootDir,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
