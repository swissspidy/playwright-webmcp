# playwright-webmcp

Playwright `test` and `expect` with a `webmcp` fixture for testing [WebMCP](https://github.com/webmachinelearning/webmcp) tool surfaces: discover tools in every frame, call them, record what page scripts and agents call, lint the surface, run schema-driven smoke checks, keep a tool contract next to the test, mock tools, drive Chrome's on-device model against them, and run [`webmcp-evals`](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/webmcp-evals) cases with the CLI's own semantics.

```sh
npm install --save-dev playwright-webmcp webmcp-lint @playwright/test
```

The tests run against the browser's own WebMCP implementation. Playwright's Chromium has it behind a flag:

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  use: { launchOptions: { args: ["--enable-features=WebMCP"] } },
});
```

```ts
import { test, expect } from "playwright-webmcp";

test("shop exposes usable tools", async ({ page, webmcp }) => {
  await page.goto("/");

  await expect(webmcp).toHaveTool("search_products", {
    description: /catalogue/,
    inputSchema: { required: ["query"], properties: { query: { type: "string" } } },
  });
  await expect(webmcp).toPassLint({ failOn: "warning" });
  await expect(webmcp).toMatchToolContract();

  const { products } = await webmcp.call("search_products", { query: "shirt" });
  await webmcp.call("add_to_cart", { productId: products[0].id, quantity: 2 });

  expect(webmcp).toHaveCalledTool("add_to_cart", { quantity: { $gte: 1 } });
  expect(webmcp).toMatchCalls([
    { functionName: "search_products" },
    { functionName: "add_to_cart" },
  ]);
});
```

Matchers: `toHaveTool`, `toPassLint`, `toPassSmoke`, `toMatchToolContract`, `toReachTool`, `toHaveToolCoverage`, `toHaveAgentReadinessScore`, `toRegisterToolsWithin`, `toHaveCalledTool`, `toMatchCalls`, and `toPassEval` for agents.

Agents: the lazy `promptApi` fixture drives Chrome's on-device model against the page's tools, and `toolsForAgent(webmcp)` hands the same tools as callables to any model or framework you run from Node. `expect(webmcp).toPassEval(evalCase, { agent })` takes a Vercel AI SDK `ToolLoopAgent`, any object with `generate()` or `run()`, or an async function, and judges the calls the fixture recorded.

Suite-wide reports (`tools.json` for `webmcp-evals local`, `coverage.json`, `TOOLS.md`) come from the bundled reporter: `reporter: [["list"], ["playwright-webmcp/reporter", { outputDir: ".webmcp-report" }]]`.

Fixture options: `test.use({ webmcpOptions: { record: true, lint: {...}, cdp: "auto" | "never" } })`. Set `WEBMCP_CDP=http://localhost:9222` to run against a Chrome you launched yourself.

The full fixture and matcher reference, the rule list, and the on-device model harness are documented in the [repository README](https://github.com/swissspidy/playwright-webmcp#readme). For the same rules in the editor and on `eslint` runs, see [`@swissspidy/eslint-plugin-webmcp`](https://www.npmjs.com/package/@swissspidy/eslint-plugin-webmcp); to audit a URL without a test suite, see [`webmcp-audit`](https://www.npmjs.com/package/webmcp-audit).
