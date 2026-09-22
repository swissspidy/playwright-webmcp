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
    // WebMCP is behind a feature flag in Chromium; PW_CHROMIUM picks another binary (for example
    // Chrome Beta) and PW_ARGS adds further flags.
    launchOptions: {
      ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
      args: ["--enable-features=WebMCP", ...(process.env.PW_ARGS ?? "").split(/\s+/).filter(Boolean)],
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
