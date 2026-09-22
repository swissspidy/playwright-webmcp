# @swissspidy/playwright-webmcp

Testing tools for [WebMCP](https://github.com/webmachinelearning/webmcp) tool surfaces: a lint engine that understands the whole page, a Playwright fixture with matchers and call recording, an ESLint plugin, a site audit CLI, and a runner for Google's [`webmcp-evals`](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/webmcp-evals) cases that applies the CLI's own semantics inside Playwright.

The shape is deliberately the same as axe-core: one engine that judges tool definitions, thin adapters around it for wherever those definitions live (source files, a live page in a test, a URL).

| Package                                                      | What it is                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@swissspidy/webmcp-lint`](packages/core)                   | The engine: snapshot model, rules, `lint()` and `lintTools()`, a `webmcp-lint` CLI for `tools.json` files, the `webmcp-evals` argument matcher, and a trajectory matcher with the CLI's exact semantics plus a lenient mode. No dependencies, no browser.                                                    |
| [`@swissspidy/eslint-plugin-webmcp`](packages/eslint-plugin) | The tool-scoped rules as ESLint rules, run statically against `registerTool()`, `useWebMCP()` and your own wrappers, and against `<form toolname>` in JSX. Loads in oxlint too. `webmcp.configs.recommended` and done.                                                                                       |
| [`@swissspidy/playwright-webmcp`](packages/playwright)       | `test`/`expect` with a `webmcp` fixture: discover tools in every frame, call them, record calls, lint, mock, drive the on-device model, and run evals cases. Runs against the browser's own WebMCP implementation, and ships a reporter that writes suite-wide `tools.json`, `coverage.json` and `TOOLS.md`. |
| [`@swissspidy/webmcp-audit`](packages/audit)                 | CLI and library that crawls a site, lints every page, calls read-only tools with schema-derived inputs, detects cross-page drift, and scores agent readiness. Point it at a URL.                                                                                                                             |

## Which one do I need?

| You want to                                                                   | Use                                                                                                                                                         |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| See problems in the editor and fail `eslint` on CI                            | `@swissspidy/eslint-plugin-webmcp`. Catches per-tool problems (names, descriptions, schemas, injection) in source, before a browser runs anything.          |
| Test tools end to end: shapes, behaviour, agent trajectories, contracts       | `@swissspidy/playwright-webmcp`. The whole page, every frame, real executions, the on-device model, `webmcp-evals` cases.                                   |
| Check a site you do not have the source or tests for                          | `@swissspidy/webmcp-audit https://...`. Crawls, lints, optionally calls read-only tools, reports drift and a score.                                         |
| Lint a `tools.json`, a snapshot, or definitions from your own driver or tests | `@swissspidy/webmcp-lint`: `lintTools()`, the `@swissspidy/webmcp-lint` CLI, or `collectFrame` + `snapshotFromFrames()` with Puppeteer, WebDriver or jsdom. |

The rule engine is the same in all four; only what feeds it differs. Page-level rules (duplicate names, similar descriptions, tool count, cross-origin frames) need a live page and are therefore not in the ESLint plugin. [`examples/react-shop`](examples/react-shop) shows the whole chain on a Vite + React app with [`use-webmcp-tool`](https://www.npmjs.com/package/use-webmcp-tool).

Everything here runs against the browser's own WebMCP implementation: Playwright's Chromium with `--enable-features=WebMCP`, and Google Chrome Beta; see [Browsers](#browsers).

## Quick start

```ts
import { test, expect } from "@swissspidy/playwright-webmcp";

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

Eval cases are files you write, in the format `webmcp-evals` reads. Playwright runs them against the page with the CLI's exact matching semantics, so one `evals.json` serves both:

```json
[
  {
    "name": "add two shirts",
    "messages": [{ "role": "user", "type": "message", "content": "Add two red shirts to my cart" }],
    "expectedCall": [
      { "functionName": "search_products", "arguments": { "query": { "$contains": "shirt" } } },
      { "functionName": "add_to_cart", "arguments": { "quantity": 2 } }
    ]
  }
]
```

```ts
import cases from "./evals.json" with { type: "json" };

for (const evalCase of cases) {
  test(evalCase.name, async ({ page, promptApi }) => {
    await page.goto("/");
    test.skip(
      (await promptApi.availability()) === "unavailable",
      "needs Chrome with the Prompt API",
    );
    await expect(promptApi).toPassEval(evalCase); // or expect(webmcp).toPassEval(evalCase, { agent }), see below
  });
}
```

```sh
npx webmcp-evals browser -u http://localhost:3000 -e evals.json
npx webmcp-evals local -t .webmcp-report/tools.json -e evals.json
npx webmcp-evals smoke -u http://localhost:3000 -e evals.json   # replays the calls without a model
```

The `tools.json` for `local` mode, plus coverage and a Markdown tool reference, come from the reporter:

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [["list"], ["@swissspidy/playwright-webmcp/reporter", { outputDir: ".webmcp-report" }]],
});
```

## The fixture

`webmcp` is available in every test, and `promptApi` next to it for tests that want the on-device model (see [Agents](#agents)). The browser has to implement WebMCP (`document.modelContext`); the fixture does not polyfill it. Before navigation `webmcp` installs a **recorder** that wraps registration and execution so calls made by page scripts or in-page agents are captured.

| Method                                                  | Purpose                                                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `snapshot()`                                            | Tools and frame facts from every frame, including cross-origin ones (Playwright can evaluate there). |
| `tools()`, `tool(name)`                                 | Convenience accessors.                                                                               |
| `call(name, args, { timeoutMs? })`                      | Execute a tool wherever it lives and record the call; waits up to 5 s for the tool to be registered. |
| `calls()`, `clearCalls()`                               | Recorded calls in execution order, with `via: "fixture" \| "api"`.                                   |
| `lint(options)`                                         | Run the rules; the result is attached to the test.                                                   |
| `smoke(options)`                                        | Generate inputs from each tool's schema, execute them, and judge the results.                        |
| `contract()`, `matchToolContract(name?)`                | The page's tool contract, and a comparison against the stored one.                                   |
| `settle({ quietMs?, timeoutMs? })`                      | Wait until page-reported calls have arrived and the registered tool list has stopped changing.       |
| `reachableTools({ from? })`                             | What an agent in a given frame can reach through the API, after `allow="tools"` and `exposedTo`.     |
| `mock(name, impl)`, `unmock(name)`, `replay(recording)` | Replace tool implementations from the test; replay recorded results.                                 |
| `timeline(budgets)`                                     | Registration events since navigation, time to first tool, late and churn findings.                   |
| `coverage()`, `score()`                                 | Tool and parameter coverage; agent-readiness score.                                                  |
| `codegen({ name })`, `docs()`                           | Playwright test source from the recording; Markdown tool reference.                                  |
| `cdp`                                                   | The CDP collector when the browser has the WebMCP domain; `webmcp.cdp?.enabled`.                     |

Options via `test.use({ webmcpOptions: { record: true, lint: {...}, cdp: "auto" \| "never" } })`.

### Seeing what Chrome's agent does

When the browser has the CDP `WebMCP` domain (Chromium builds with WebMCP do), the fixture also attaches to it. That domain reports every registration and every invocation the browser mediates, including calls made by Chrome's built-in agent or another DevTools client, which page scripts cannot observe. When it is available:

- recorded calls carry `source: "cdp"`, and calls not initiated by the fixture are recorded with `via: "agent"`;
- `call()` invokes tools through `WebMCP.invokeTool` instead of page script;
- snapshots gain `location` (the registration site) and the browser's own annotations. The CDP domain spells them `readOnly`, `consequential`, `untrustedContent`, `debugging` and `autosubmit`, while the specification uses `readOnlyHint`, `consequentialHint`, `untrustedContentHint` and `debugging`; `toolHints()` from `@swissspidy/webmcp-lint` reads both, and everything here goes through it.

On browsers without the domain the collector stays off and everything falls back to the page-side hooks. Nothing in the API changes.

### Matchers

| Matcher                                                      | Receiver                     | Notes                                                               |
| ------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------- |
| `toHaveTool(name, { description?, inputSchema?, source? })`  | `webmcp` or `page`           | `inputSchema` uses subset matching. Waits like a locator assertion. |
| `toPassLint({ failOn?, rules?, extraRules?, scope? })`       | `webmcp` or `page`           | `failOn` defaults to `"error"`; `scope: "page"` skips tool rules.   |
| `toPassSmoke({ tools?, all?, kinds?, failOn?, ...budgets })` | `webmcp` or `page`           | Runtime findings from generated inputs.                             |
| `toMatchToolContract(name?)`                                 | `webmcp` or `page`           | Compares against the stored contract; honours `--update-snapshots`. |
| `toReachTool(name, { from? })`                               | `webmcp` or `page`           | Reachability through the API from a frame. Waits like `toHaveTool`. |
| `toHaveToolCoverage(min)`                                    | `webmcp` or `page`           | Fraction (0..1) or percent of tools called.                         |
| `toHaveAgentReadinessScore(min, { smoke? })`                 | `webmcp` or `page`           | Score at least `min`.                                               |
| `toRegisterToolsWithin(ms)`                                  | `webmcp` or `page`           | Time to first tool registration.                                    |
| `toHaveCalledTool(name, args?)`                              | `webmcp` or `RecordedCall[]` | `args` accepts the evals constraint operators.                      |
| `toMatchCalls(expectedCall, { strict? })`                    | `webmcp` or `RecordedCall[]` | Full trajectory check with `ordered`, `unordered`, `optional`.      |
| `toPassEval(evalCase, { agent?, mode?, strict? })`           | `webmcp` or `promptApi`      | Runs the case through the agent and reconciles its calls.           |

`toHaveTool` and `toReachTool` re-check the page until they pass, or until their negation holds under `.not`, for the expect timeout (5 s by default, `{ timeout }` to change it), because tools register after load and native `getTools()` can lag behind a registration. `call()` waits the same way for a tool that is not there yet and throws `ToolNotFoundError` after its timeout. Snapshot-based methods such as `snapshot()`, `lint()` and `contract()` look once; call `settle()` or wait for the tool first when a page registers late.

### Argument matching

Same operators and semantics as `webmcp-evals`: `$pattern` (with `(?i)` style inline flags), `$contains`, `$gt`, `$gte`, `$lt`, `$lte`, `$type`, `$any`. Objects match as subsets, arrays positionally with equal length.

Trajectory matching comes in two modes, because a Playwright assertion and an eval case want different things:

- **Lenient** (default for `toMatchCalls()`): the expectation is a subsequence of what happened. The top level list is ordered, `{ unordered: [...] }` groups may match in any order, `optional: true` calls may be absent, and extra actual calls are tolerated unless `strict` is set. Good for "the agent did at least this".
- **`mode: "evals"`** (default for `evaluateAgent()` and `toPassEval()`): a port of the CLI's own algorithm. Calls are matched positionally, an unordered group draws from a pool of exactly its size, and every actual call the expectation does not explain fails the case. A case that passes here passes in `webmcp-evals`, and vice versa. `evaluateTrajectory()` returns the same per-call rows the CLI reports.

## Agents

Everything above tests the tool surface directly. To test what an agent does with it, `toPassEval` sends an eval case's user messages to an agent and judges the calls the fixture saw. The agent is the `promptApi` fixture for a zero-setup start, or any agent you run from Node.

### The `promptApi` fixture

`promptApi` drives Chrome's Prompt API (`LanguageModel`, Gemini Nano) inside the page, offering the page's WebMCP tools to the model the way an in-page agent would. It is a separate, lazy fixture: tests that do not ask for it pay nothing. It is the cheapest way to run eval cases locally, and Gemini Nano is not a strong model, so treat its verdicts as a smoke test of your descriptions rather than a benchmark.

The harness speaks the tool-use protocol Chromium implements rather than the explainer's `execute` callbacks: the session is created with tool declarations (`name`, `description`, `inputSchema`) and `expectedOutputs: [{ type: "tool-call" }]`, `prompt()` answers with `tool-call` items, the harness runs each through `document.modelContext.executeTool()` and prompts again with `tool-response` items (`LanguageModelToolSuccess` or `LanguageModelToolError`) until the model answers in text. Tool use is behind `chrome://flags/#prompt-api-tool-use` and is not part of any origin trial; the harness has been checked against Chromium's IDL and web tests, not against a released build with the model installed.

```ts
test("model can add to cart", async ({ page, webmcp, promptApi }) => {
  await page.goto("/");
  test.skip((await promptApi.availability()) === "unavailable", "needs Chrome with the Prompt API");

  const result = await promptApi.run("Add two red shirts to my cart");
  expect(result.status).toBe("ok");
  expect(webmcp).toHaveCalledTool("add_to_cart", { quantity: { $gte: 2 } });

  // Or run an evals case straight against the on-device model:
  await expect(promptApi).toPassEval(evalCase);
});
```

| Method                                                              | Purpose                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `exists()`                                                          | Whether `LanguageModel` is defined.                                                         |
| `availability()`                                                    | `LanguageModel.availability()` for a tool-using session.                                    |
| `run(prompt \| { prompts, systemPrompt?, toolNames?, timeoutMs? })` | One session, prompts sent in order. Calls the model makes are recorded with `via: "agent"`. |
| `evaluate(evalCase, { mode?, strict? })`                            | Send the case's user messages and reconcile the calls against `expectedCall`.               |
| `useFake(plan)`                                                     | Install a scripted `LanguageModel` before navigation; a test double for your own harness.   |

Tool results go back to the model as a `text` result item holding JSON, with nulls stripped (Chrome rejects them); `toolResultFormat: "object"` sends an `object` item instead.

### Bring your own agent

The fixture is the discovery and execution half: `webmcp.tools()` lists what the page registered and `webmcp.call()` runs a tool, the way Puppeteer's `page.webmcp` does. `toolsForAgent(webmcp)` hands the same tools over as callables (`name`, `description`, `inputSchema`, `readOnly`, `execute()`), and every `execute()` runs in the page and is recorded with `via: "agent"`. The agent itself is yours: whatever model or framework you run from Node, and the stronger the model, the more the eval verdicts mean. With the Vercel AI SDK the mapping is one line per tool, and its `ToolLoopAgent` is accepted by `toPassEval` as it is:

```ts
import { ToolLoopAgent, jsonSchema, stepCountIs, tool, type JSONSchema7 } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { test, expect, toolsForAgent } from "@swissspidy/playwright-webmcp";

test("a capable model completes the purchase", async ({ page, webmcp }) => {
  await page.goto("/");
  const tools = Object.fromEntries(
    (await toolsForAgent(webmcp)).map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema<Record<string, unknown>>(t.inputSchema as JSONSchema7),
        execute: t.execute,
      }),
    ]),
  );
  const agent = new ToolLoopAgent({
    model: anthropic("claude-sonnet-5"),
    instructions: "You are a shop assistant.",
    tools,
    stopWhen: stepCountIs(5),
  });

  await expect(webmcp).toPassEval(evalCase, { agent });
  expect(webmcp).toMatchCalls([
    { functionName: "search_products" },
    { functionName: "add_to_cart" },
  ]);
});
```

The cast and the type argument are what make that line compile: `@swissspidy/webmcp-lint` types schemas loosely, and `jsonSchema()` infers `unknown` for the input unless told otherwise, which `tool()` cannot reconcile with `execute`. `toPassEval` sends each user message of the case as a turn and reconciles the calls the fixture recorded meanwhile. The `agent` can be:

- an object with `generate()`, like `ToolLoopAgent`: the first turn is sent as `{ prompt }`, later turns as `{ messages }` carrying the earlier turns and whatever `response.messages` came back, which is how the AI SDK continues a conversation;
- an object with `run()`, like the `promptApi` fixture (`expect(promptApi).toPassEval(evalCase)` is the same thing without the option);
- an async function `(prompt, { tools, index, prompts, systemPrompt, signal }) => text`, called once per turn, for a loop you write yourself against any client.

`runAgent(webmcp, agent, { prompts, systemPrompt?, timeoutMs? })` is the driver underneath, for tests that want the run result (`{ status, responses, calls, toolsOffered }`) rather than a verdict; a thrown error becomes `status: "error"` and running past `timeoutMs` `status: "timeout"`. `evaluateAgent(webmcp, agent, evalCase, options)` is what `toPassEval` calls. The package does not depend on the AI SDK; the mapping above is copied into `tests/ai-sdk.spec.ts`, where it runs against the SDK's mock model.

### Browsers

WebMCP is behind a feature flag in Chromium, so the suites launch Playwright's Chromium with `--enable-features=WebMCP` (the flag is in every `playwright.config.ts` in this repository and in `@swissspidy/webmcp-audit`). Any other Chromium build works the same way; `PW_CHROMIUM` picks the binary and `PW_ARGS` adds flags:

```sh
npx playwright install chromium                  # Playwright's Chromium, with the flag from the config
npx playwright install chrome-beta
PW_CHROMIUM=/opt/google/chrome-beta/chrome pnpm run test:e2e   # or: pnpm run test:beta
npx @swissspidy/webmcp-audit https://shop.example --executable /opt/google/chrome-beta/chrome
```

CI runs the suites on Playwright's Chromium on every push, and on Chrome Beta as an informational job, because the API is still an origin trial and the beta channel is where changes land first. Things the fixture accounts for, because tests written against one build must behave the same on the next:

- `getTools()` returns `RegisteredTool` objects without `execute`; older builds returned `inputSchema` as a JSON string, which the collector still accepts. A build fills in whichever annotation defaults it knows (`consequentialHint` and `debugging` are recent), so contracts keep only the hints a tool declared `true`.
- `executeTool(tool, input)` takes the tool object, not a name. The specification says `input` is an object; Chrome 154 and earlier took only a JSON string, and Chrome 155 deprecated the string. The fixture, the `promptApi` harness and `tests/helpers.ts` pick the shape from the browser's version (`webmcp.inputShape()`), because a refused attempt would still show up as an invocation on the CDP domain. The promise resolves with a string: JSON for objects, `String(value)` for primitives, `"undefined"` when the callback returned nothing.
- Registering a name twice rejects with `InvalidStateError`; unregistering is the `AbortSignal` passed to `registerTool()`. `exposedTo` and `fromOrigins` accept potentially trustworthy origins only, so `"*"` rejects.
- A frame whose `<iframe>` lacks `allow="tools"` cannot register at all (the `tools` permissions policy), so its tools never appear in a snapshot.
- Declarative `<select>` fields get a schema with one `const` per option plus `enum`; `schema-unsupported-keywords` skips browser-derived schemas for that reason. A field without `toolparamdescription` gets its label text as the description.
- A declarative tool without `toolautosubmit` fills the form and keeps the call open until a person submits it; that submit event carries `agentInvoked` and `respondWith`, and the call resolves with what `respondWith()` received. `webmcp.call()` therefore stays pending until the test (or a human) submits; `examples/react-shop` shows the pattern.

When both the page hooks and the CDP domain observe the same execution, the fixture keeps one record: the page side knows a page script started it (`via: "api"`), the domain knows the fixture did (`"fixture"`), an agent driver did (`"agent"`), or nobody it can see did (`"agent"`).

Three behaviours the fixture works around rather than mirrors: under load, `getTools()` in a page occasionally never resolves, so the collector bounds it and fills the frame from the registry the CDP domain reported; the `invokeTool` response can be delivered after the invocation's own events, so the collector queues its request before sending; and the top frame's aggregated `getTools()` lists a same-origin iframe's tools late or, sometimes, not at all, so the fixture collects every frame itself and `call()` reaches the frame directly, while an agent running inside the page (the `promptApi` fixture) sees only what the page sees. Set `WEBMCP_DEBUG=1` to log every CDP event and invocation to stderr when something looks off.

### Running against a real model

Playwright launches Chrome with a fresh profile, so settings made in `chrome://flags` do not apply. Launch Chrome Canary yourself with the flags enabled in its profile and a DevTools port, then point the tests at it:

1. In Chrome Canary enable `#prompt-api`, `#prompt-api-tool-use` and `#enable-webmcp-testing`, then restart. Wait for the on-device model to finish downloading (check `chrome://components`).
2. Start it with `--remote-debugging-port=9222`.
3. Run `WEBMCP_CDP=http://localhost:9222 npx playwright test`.

With `WEBMCP_CDP` set the fixture connects over CDP instead of launching a browser. Tests that need the model call `test.skip()` when `availability()` is `"unavailable"`, so the same suite runs everywhere.

### Deterministic agent tests

```ts
await promptApi.useFake({
  turns: [
    {
      match: "shirt",
      calls: [{ name: "search_products", args: { query: "shirt" } }],
      response: "Found {{result:0}}",
    },
  ],
});
await page.goto("/");
```

The fake speaks the same tool-call protocol as Chromium: it asks for the listed calls as `tool-call` items, waits for the `tool-response` items, and only then answers. It honours `tools`, `initialPrompts`, `inputQuota`, and can simulate a build without tool use via `rejectTools: true`. It exists to test your own Prompt API wiring; a scripted model proves nothing about an eval case, so keep it out of eval suites. For deterministic agent-shaped tests without a model, a scripted function agent does the same job in Node.

## Cross-origin exposure

WebMCP lets a page expose tools to embedders with `exposedTo`, and lets an embedder opt in with `<iframe allow="tools">`. `snapshot()` sees every frame because Playwright evaluates inside them, so you can assert both what exists and what an agent can actually reach through `getTools({ fromOrigins })`:

```ts
await expect(webmcp).toReachTool("partner_quote");
await expect(webmcp).not.toReachTool("partner_private");
```

Both halves of the handshake have to hold for a tool to be reachable, but only one of them is yours: an attacker writes their own embedder, so `allow="tools"` is always granted on a page that wants in. `exposedTo` is the half you control. The API takes potentially trustworthy origins and nothing else, so there is no way to expose a tool to every embedder: `["*"]` and `http://` origins other than localhost make `registerTool()` reject with `SecurityError`, and the `exposed-to-secure-origins` rule (error) flags them in source, where the intent is visible, before the browser silently drops the registration.

## Mocks and replay

`mock(name, impl)` swaps a tool's implementation for one that runs in Node, so agent tests can exercise `add_to_cart` without side effects, and a `{ error }` mock reproduces backend failures. `replay(recording)` mocks every tool in a recording so calls with the same arguments return the recorded result, which turns any recording, including one made against the on-device model, into a deterministic fixture. The mock takes over inside the recorder's wrapper around the tool's `execute`, so nothing is re-registered and `unmock()` restores the original; only tools registered through `registerTool()` in the page can be mocked, which leaves declarative forms out.

## Registration timeline

The recorder timestamps every registration and removal relative to navigation. `timeline()` reports time to first tool, tools that appear only after the load event, and tools that flap:

| Rule                  | Severity | Checks                                                        |
| --------------------- | -------- | ------------------------------------------------------------- |
| `tools-register-late` | warning  | First tool later than `lateMs` (3000) after navigation start. |
| `tools-after-load`    | info     | Tools registered after the load event.                        |
| `tool-churn`          | warning  | A tool unregistered `churnCount` (3) or more times.           |

## Coverage, score, codegen, docs

- **Coverage** counts tools and parameters the recorded calls exercised. The reporter aggregates it across the suite into `coverage.json`.
- **Score** is a 0..100 number with a breakdown: declarations (weight 40) from non-safety lint findings, runtime (30) from smoke findings when a smoke run is supplied, safety (15) from the injection, untrusted-content, capability-composition, sensitive-parameter, autosubmit, and exposure rules, and coverage (15). Errors cost 15 points of a category, warnings 5. Categories without input are left out and the rest renormalised.
- **Codegen** renders a Playwright test from the recording, with the `promptApi` fixture's `run(prompt)` for agent-made calls when a prompt is given, and a `toMatchCalls` assertion.
- **Docs** renders a Markdown reference of the tools with parameter tables and example calls; the reporter writes it as `TOOLS.md`.

## Injection scanning

Every string a page declares is read by every agent that visits it, and every string a tool returns goes straight into a model's context. `description-injection` (error) flags instruction overrides, role markers, exfiltration phrasing, and zero-width or bidirectional characters — in the description, the title, each parameter description, and the annotation values, since clients surface those too. The finding's path says which one.

Results are judged against what the tool declared. `untrustedContentHint` is the one part of this an author can fix in a declaration: it lets every client tell somebody else's words from the page's own. A tool that returns instruction-shaped text without it is passing the first off as the second, which is `untrusted-content-unmarked` (error); one that declared it gets `result-suspicious-content` (warning), because the boundary is marked and containing it is the client's job. The CDP domain marks tool output as untrusted for the same reason.

The composition is a page-level question, and `capability-trifecta` (warning) asks it: a tool that hands the agent content the author did not write, on a page that also exposes tools which act on the user's behalf, means text inside that content can ask the agent to call them. The usual third leg — access to private data — is not something a page opts into; every tool already runs inside the user's session. A tool counts as a source when it declares `untrustedContent`, or when its name or description reads like third-party content (`comments`, `reviews`, `inbox`, `feed`) and nothing contradicts that: a `<form>` that subscribes an email address submits rather than returns, so it is not inferred to be one. Declaring the hint resolves the finding; `requireDeclaration: false` reports declared chains too, for a review that wants every composition listed rather than only the fixable ones.

## Site audit

```sh
npx @swissspidy/webmcp-audit https://shop.example --max-pages 20 --smoke --out .webmcp-audit
```

Crawls same-origin links, lints every page, detects tools whose description or schema differ between pages (`cross-page-drift`), and writes `report.json` plus a Markdown report with a per-page and overall agent-readiness score. With `--smoke` it also calls tools with inputs derived from their schemas, as described under [Smoke](#smoke-runtime-checks-from-schemas): only tools annotated read-only by default, every tool with `--all-tools`. The report lists each input that ran with its arguments and outcome, and says so when a page had no read-only tool to call. Exit code 1 when any page failed to load or a finding at or above `--fail-on` (default `error`) exists, 2 on usage errors.

`--header "Authorization: Bearer …"` sends a header with every request to the audited origin (third-party frames and resources do not get it), for a protected staging site; anything beyond headers (logins, cookies, storage state) is a job for the Playwright fixture. `--baseline report.json` compares each page's tools with a previous run and reports `contract-changed` and `baseline-page-missing`, so a site without a test suite still learns when its tool surface moves. `--format github` prints one workflow-command annotation per finding and appends the Markdown report to the job summary. `--settle <ms>` waits longer for late registrations, `--executable` and repeatable `--arg` control the browser, `--quiet` suppresses stdout, and `--help` lists everything. The same is available as `audit()` from the `@swissspidy/webmcp-audit` package.

## Smoke: runtime checks from schemas

`smoke()` derives inputs from each tool's `inputSchema` and runs them: the required parameters only, all parameters, boundary values (minimum, maximum, maxLength, empty strings and arrays, each enum value), and invalid inputs (missing required, wrong type, out of range, outside enum). Every result is judged:

| Rule                           | Severity | Checks                                                                               |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------ |
| `result-error-on-valid-input`  | error    | A schema-valid call threw or reported an error.                                      |
| `result-contains-null`         | error    | Result contains `null` anywhere; Chrome's Prompt API rejects it.                     |
| `result-not-serializable`      | error    | Result cannot be JSON serialized.                                                    |
| `result-undefined`             | warning  | Tool returned nothing.                                                               |
| `result-too-large`             | warning  | Serialized result above `maxResultBytes` (16 KB).                                    |
| `result-slow`                  | warning  | Took longer than `maxDurationMs` (5 s).                                              |
| `result-accepts-invalid-input` | warning  | Invalid input was accepted without an error.                                         |
| `result-string-json`           | info     | Returned JSON as a string rather than an object.                                     |
| `untrusted-content-unmarked`   | error    | Result text reads as an instruction and the tool declares no `untrustedContentHint`. |
| `result-suspicious-content`    | warning  | The same, on a tool that did declare it: the boundary is marked.                     |

Smoke runs execute real tools. By default only tools annotated read-only (`readOnlyHint`, or `readOnly` as the CDP domain reports it) are exercised; pass `tools: [...]`, a predicate, or `all: true` to widen it. Every run is recorded as a `SmokeRun` (tool, input kind and label, arguments, result or error, duration); `formatSmokeRuns()` renders them as a Markdown table, which is what `@swissspidy/webmcp-audit` puts in its report.

Results in the MCP shape, `{ content: [{ type: "text", text }], isError? }`, which `use-webmcp-tool` and MCP servers produce, are understood: `isError: true` counts as an error on valid input, an empty `content` array as no result, and text blocks are scanned like any other string.

```ts
await expect(webmcp).toPassSmoke({ tools: ["search_products", "list_reviews"], failOn: "warning" });
```

## Tool contracts

`toMatchToolContract()` stores the page's tools (names, descriptions, schemas, annotations, sorted with stable keys) next to the test using Playwright's snapshot path, and fails with a readable diff when they change:

```
description-changed   search_products: "Search the catalogue" -> "Search the catalogue by keyword and category"
schema-changed        search_products: parameter "category" added
tool-added            checkout: new imperative tool at http://localhost:4173
```

Accept intended changes with `npx playwright test --update-snapshots`. The stored file doubles as an agent-facing changelog in code review. Playwright suffixes the file with project and platform (for example `webmcp-contract-chromium-linux.json`); set `snapshotPathTemplate` in your config if you want one file across platforms.

## Rules

Rules see the whole page: every frame, declarative forms, and all tools together. Each rule declares a scope. **tool** rules judge one definition on its own and also run statically in `eslint-plugin-webmcp` and with `lint({ scope: "tool" })`; **page** rules need everything the page registers and only run against a live page or a snapshot of one.

The table below is the tour. [`docs/rules/`](docs/rules/README.md) is the reference: one page per rule, generated from the rules themselves, with each one's options and their defaults.

| Rule                               | Severity | Scope | Checks                                                                                                |
| ---------------------------------- | -------- | ----- | ----------------------------------------------------------------------------------------------------- |
| `tool-name-valid`                  | error    | tool  | Name is 1-128 chars of `[A-Za-z0-9_.-]`.                                                              |
| `tool-name-style`                  | off      | tool  | Name follows the project's `style` (`snake_case`) and `prefix`. Opt in per project.                   |
| `tool-title-missing`               | off      | tool  | The tool has a `title` for clients to show people. Opt in.                                            |
| `description-missing`              | error    | tool  | Imperative tools have a description.                                                                  |
| `description-length`               | warning  | tool  | Between `min` (20) and `max` (600) characters.                                                        |
| `param-description-missing`        | warning  | tool  | Every input property has a description.                                                               |
| `schema-shape`                     | error    | tool  | Object schema; `required` entries exist in `properties`.                                              |
| `schema-no-null-literals`          | error    | tool  | No `null` anywhere in the schema (Chrome's Prompt API rejects it).                                    |
| `schema-depth`                     | warning  | tool  | Property nesting at most `max` (3) levels.                                                            |
| `schema-unsupported-keywords`      | warning  | tool  | Flags `$ref`, `allOf`, `oneOf`, `anyOf`, `not`, `if`/`then`/`else`, `patternProperties`.              |
| `sensitive-params`                 | warning  | tool  | Parameter names that look like credentials or payment data.                                           |
| `duplicate-tool-name`              | error    | page  | Same name registered more than once across frames.                                                    |
| `tool-shadowing`                   | error    | page  | Names that read alike, registered from different frames, origins or scripts.                          |
| `third-party-registration`         | warning  | page  | A tool registered by a script from another origin than the frame's.                                   |
| `similar-descriptions`             | warning  | page  | Lexical description similarity above `threshold` (0.7). A `similarity` function can be supplied.      |
| `too-many-tools`                   | warning  | page  | More than `max` (20) tools on a page.                                                                 |
| `no-tools`                         | info     | page  | Page exposes nothing.                                                                                 |
| `declarative-description`          | error    | tool  | `<form toolname>` also has `tooldescription`.                                                         |
| `declarative-field-description`    | warning  | tool  | Each named field has a label or `toolparamdescription`.                                               |
| `declarative-autosubmit-sensitive` | error    | tool  | `toolautosubmit` on forms with a password field, or an `autocomplete` naming a card or one-time code. |
| `description-injection`            | error    | tool  | Instructions to the agent, role markers, or hidden characters in any tool text.                       |
| `naming-consistency`               | warning  | page  | Mixed naming styles across tool or parameter names.                                                   |
| `exposed-to-secure-origins`        | error    | tool  | `exposedTo` lists something the API rejects: an insecure origin, or `"*"`.                            |
| `exposed-to-origin-only`           | warning  | tool  | An `exposedTo` entry carries a path, query, fragment or credentials, which the API ignores.           |
| `annotations-explicit`             | off      | tool  | The hints in `fields` are declared on every tool. Opt in.                                             |
| `capability-trifecta`              | warning  | page  | An undeclared source of third-party content sits on a page whose other tools act.                     |

The declarative rules read `<form>` markup: from the page at runtime, or statically from JSX (`<form toolname="...">` in a React component) through the ESLint plugin.

`tool-shadowing` is the near-miss half of `duplicate-tool-name`: an agent picks a tool by reading its name, so `search_products` in your page and `searchProducts` in an embedded widget are one choice presented as two, and a one-character difference between longer names is a typosquat. Identical names stay `duplicate-tool-name`'s finding, and near names inside a single frame are a naming problem rather than a trust one, so the rule only fires across a frame, an origin, or a registering script. `third-party-registration` asks the other question, not which tool gets picked but whose code defined it, and needs the [CDP collector](#seeing-what-chromes-agent-does), which is what records a registration site; add your own bundle host to its `allow` list.

Annotations are read under both spellings (`readOnlyHint`, `consequentialHint`, `untrustedContentHint`, `debugging` in the specification; `readOnly`, `consequential`, `untrustedContent`, `debugging`, `autosubmit` on the CDP domain). A tool declared `debugging` is rendered as such in `TOOLS.md`; it is not treated differently by the rules.

A project that runs the ESLint plugin can keep its Playwright assertion to the page-level rules, so a finding is reported once, where it is fixed: `await expect(webmcp).toPassLint({ scope: "page" })`. Without `scope` the assertion runs everything, which is the right default when there is no static lint.

Configure per rule: `false` disables, a severity string re-levels, an object overrides options. Rules marked `off` run only when configured (`true`, a severity, or options).

```ts
await expect(webmcp).toPassLint({
  failOn: "warning",
  rules: { "too-many-tools": { max: 40 }, "similar-descriptions": "error", "no-tools": false },
});
```

Custom rules use `defineRule` from `@swissspidy/webmcp-lint` and are passed through `extraRules`; give them `scope: "tool"` when they only read one tool.

## The rules outside Playwright

The same engine runs wherever tool definitions are available.

**In ESLint or oxlint.** `@swissspidy/eslint-plugin-webmcp` exposes every tool-scoped rule as `webmcp/<rule-id>`, run statically against the object literals passed to `registerTool()` and `useWebMCP()` from `use-webmcp-tool`, plus any wrapper you name in `settings.webmcp.definitions`, and against `<form toolname>` elements in JSX. A `const` holding the literal is followed. Literal fields are read; computed ones are skipped rather than guessed.

It also carries rules with no `@swissspidy/webmcp-lint` counterpart, because only the source shows what they catch and nothing survives to runtime. `webmcp/valid-event-name` flags a listener for a `tool*` event other than `toolchange`, `toolactivated` and `toolcancel`, which the typings let through and which never fires. And `webmcp/no-interpolated-text` (warning) flags tool text assembled at runtime — `` description: `Search ${siteName} products` ``, or the same by concatenation — in a name, title, description or parameter description, and in the matching JSX form attributes. By the time the page runs, that description is just a string and no page-level rule can tell it from a literal one; in the source it is visibly a sentence the author wrote half of, and the other half reaches every visiting agent. A reference to text is not an interpolation: `t("search.description")` and `STRINGS.search` are left alone. Interpolation is not by itself a bug, which is why it warns — what it asks is whether you can name where each value comes from. `fields` narrows it to the ones you care about. The same package loads as an oxlint JS plugin (`"jsPlugins": ["@swissspidy/eslint-plugin-webmcp"]`), which the test suite exercises against the real oxlint binary.

```js
// eslint.config.js
import webmcp from "@swissspidy/eslint-plugin-webmcp";
export default [
  webmcp.configs.recommended,
  { rules: { "webmcp/description-length": ["warn", { min: 30 }] } },
];
```

**On definitions you already have**, in a unit test of the module that builds your tools, or on the `tools.json` the reporter writes:

```ts
import { lintTools } from "@swissspidy/webmcp-lint";

const result = lintTools(myTools, { rules: { "too-many-tools": { max: 40 } } });
expect(result.counts.error).toBe(0);
```

```sh
npx @swissspidy/webmcp-lint .webmcp-report/tools.json --fail-on warning
npx @swissspidy/webmcp-lint .webmcp-report/tools.json --format github   # one annotation per finding in a GitHub Actions job
```

**With another driver.** `collectFrame` is self-contained and runs in any frame; `snapshotFromFrames()` assembles what the Playwright fixture would have built:

```ts
import { collectFrame, snapshotFromFrames, lint } from "@swissspidy/webmcp-lint";

const frames = await Promise.all(page.frames().map((f) => f.evaluate(collectFrame))); // Puppeteer
const result = lint(snapshotFromFrames(frames, { url: page.url() }));
```

## Development

```sh
pnpm install
pnpm run build           # typecheck resolves workspace packages through their built declarations, so build first
pnpm run typecheck
pnpm run test:unit       # @swissspidy/webmcp-lint and @swissspidy/eslint-plugin-webmcp, node --test
pnpm run test:e2e        # Playwright's Chromium with --enable-features=WebMCP; PW_CHROMIUM picks another binary, PW_ARGS adds flags
pnpm run test:beta       # the same on Google Chrome Beta (npx playwright install chrome-beta)
pnpm run lint            # @swissspidy/eslint-plugin-webmcp on examples/react-shop
pnpm run format          # Prettier; CI runs format:check
pnpm run lint:publish    # publint on every package
```

`examples/demo-site` is the page the Playwright suite runs against. The four packages share one version and are released together with [changesets](.changeset/README.md): add a changeset to your pull request, and the release workflow opens a version pull request whose merge publishes to npm with provenance. Types for the API itself come from the [`webmcp-types`](https://www.npmjs.com/package/webmcp-types) package, which `@swissspidy/playwright-webmcp` depends on and re-exports as `WebMCPTypes`.

## Recordings and evals

Every recording the fixture makes, whether from `call()`, `smoke()`, the CDP collector, or the Prompt API harness, is a list of `RecordedCall` entries: tool, arguments, result or error, timing, and who made the call. A recording is a useful regression test on its own (`toMatchCalls()` here, `webmcp-evals smoke` in the CLI), and `codegen()` renders one as a Playwright test.

A recording is not an eval, though, and this repository deliberately does not export recordings as eval cases. An eval's value is in an expectation someone chose: `$contains` instead of a literal, `optional: true` on a lookup, an unordered group where order does not matter. Recording `webmcp.call()` invocations only transcribes what the test author typed, and recording one model run only snapshots one nondeterministic trajectory. Write cases by hand and treat them as the source of truth that both Playwright and the CLI consume.

When a recording is a convenient starting point, `toEvalCase()` from `@swissspidy/webmcp-lint` turns one into a draft to edit:

```ts
import { writeFileSync } from "node:fs";
import { toEvalCase } from "@swissspidy/webmcp-lint";

await promptApi.run("Add two red shirts to my cart"); // or agent.run(...)
const draft = toEvalCase(webmcp.calls(), {
  name: "add two shirts",
  prompt: "Add two red shirts to my cart",
  argumentsMode: "types",
});
writeFileSync("evals.draft.json", JSON.stringify([draft], null, 2));
```

## Relationship to Lighthouse and DevTools

Chrome reports declarative form problems as DevTools issues (missing tool name or description, parameters without a name, title or description), and Lighthouse has audits for form coverage, schema validity of declarative tools, and a listing of registered tools. The declarative rules here overlap with those on purpose so a Playwright suite can fail a pull request on the same findings. The imperative rules, page-level rules, smoke runs, contracts, and on-device runs have no Lighthouse counterpart.

## Status and limits

- Pre-1.0. APIs will move, and the WebMCP specification itself is still changing; Chrome runs an origin trial and the API is otherwise behind `--enable-features=WebMCP`.
- The suites run on Playwright's Chromium and on Google Chrome Beta (see [Browsers](#browsers)); the beta channel moves weekly, so that CI job is informational until the API ships to stable. There is no polyfill here: a browser without `document.modelContext` sees only declarative forms in a snapshot and can execute nothing.
- The `promptApi` harness follows Chromium's tool-use protocol as specified in its IDL and web tests; it has not been run against a released build with the on-device model and tool use enabled.
- Page-side recording covers executions that go through `document.modelContext` in the page, including the ones the `promptApi` fixture and `toolsForAgent()` callables trigger. Calls driven by Chrome's own built-in agent are only visible through the CDP collector.
- The declarative schema derivation follows the explainer, whose exact algorithm is still marked as TBD.
- The similarity rule is lexical. Embedding-based similarity was considered and left out for now.
- On-device runs need Chrome Canary with the flags above; the fake model covers CI.

## License

Apache-2.0
