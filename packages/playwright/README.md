# playwright-webmcp

Playwright `test` and `expect` with a `webmcp` fixture for testing [WebMCP](https://github.com/webmachinelearning/webmcp) tool surfaces: discover tools in every frame, call them, record what page scripts and agents call, lint the surface, run schema-driven smoke checks, keep a tool contract next to the test, mock tools, drive Chrome's on-device model against them, and run [`webmcp-evals`](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/webmcp-evals) cases with the CLI's own semantics. A test-time shim means the same suite runs on plain Chromium in CI and on Chrome with WebMCP enabled.

```sh
npm install --save-dev playwright-webmcp @playwright/test
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

Matchers: `toHaveTool`, `toPassLint`, `toPassSmoke`, `toMatchToolContract`, `toReachTool`, `toHaveToolCoverage`, `toHaveAgentReadinessScore`, `toRegisterToolsWithin`, `toHaveCalledTool`, `toMatchCalls`, `toPassEval`.

Suite-wide reports (`tools.json` for `webmcp-evals local`, `coverage.json`, `TOOLS.md`) come from the bundled reporter: `reporter: [["list"], ["playwright-webmcp/reporter", { outputDir: ".webmcp-report" }]]`.

Fixture options: `test.use({ webmcpOptions: { shim: "auto" | "always" | "never", record: true, lint: {...}, cdp: "auto" | "never" } })`. Set `WEBMCP_CDP=http://localhost:9222` to run against a Chrome you launched yourself.

The full fixture and matcher reference, the rule list, and the on-device model harness are documented in the [repository README](https://github.com/swissspidy/playwright-webmcp#readme).
