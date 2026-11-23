# @swissspidy/webmcp-codemode

> Experimental. The API may change between 0.x releases.

Code mode for [WebMCP](https://github.com/webmachinelearning/webmcp). Instead of calling a page's tools one at a time, the model writes one script that calls them, and the script runs in a QuickJS sandbox in Node. The sandbox drives Chromium through Playwright, Puppeteer or any CDP session.

What it adds over calling tools one at a time:

- **Scripts survive navigations.** The sandbox lives in Node, not in the page. A tool that loads another page does not end the script. Calling a tool the next page registers waits for it to show up, including tools registered late, while an app hydrates.
- **It follows the tool list as pages change.** Every result says how the page's tools changed and returns the new page's tool declarations. The model writes its next script against the page it is actually on.
- **The sandbox is real.** Each script gets a fresh QuickJS context with no DOM, network, timers or host objects. It has memory and stack limits, a wall-clock timeout, a CPU-slice limit for busy loops, and a cap on tool calls. Values cross the boundary as JSON only.
- **Independent calls run concurrently.** Host functions return guest promises (not the asyncify build), so `Promise.all` works.

```js
// One webmcp_execute call: search, open the product page, wait for its tools, add to cart, read the cart.
const [grinder] = await tools.search_products({ query: "grinder" });
await tools.open_product({ id: grinder.id }); // navigates → { navigated: true, url }
const product = await tools.get_product(); // registered 300 ms after the new page loads
await tools.add_to_cart({ quantity: 2 });
await browser.goto("/cart");
return { product, cart: await tools.get_cart() };
```

## As an MCP server

```sh
npx @swissspidy/webmcp-codemode --url https://shop.example --allow-origin https://shop.example
npx @swissspidy/webmcp-codemode --cdp http://localhost:9222   # attach to a running Chrome
```

This launches Chromium with `--enable-features=WebMCP` (it needs the `playwright` package) and serves two tools on stdio:

| Tool             | What it does                                                                                                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webmcp_api`     | TypeScript declarations for the current page's tools, plus the `browser` helpers. The description of `webmcp_execute` already holds them as of the last `tools/list`, and the server sends `notifications/tools/list_changed` when the page's tools change, so a model rarely needs this. |
| `webmcp_execute` | Runs a script. Returns the script's result, console output, every tool call with its outcome and duration, and any navigation and tool-list change. When the tools changed, it also returns the updated `tools` declaration.                                                              |

Flags: `--headed`, `--executable-path`, `--allow-origin` (repeatable; limits the URLs `browser.goto()` may request), `--tool-wait <ms>`, `--timeout <ms>`.

### Adding it to an MCP client

Claude Code:

```sh
claude mcp add webmcp-codemode -- npx -y @swissspidy/webmcp-codemode --url https://shop.example --allow-origin https://shop.example
```

Clients configured with JSON (Claude Desktop, a project's `.mcp.json`, and most others):

```json
{
  "mcpServers": {
    "webmcp-codemode": {
      "command": "npx",
      "args": [
        "-y",
        "@swissspidy/webmcp-codemode",
        "--url",
        "https://shop.example",
        "--allow-origin",
        "https://shop.example"
      ]
    }
  }
}
```

To drive a Chrome you can watch and log in to, start it with `--remote-debugging-port=9222 --enable-features=WebMCP --user-data-dir=<a dedicated directory>` and pass `--cdp http://localhost:9222` instead of `--url`. Chrome 136 and later only allows remote debugging with a profile directory other than the default one; log in to sites in that dedicated profile.

### What the model gets back

A `webmcp_execute` call with this script, on a shop where `open_product` loads the product page and the product page registers its tools after hydrating:

```js
const [lamp] = await tools.search_products({ query: "lamp" });
await tools.open_product({ id: lamp.id });
const product = await tools.get_product();
console.log("on", await browser.url());
return product;
```

returns (the updated API is shortened here):

```text
Result:
{
  "id": 3,
  "name": "Desk lamp",
  "category": "office",
  "price": 59
}

Console:
on http://localhost:4175/product?id=3

Tool calls (3):
- search_products({"query":"lamp"}) → completed [2 ms]
- open_product({"id":3}) → navigated [17 ms]
- get_product({}) → completed [302 ms]

Page navigated: http://localhost:4175/ → http://localhost:4175/product?id=3

Tools changed: +get_product, +add_to_cart, +back_to_search, -cart_size, -fail, -go_to_cart, -open_product, -search_products

Updated API:
// Page: http://localhost:4175/product?id=3
declare const tools: {
  /**
   * Details of the product on this page.
   * (read-only)
   */
  get_product(args?: {}): Promise<unknown>;
  /**
   * Add the product on this page to the cart.
   * (consequential: may need approval)
   */
  add_to_cart(args?: {
    /**
     * @default 1
     * @minimum 1
     */
    quantity?: number;
  }): Promise<unknown>;
  …
};
```

## As a library

With Playwright:

```ts
import { chromium } from "playwright";
import { CodeMode, formatResult, toolDefinitions } from "@swissspidy/webmcp-codemode";

const browser = await chromium.launch({ args: ["--enable-features=WebMCP"] });
const page = await browser.newPage();
await page.goto("https://shop.example/");

const codeMode = await CodeMode.create(page, {
  onToolCall: ({ tool }) => (tool.annotations?.consequential ? "needs approval" : true),
  canNavigate: (url) => url.origin === "https://shop.example",
});
// The tools to offer the model, with the page's API in webmcp_execute's description.
const tools = toolDefinitions(codeMode.declarations());
const result = await codeMode.execute(modelWrittenCode);
// What the model reads after the script: after a navigation, only the new page's tools.
const reply = formatResult(result, { declarations: codeMode.declarations({ compact: true }) });
```

With Puppeteer, pass its page the same way:

```ts
import puppeteer from "puppeteer";

const browser = await puppeteer.launch({ args: ["--enable-features=WebMCP"] });
const page = await browser.newPage();
await page.goto("https://shop.example/");
const codeMode = await CodeMode.create(page);
```

With a Chrome that is already running (started with `--remote-debugging-port=9222 --enable-features=WebMCP --user-data-dir=<a dedicated directory>`):

```ts
const browser = await chromium.connectOverCDP("http://localhost:9222");
const page = browser.contexts()[0].pages()[0];
const codeMode = await CodeMode.create(page);
```

Any object with CDP's `send(method, params)` and `on(event, handler)` works too, such as a Playwright or Puppeteer `CDPSession`.

`CodeMode.create()` options:

| Option             | Default | Meaning                                                                                                                                                                                |
| ------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolWaitMs`       | 5000    | How long a call waits for its tool to be registered.                                                                                                                                   |
| `toolTimeoutMs`    | 30000   | How long one tool call may run before it is canceled through the browser.                                                                                                              |
| `timeoutMs`        | 60000   | Wall-clock budget per script, including time spent waiting on tools.                                                                                                                   |
| `cpuSliceMs`       | 5000    | Longest stretch of computation without awaiting.                                                                                                                                       |
| `memoryLimitBytes` | 64 MiB  | QuickJS heap limit.                                                                                                                                                                    |
| `maxCalls`         | 100     | Tool calls per script.                                                                                                                                                                 |
| `onToolCall`       | allow   | Return `true` to allow a call, or `false`/a reason string to deny it. Gets the tool's annotations. Best-effort without registration ids (see Limits).                                  |
| `canNavigate`      | any web | Narrows the URLs `browser.goto()` may request (redirects and tool-triggered navigations are not checked). Only http(s) URLs are ever allowed.                                          |
| `firstToolWaitMs`  | 2000    | After a navigation, how long to wait for a page without tools to register its first one before reporting its tools, so pages that hydrate show up in `browser.tools()` and in results. |
| `unwrapResults`    | true    | Unwrap `structuredContent`, or JSON in `{ content: [{ type: "text" }] }`.                                                                                                              |
| `knownPages`       | none    | Pages seen in an earlier session, as `codeMode.knownPages()` returned them.                                                                                                            |
| `maxKnownPages`    | 20      | How many other known pages `declarations()` lists, most recently seen first.                                                                                                           |

Code mode remembers every page it sees: its tools, including ones that appear only after another has been used, and the calls that led there. `declarations()` lists the other pages under `KnownPages`, so a script can navigate and call the next page's tools in one go instead of ending to look at them first. Persist `codeMode.knownPages()` and pass it back as `knownPages` to carry that into later sessions.

### With your own agent

`toolDefinitions(codeMode.declarations())` returns the two MCP tools (`name`, `description`, `inputSchema`) with the page's API in the description of `webmcp_execute`, as the server lists them; `TOOL_DEFINITIONS` holds them without it. Any tool-calling API can offer code mode this way, without the MCP server in between. [`examples/codemode-agent`](../../examples/codemode-agent) wires them to the Anthropic SDK's tool runner in one file:

```sh
node examples/codemode-agent/agent.ts https://shop.example "Put two of the cheapest grinders in the cart"
```

### Examples in this repository

- [`examples/react-shop/tests/codemode.spec.js`](../../examples/react-shop/tests/codemode.spec.js): code mode against a React app built with `use-webmcp-tool`. One script searches and fills the cart, and an approval hook blocks the consequential `add_to_cart`.
- [`examples/codemode-agent`](../../examples/codemode-agent): an agent that does a task on any WebMCP site, asking before consequential calls.
- [`tests/codemode.spec.ts`](tests/codemode.spec.ts) and [`tests/site`](tests/site): a multi-page shop with tools that navigate, register late and re-register, and scripts that cross all of it.

## Inside the sandbox

- `tools.<name>(args)` calls a tool by name, resolved when it is called. `codemode.<name>(args)` is an alias, so scripts written for Cloudflare's codemode work unchanged. It throws `ToolUnavailableError` (with `.available`), `ToolError`, `ToolDeniedError` or `ToolCanceledError`. A call that is cut short because its page navigated away resolves to `{ navigated: true, url }`.
- `browser.goto(url)`, `back()`, `reload()`, `url()`, `tools()`, `waitForTool(name)` and `sleep(ms)` are the browser helpers.
- `console.log` and the other console methods are captured. `return` hands a value back. The code is either an async function body or an `async () => {}` expression.

## Executors

Scripts run on executors with the same contract as [`@cloudflare/codemode`](https://www.npmjs.com/package/@cloudflare/codemode): `execute(code, providers)` returns `{ result, error?, logs? }`.

- **`QuickJSExecutor` is the default.** It also works anywhere a Cloudflare codemode executor is expected, including in Node, where Cloudflare has no executor. Unlike their browser iframe executor, its timeout also stops `while (true) {}`, and it has a memory limit.
- **`CodeMode` accepts other executors** through the `executor` option, for example Cloudflare's `DynamicWorkerExecutor`. In that case:
  - Errors cross as plain messages, so names such as `ToolUnavailableError` don't reach the script.
  - The sandbox limits are up to that executor.

```ts
import { QuickJSExecutor } from "@swissspidy/webmcp-codemode";

const executor = new QuickJSExecutor({ timeoutMs: 10_000, memoryLimitBytes: 32 * 1024 * 1024 });
await executor.execute("async () => codemode.add({ a: 2, b: 40 })", {
  add: async (args) => {
    const { a, b } = args as { a: number; b: number };
    return a + b;
  },
});
// → { result: 42, logs: [] }
```

## How navigation is handled

`ToolRegistry` keeps the live tool list from the CDP `WebMCP` domain. Two behaviours of the domain, as observed in Chrome 156 to 159, shape it:

- On a cross-document navigation the frame id stays the same and the browser sends **no** `toolsRemoved` for the old document's tools. The registry drops a frame's tools (and its child frames) itself on `Page.frameNavigated`.
- A call that is still pending when its document unloads is answered `Completed` with `output: []`. The registry reports it as `navigated` instead, and falls back to a grace timer if no answer comes at all.

From Chrome 159, the browser reports registration ids (`toolId`) and `outputSchema`. Both landed in Chromium between revisions 1732152 and 1733639, after the M158 branch point. Calls then target the exact registration. If the tool was re-registered in the meantime, the browser refuses the call before running it, and the call is retried against the current registration. `settle()` waits for loading frames and a quiet tool list before reporting the "after" state. A short grace period also catches tools that navigate just after they answer.

## Benchmark

[`examples/codemode-bench`](../../examples/codemode-bench) runs the same tasks against the test shop in two arms:

- **Classic:** one tool per page tool, rebuilt after every navigation.
- **Code mode:** the MCP tools above.

The table shows medians of 3 runs per cell. All 24 runs succeeded. The model was Claude Opus 5.5 at `medium` effort, and costs are at list prices without prompt caching ([full results](../../examples/codemode-bench/results/2026-11-21T22-37-16-925Z.md)).

| Task                                          | Classic                    | Code mode                 |
| --------------------------------------------- | -------------------------- | ------------------------- |
| One page, one 67 KB result to filter and sum  | 2 turns, 31.7k in, $0.137  | 2 turns, 4.4k in, $0.024  |
| Add every product of a category, page by page | 11 turns, 12.8k in, $0.062 | 4 turns, 11.3k in, $0.054 |
| Find a product, add two, read the cart        | 7 turns, 7.0k in, $0.034   | 5 turns, 13.6k in, $0.063 |
| One search, then arithmetic                   | 2 turns, 2.1k in, $0.011   | 3 turns, 6.8k in, $0.031  |

Code mode pays off when a script can reduce a large tool result before the model sees it, or chain many calls across pages. For one or two small calls, the API in the tool description costs more than it saves. When the model reaches a page it has not seen, it usually lists the page's tools before acting. It does that instead of guessing names, which costs one round trip per new page.

### Bigger tasks, and Anthropic's programmatic tool calling

`--big` runs seven bigger tasks on the deployed [webmcp-tools](https://github.com/GoogleChromeLabs/webmcp-tools) demos. They need many dependent calls or large tool results, for example 240 seeded spreadsheet rows read in pages, or a 64×64 canvas to transform. A third arm, `ptc`, gives the same page tools to Anthropic's [programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling): Claude writes Python in the API's code execution container, and each tool call from that code comes back to the client to run on the page.

The table shows medians of 3 runs per cell, with the same model and settings as above (results: [classic and code mode](../../examples/codemode-bench/results/2026-11-22T21-50-00-281Z.md), [ptc](../../examples/codemode-bench/results/2026-11-22T22-28-14-646Z.md)). The ptc column leaves out code execution container time.

| Task                                              | Classic          | Code mode            | ptc                   |
| ------------------------------------------------- | ---------------- | -------------------- | --------------------- |
| Best region in Q2, over 240 rows read in pages    | $0.331           | **$0.173**           | $0.191                |
| A sorted summary sheet from the same rows         | $0.680           | **$0.228**           | $0.385                |
| Label all 240 rows by revenue                     | $0.179           | **$0.167**           | $0.245                |
| Count one colour on a 64×64 canvas                | $0.145           | **$0.131**           | $0.156                |
| Mirror the left half of the canvas onto the right | $0.296           | **$0.141**           | $0.214                |
| A total over about 8 KB of search results         | **$0.021**       | $0.071               | $0.081                |
| Add every matching product to the cart            | **$0.060**       | $0.090               | $0.220, failed 3 of 3 |
| **Total for 21 runs**                             | $5.09, 21 passed | **$2.96, 21 passed** | $4.56, 18 passed      |

Two things explain the ptc column:

- **Round trips:** each call from the container is a separate API request that resends the conversation. The sorted summary took 19 requests, and labelling the rows took 22.
- **Navigation:** the container knows only the tools listed in the request. The add-to-cart tool appears only after a search, so ptc scripts could not add anything. Code mode waits for a tool that the next page registers.

## Limits of the prototype

- Approvals are exact only with registration ids (Chrome 159+). An approval covers one registration of a tool. With ids, the browser refuses a call to a registration that has been replaced, and the replacement goes through `onToolCall` again. Without ids (Chrome 158 and earlier), calls are routed by tool name: a replacement registered before the call is sent is approved again, but one registered in the few milliseconds before the browser runs the call runs under the earlier approval.
- Chromium only, since it uses the CDP WebMCP domain. Cross-origin iframes in separate processes (OOPIFs) are not followed. Only the page the session belongs to is driven: no tabs or popups.
- If a tool with the same name exists on both the old and the new page, a call made right after a navigation starts can still reach the old document. `toolId` narrows this but does not remove it.
- Return types appear in the declarations only from Chrome 159, which reports `outputSchema`. Before that, they show `unknown`.
- Each script runs in a fresh context: variables do not carry over between `execute` calls.

## Related work

- [Playwright MCP](https://github.com/microsoft/playwright-mcp) exposes each page tool as its own MCP tool (`webmcp_<name>`) and re-collects the list after every snapshot.
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) has `list_webmcp_tools` and `execute_webmcp_tool`, behind an experimental flag.
- [`@mcp-b/codemode`](https://github.com/WebMCP-org/npm-packages/tree/main/packages/codemode) is code mode inside the page, sandboxed in an iframe or a worker. It does not survive navigations.
