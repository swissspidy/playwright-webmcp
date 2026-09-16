import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: [["list"], ["./src/reporter.ts", { outputDir: ".webmcp-report" }]],
  webServer: {
    command: "node ../../examples/demo-site/server.mjs",
    port: 4173,
    reuseExistingServer: true,
  },
  use: {
    baseURL: "http://localhost:4173",
    // PW_CHROMIUM picks the binary (for example Chrome Beta); PW_ARGS adds flags such as --enable-features=WebMCP.
    launchOptions: {
      ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
      ...(process.env.PW_ARGS ? { args: process.env.PW_ARGS.split(/\s+/).filter(Boolean) } : {}),
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
