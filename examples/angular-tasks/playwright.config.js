import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  reporter: [["list"], ["@swissspidy/playwright-webmcp/reporter", { outputDir: ".webmcp-report" }]],
  webServer: {
    command: "ng serve --port 4175",
    port: 4175,
    reuseExistingServer: true,
    // The first build of the Angular dev server takes a while on a cold cache.
    timeout: 180_000,
    env: { NG_CLI_ANALYTICS: "false" },
  },
  use: {
    baseURL: "http://localhost:4175",
    // WebMCP is behind a feature flag in Chromium; PW_CHROMIUM picks another binary (for example
    // Chrome Stable or Dev) and PW_ARGS adds further flags.
    launchOptions: {
      ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
      args: ["--enable-features=WebMCP", ...(process.env.PW_ARGS ?? "").split(/\s+/).filter(Boolean)],
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
