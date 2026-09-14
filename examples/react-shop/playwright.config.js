import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  reporter: [["list"], ["playwright-webmcp/reporter", { outputDir: ".webmcp-report" }]],
  webServer: {
    command: "vite build && vite preview --port 4174 --strictPort",
    port: 4174,
    reuseExistingServer: true,
  },
  use: {
    baseURL: "http://localhost:4174",
    // PW_CHROMIUM picks the binary (for example Chrome Beta); PW_ARGS adds flags such as --enable-features=WebMCP.
    launchOptions: {
      ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
      ...(process.env.PW_ARGS ? { args: process.env.PW_ARGS.split(/\s+/).filter(Boolean) } : {}),
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
