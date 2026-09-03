import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  webServer: {
    command: "node ../../examples/demo-site/server.mjs",
    port: 4173,
    reuseExistingServer: true,
  },
  use: {
    baseURL: "http://localhost:4173",
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
