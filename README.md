# playwright-webmcp

Testing tools for [WebMCP](https://github.com/webmachinelearning/webmcp) tool surfaces: a lint engine that understands the whole page, a Playwright fixture with matchers and call recording, and a reporter that turns recorded scenarios into cases for Google's [`webmcp-evals`](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/webmcp-evals) CLI.

The shape is deliberately the same as axe-core: one engine that inspects the live page, thin adapters around it.

| Package | What it is |
| --- | --- |
| [`webmcp-lint`](packages/core) | Snapshot model, rules, `lint()`, and an argument matcher plus trajectory reconciler with the same semantics as `webmcp-evals`. Runs in Node against a snapshot. |
| [`playwright-webmcp`](packages/playwright) | `test`/`expect` with a `webmcp` fixture: discover tools in every frame, call them, record calls, lint, and record scenarios. Ships a test-time shim so it runs on any Chromium. |
| [`playwright-webmcp-evals`](packages/evals-reporter) | Playwright reporter that writes `evals.json` and `tools.json` from recorded scenarios. |

## Quick start

```ts
import { test, expect } from "playwright-webmcp";

test("shop exposes usable tools", async ({ page, webmcp }) => {
  await page.goto("/");

  await expect(webmcp).toHaveTool("search_products", {
    description: /catalogue/,
    inputSchema: { required: ["query"], properties: { query: { type: "string" } } },
  });

  await expect(webmcp).toPassLint({ failOn: "warning" });

  const { products } = await webmcp.call("search_products", { query: "shirt" });
  await webmcp.call("add_to_cart", { productId: products[0].id, quantity: 2 });

  expect(webmcp).toHaveCalledTool("add_to_cart", { quantity: { $gte: 1 } });
  expect(webmcp).toMatchCalls([
    { functionName: "search_products" },
    { functionName: "add_to_cart", arguments: { productId: products[0].id } },
  ]);
});
```

Record a scenario and it becomes an eval case:

```ts
await webmcp.scenario({ name: "add two shirts", prompt: "Add two red shirts to my cart" }, async () => {
  const { products } = await webmcp.call("search_products", { query: "red" });
  await webmcp.call("add_to_cart", { productId: products[0].id, quantity: 2 });
});
```

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [["list"], ["playwright-webmcp-evals", { outputDir: ".webmcp-evals" }]],
});
```

```sh
npx webmcp-evals web --url http://localhost:3000 --evals .webmcp-evals/evals.json
npx webmcp-evals local --tools .webmcp-evals/tools.json --evals .webmcp-evals/evals.json
```

## The fixture

`webmcp` is available in every test. Before navigation it installs two init scripts:

- a **shim** implementing `document.modelContext` / `navigator.modelContext` (`registerTool`, `unregisterTool`, `provideContext`, `clearContext`, `getTools`, `executeTool`, `toolchange`, and declarative `<form toolname>` tools with `SubmitEvent.respondWith` and `toolautosubmit`). It only activates when the browser has no native WebMCP, so the same tests run on plain Chromium in CI and on Chrome with `--enable-features=WebMCP`.
- a **recorder** that wraps registration and execution so calls made by page scripts or in-page agents are captured.

| Method | Purpose |
| --- | --- |
| `snapshot()` | Tools and frame facts from every frame, including cross-origin ones (Playwright can evaluate there). |
| `tools()`, `tool(name)` | Convenience accessors. |
| `call(name, args)` | Execute a tool wherever it lives and record the call. |
| `calls()`, `clearCalls()` | Recorded calls in execution order, with `via: "fixture" \| "api"`. |
| `lint(options)` | Run the rules; the result is attached to the test. |
| `scenario(options, body)` | Record the calls `body` makes as an eval case and attach it. |

Options via `test.use({ webmcpOptions: { shim: "auto" \| "always" \| "never", record: true, lint: {...} } })`.

### Matchers

| Matcher | Receiver | Notes |
| --- | --- | --- |
| `toHaveTool(name, { description?, inputSchema?, source? })` | `webmcp` or `page` | `inputSchema` uses subset matching, so partial schemas work. |
| `toPassLint({ failOn?, rules?, extraRules? })` | `webmcp` or `page` | `failOn` defaults to `"error"`. |
| `toHaveCalledTool(name, args?)` | `webmcp` or `RecordedCall[]` | `args` accepts the evals constraint operators. |
| `toMatchCalls(expectedCall, { strict? })` | `webmcp` or `RecordedCall[]` | Full trajectory check with `ordered`, `unordered`, `optional`. |

### Argument matching

Same operators and semantics as `webmcp-evals`: `$pattern` (with `(?i)` style inline flags), `$contains`, `$gt`, `$gte`, `$lt`, `$lte`, `$type`, `$any`. Objects match as subsets, arrays positionally with equal length.

Trajectory reconciliation, which `webmcp-evals` does not expose as a library, follows these rules: the top level list is ordered, `{ unordered: [...] }` groups may match in any order, `optional: true` calls may be absent, and extra actual calls are tolerated unless `strict` is set.

## Rules

Rules see the whole page: every frame, declarative forms, and all tools together. That is why this is not an ESLint plugin.

| Rule | Severity | Checks |
| --- | --- | --- |
| `tool-name-valid` | error | Name is 1-128 chars of `[A-Za-z0-9_.-]`. |
| `description-missing` | error | Imperative tools have a description. |
| `description-length` | warning | Between `min` (20) and `max` (600) characters. |
| `param-description-missing` | warning | Every input property has a description. |
| `schema-shape` | error | Object schema; `required` entries exist in `properties`. |
| `schema-no-null-literals` | error | No `null` anywhere in the schema (Chrome's Prompt API rejects it). |
| `schema-depth` | warning | Property nesting at most `max` (3) levels. |
| `schema-unsupported-keywords` | warning | Flags `$ref`, `allOf`, `oneOf`, `anyOf`, `not`, `if`/`then`/`else`, `patternProperties`. |
| `sensitive-params` | warning | Parameter names that look like credentials or payment data. |
| `duplicate-tool-name` | error | Same name registered more than once across frames. |
| `similar-descriptions` | warning | Description similarity above `threshold` (0.7). Pass a `similarity` function to use embeddings. |
| `too-many-tools` | warning | More than `max` (20) tools on a page. |
| `no-tools` | info | Page exposes nothing. |
| `iframe-allow-tools` | info | Cross-origin frame registers tools but its `<iframe>` lacks `allow="tools"`. |
| `declarative-description` | error | `<form toolname>` also has `tooldescription`. |
| `declarative-field-description` | warning | Each named field has a label or `toolparamdescription`. |
| `declarative-autosubmit-sensitive` | error | `toolautosubmit` on forms with password or payment fields. |

Configure per rule: `false` disables, a severity string re-levels, an object overrides options.

```ts
await expect(webmcp).toPassLint({
  failOn: "warning",
  rules: { "too-many-tools": { max: 40 }, "similar-descriptions": "error", "no-tools": false },
});
```

Custom rules use `defineRule` from `webmcp-lint` and are passed through `extraRules`.

## Development

```sh
pnpm install
pnpm run build
pnpm run test:unit
pnpm run test:e2e   # set PW_CHROMIUM=/path/to/chrome to use a specific binary
```

`examples/demo-site` is the page the Playwright suite runs against.

## Status and limits

- Early. APIs will move.
- The shim exists for tests only; it is not a production polyfill and does not implement cross-origin `exposedTo` or `requestUserInteraction`.
- Recording covers executions that go through `modelContext` in the page. Calls driven by Chrome's own agent over CDP are not visible to page scripts; a CDP-based collector for real Chrome is a planned addition.
- The declarative schema derivation follows the explainer, whose exact algorithm is still marked as TBD.
- The similarity rule is lexical by default. Plug in an embedding function for better recall.

## License

Apache-2.0
