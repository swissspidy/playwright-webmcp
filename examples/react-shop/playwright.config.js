import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  reporter: [["list"], ["@swissspidy/playwright-webmcp/reporter", { outputDir: ".webmcp-report" }]],
  webServer: {
    command: "vite build && vite preview --port 4174 --strictPort",
    port: 4174,
    reuseExistingServer: true,
  },
  use: {
    baseURL: "http://localhost:4174",
    // WebMCP is behind a feature flag in Chromium; PW_CHROMIUM picks another binary (for example
    // Chrome Beta) and PW_ARGS adds further flags.
    launchOptions: {
      ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
      args: ["--enable-features=WebMCP", ...(process.env.PW_ARGS ?? "").split(/\s+/).filter(Boolean)],
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
