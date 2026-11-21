import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: "list",
  webServer: {
    command: "node tests/site/server.mjs",
    port: 4175,
    reuseExistingServer: true,
  },
  use: {
    baseURL: "http://localhost:4175",
    launchOptions: {
      ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
      args: ["--enable-features=WebMCP", ...(process.env.PW_ARGS ?? "").split(/\s+/).filter(Boolean)],
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
