# @swissspidy/webmcp-codemode

> Prototype. Not published yet.

Code mode for [WebMCP](https://github.com/webmachinelearning/webmcp). Instead of calling a page's tools one at a time, the model writes one script that calls them, and the script runs in a QuickJS sandbox in Node. The sandbox drives Chromium through Playwright, Puppeteer or any CDP session.

What it adds over calling tools one at a time:

- **Scripts survive navigations.** The sandbox lives in Node, not in the page. A tool that loads another page does not end the script. Calling a tool the next page registers waits for it to show up, including tools registered late, while an app hydrates.
- **It follows the tool list as pages change.** Every result says how the page's tools changed and returns fresh TypeScript declarations. The model writes its next script against the page it is actually on.
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

| Tool             | What it does                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `webmcp_api`     | TypeScript declarations for the current page's tools, plus the `browser` helpers.                                                                                                                            |
| `webmcp_execute` | Runs a script. Returns the script's result, console output, every tool call with its outcome and duration, and any navigation and tool-list change. When the tools changed, it also returns the updated API. |

Flags: `--headed`, `--executable-path`, `--allow-origin` (repeatable; limits `browser.goto()`), `--tool-wait <ms>`, `--timeout <ms>`.

## As a library

```ts
import { CodeMode, formatResult } from "@swissspidy/webmcp-codemode";

const cm = await CodeMode.create(page, {
  // Playwright page, Puppeteer page, or a CDP session
  onToolCall: ({ tool }) => (tool.annotations?.consequential ? "needs approval" : true),
  canNavigate: (url) => url.origin === "https://shop.example",
});
cm.declarations(); // the API the model should see
const result = await cm.execute(modelWrittenCode);
formatResult(result, { declarations: cm.declarations() });
```

| Option             | Default | Meaning                                                                                            |
| ------------------ | ------- | -------------------------------------------------------------------------------------------------- |
| `toolWaitMs`       | 5000    | How long a call waits for its tool to be registered.                                               |
| `toolTimeoutMs`    | 30000   | How long one tool call may run before it is canceled through the browser.                          |
| `timeoutMs`        | 60000   | Wall-clock budget per script, including time spent waiting on tools.                               |
| `cpuSliceMs`       | 5000    | Longest stretch of computation without awaiting.                                                   |
| `memoryLimitBytes` | 64 MiB  | QuickJS heap limit.                                                                                |
| `maxCalls`         | 100     | Tool calls per script.                                                                             |
| `onToolCall`       | allow   | Return `true` to allow a call, or `false`/a reason string to deny it. Gets the tool's annotations. |
| `canNavigate`      | any web | Narrows `browser.goto()`. Only http(s) URLs are ever allowed.                                      |
| `unwrapResults`    | true    | Unwrap `structuredContent`, or JSON in `{ content: [{ type: "text" }] }`.                          |

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
  add: async ({ a, b }) => a + b,
});
// → { result: 42, logs: [] }
```

## How navigation is handled

`ToolRegistry` keeps the live tool list from the CDP `WebMCP` domain. Two behaviours of the domain, as observed in Chrome 156 to 159, shape it:

- On a cross-document navigation the frame id stays the same and the browser sends **no** `toolsRemoved` for the old document's tools. The registry drops a frame's tools (and its child frames) itself on `Page.frameNavigated`.
- A call that is still pending when its document unloads is answered `Completed` with `output: []`. The registry reports it as `navigated` instead, and falls back to a grace timer if no answer comes at all.

From Chrome 159, the browser reports registration ids (`toolId`) and `outputSchema`. Both landed in Chromium between revisions 1732152 and 1733639, after the M158 branch point. Calls then target the exact registration. If the tool was re-registered in the meantime, the browser refuses the call before running it, and the call is retried against the current registration. `settle()` waits for loading frames and a quiet tool list before reporting the "after" state. A short grace period also catches tools that navigate just after they answer.

## Limits of the prototype

- Chromium only, since it uses the CDP WebMCP domain. Cross-origin iframes in separate processes (OOPIFs) are not followed. Only the page the session belongs to is driven: no tabs or popups.
- If a tool with the same name exists on both the old and the new page, a call made right after a navigation starts can still reach the old document. `toolId` narrows this but does not remove it.
- Return types appear in the declarations only from Chrome 159, which reports `outputSchema`. Before that, they show `unknown`.
- Each script runs in a fresh context: variables do not carry over between `execute` calls.

## Related work

- [Playwright MCP](https://github.com/microsoft/playwright-mcp) exposes each page tool as its own MCP tool (`webmcp_<name>`) and re-collects the list after every snapshot.
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) has `list_webmcp_tools` and `execute_webmcp_tool`, behind an experimental flag.
- [`@mcp-b/codemode`](https://github.com/WebMCP-org/npm-packages/tree/main/packages/codemode) is code mode inside the page, sandboxed in an iframe or a worker. It does not survive navigations.
