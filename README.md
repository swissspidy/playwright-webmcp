# playwright-webmcp

Testing tools for [WebMCP](https://github.com/webmachinelearning/webmcp) tool surfaces: a lint engine that understands the whole page, a Playwright fixture with matchers and call recording, an ESLint plugin, a site audit CLI, and a runner for Google's [`webmcp-evals`](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/webmcp-evals) cases that applies the CLI's own semantics inside Playwright.

The shape is deliberately the same as axe-core: one engine that judges tool definitions, thin adapters around it for wherever those definitions live (source files, a live page in a test, a URL).

| Package                                          | What it is                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`webmcp-lint`](packages/core)                   | The engine: snapshot model, rules, `lint()` and `lintTools()`, a `webmcp-lint` CLI for `tools.json` files, the `webmcp-evals` argument matcher, and a trajectory matcher with the CLI's exact semantics plus a lenient mode. No dependencies, no browser.                                           |
| [`eslint-plugin-webmcp`](packages/eslint-plugin) | The tool-scoped rules as ESLint rules, run statically against `registerTool()`, `useWebMCP()` and your own wrappers, and against `<form toolname>` in JSX. Loads in oxlint too. `webmcp.configs.recommended` and done.                                                                              |
| [`playwright-webmcp`](packages/playwright)       | `test`/`expect` with a `webmcp` fixture: discover tools in every frame, call them, record calls, lint, mock, drive the on-device model, and run evals cases. Ships a test-time shim so it runs on any Chromium, and a reporter that writes suite-wide `tools.json`, `coverage.json` and `TOOLS.md`. |
| [`webmcp-audit`](packages/audit)                 | CLI and library that crawls a site, lints every page, calls read-only tools with schema-derived inputs, detects cross-page drift, and scores agent readiness. Point it at a URL.                                                                                                                    |

## Which one do I need?

| You want to                                                                   | Use                                                                                                                                    |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| See problems in the editor and fail `eslint` on CI                            | `eslint-plugin-webmcp`. Catches per-tool problems (names, descriptions, schemas, injection) in source, before a browser runs anything. |
| Test tools end to end: shapes, behaviour, agent trajectories, contracts       | `playwright-webmcp`. The whole page, every frame, real executions, the on-device model, `webmcp-evals` cases.                          |
| Check a site you do not have the source or tests for                          | `webmcp-audit https://...`. Crawls, lints, optionally calls read-only tools, reports drift and a score.                                |
| Lint a `tools.json`, a snapshot, or definitions from your own driver or tests | `webmcp-lint`: `lintTools()`, the `webmcp-lint` CLI, or `collectFrame` + `snapshotFromFrames()` with Puppeteer, WebDriver or jsdom.    |

The rule engine is the same in all four; only what feeds it differs. Page-level rules (duplicate names, similar descriptions, tool count, cross-origin frames) need a live page and are therefore not in the ESLint plugin. [`examples/react-shop`](examples/react-shop) shows the whole chain on a Vite + React app with [`use-webmcp-tool`](https://www.npmjs.com/package/use-webmcp-tool).

Everything here is exercised against native WebMCP in Google Chrome Beta as well as against the test shim on plain Chromium; see [Running on native WebMCP](#running-on-native-webmcp).

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
    await expect(promptApi).toPassEval(evalCase); // or any agent you define, see below
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
  reporter: [["list"], ["playwright-webmcp/reporter", { outputDir: ".webmcp-report" }]],
});
```

## The fixture

`webmcp` is available in every test, and `promptApi` next to it for tests that want the on-device model (see [Agents](#agents)). Before navigation `webmcp` installs two init scripts:

- a **shim** implementing `document.modelContext` (also mirrored on `navigator.modelContext`) with `registerTool` including `signal` and `exposedTo`, `getTools` including `fromOrigins`, `executeTool`, `toolchange`, and declarative `<form toolname>` tools with `SubmitEvent.respondWith` and `toolautosubmit`. The pre-spec `unregisterTool`, `provideContext` and `clearContext` are kept for pages written against older explainers. It only activates when the browser has no native WebMCP, so the same tests run on plain Chromium in CI and on Chrome with WebMCP enabled (`chrome://flags/#enable-webmcp-testing`, or the Chrome 149 origin trial).
- a **recorder** that wraps registration and execution so calls made by page scripts or in-page agents are captured.

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

Options via `test.use({ webmcpOptions: { shim: "auto" \| "always" \| "never", record: true, lint: {...}, cdp: "auto" \| "never" } })`.

### Seeing what Chrome's agent does

On Chrome 150 and later the fixture also attaches to the CDP `WebMCP` domain. That domain reports every registration and every invocation the browser mediates, including calls made by Chrome's built-in agent or another DevTools client, which page scripts cannot observe. When it is available:

- recorded calls carry `source: "cdp"`, and calls not initiated by the fixture are recorded with `via: "agent"`;
- `call()` invokes tools through `WebMCP.invokeTool` instead of page script;
- snapshots gain `location` (the registration site) and the browser's own annotations. The CDP domain spells them `readOnly`, `consequential`, `untrustedContent` and `autosubmit`, while the specification uses `readOnlyHint`, `consequentialHint` and `untrustedContentHint`; `toolHints()` from `webmcp-lint` reads both, and everything here goes through it.

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
| `toPassEval(evalCase, { mode?, strict? })`                   | `promptApi` or any agent     | Runs the case through the agent and reconciles its calls.           |

`toHaveTool` and `toReachTool` re-check the page until they pass, or until their negation holds under `.not`, for the expect timeout (5 s by default, `{ timeout }` to change it), because tools register after load and native `getTools()` can lag behind a registration. `call()` waits the same way for a tool that is not there yet and throws `ToolNotFoundError` after its timeout. Snapshot-based methods such as `snapshot()`, `lint()` and `contract()` look once; call `settle()` or wait for the tool first when a page registers late.

### Argument matching

Same operators and semantics as `webmcp-evals`: `$pattern` (with `(?i)` style inline flags), `$contains`, `$gt`, `$gte`, `$lt`, `$lte`, `$type`, `$any`. Objects match as subsets, arrays positionally with equal length.

Trajectory matching comes in two modes, because a Playwright assertion and an eval case want different things:

- **Lenient** (default for `toMatchCalls()`): the expectation is a subsequence of what happened. The top level list is ordered, `{ unordered: [...] }` groups may match in any order, `optional: true` calls may be absent, and extra actual calls are tolerated unless `strict` is set. Good for "the agent did at least this".
- **`mode: "evals"`** (default for `evaluateAgent()` and `toPassEval()`): a port of the CLI's own algorithm. Calls are matched positionally, an unordered group draws from a pool of exactly its size, and every actual call the expectation does not explain fails the case. A case that passes here passes in `webmcp-evals`, and vice versa. `evaluateTrajectory()` returns the same per-call rows the CLI reports.

## Agents

Everything above tests the tool surface directly. To test what an agent does with it, the package has one small contract: an agent takes prompts, may call the page's tools, and reports its calls. Two implementations ship, and `toPassEval` accepts either.

### The `promptApi` fixture

`promptApi` drives Chrome's Prompt API (`LanguageModel`, Gemini Nano) inside the page, offering the page's WebMCP tools to the model the way an in-page agent would. It is a separate, lazy fixture: tests that do not ask for it pay nothing. It is the cheapest way to run eval cases locally, and Gemini Nano is not a strong model, so treat its verdicts as a smoke test of your descriptions rather than a benchmark.

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

Tool results go back to the model as JSON strings with nulls stripped, which is what Chrome accepts.

### Bring your own agent

`defineAgent(webmcp, drive)` turns a function into an agent. The function gets the page's tools as callables (`name`, `description`, `inputSchema`, `readOnly`, `execute()`), the prompts, the system prompt and an abort signal; every `execute()` runs the tool in the page and is recorded with `via: "agent"`. Whatever model or framework you use in Node works, and the stronger the model, the more the eval verdicts mean. With the Vercel AI SDK:

```ts
import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent, test, expect } from "playwright-webmcp";

test("a capable model completes the purchase", async ({ page, webmcp }) => {
  await page.goto("/");
  const agent = defineAgent(webmcp, async ({ tools, prompts, systemPrompt, signal }) => {
    const { text } = await generateText({
      model: anthropic("claude-sonnet-5"),
      system: systemPrompt,
      prompt: prompts.join("\n"),
      tools: Object.fromEntries(
        tools.map((t) => [
          t.name,
          tool({
            description: t.description,
            inputSchema: jsonSchema(t.inputSchema),
            execute: t.execute,
          }),
        ]),
      ),
      stopWhen: stepCountIs(5),
      abortSignal: signal,
    });
    return text;
  });

  await expect(agent).toPassEval(evalCase);
  expect(webmcp).toMatchCalls([
    { functionName: "search_products" },
    { functionName: "add_to_cart" },
  ]);
});
```

`agent.run()` returns `{ status, responses, calls, toolsOffered }`; a thrown error becomes `status: "error"` and the timeout `status: "timeout"`. `evaluateAgent(agent, evalCase, options)` is what `toPassEval` calls; `toolsForAgent(webmcp, { toolNames })` gives you the callables without the wrapper, for an agent loop you drive yourself.

### Running on native WebMCP

Google Chrome Beta ships the API behind a flag. Point the suites at it with the binary and the flag, and everything runs against the real implementation instead of the shim: the fixture detects native support and stays out of the way, the CDP `WebMCP` domain is attached, and `webmcp.call()` goes through `WebMCP.invokeTool`.

```sh
npx playwright install chrome-beta
PW_CHROMIUM=/opt/google/chrome-beta/chrome PW_ARGS="--enable-features=WebMCP" pnpm run test:e2e   # or: pnpm run test:native
npx webmcp-audit https://shop.example --executable /opt/google/chrome-beta/chrome --arg --enable-features=WebMCP
```

The repository's own suites pass on Chrome Beta 154 this way, and CI runs them there on every push. Things the shim mirrors from Chrome, because tests written against one must behave the same on the other:

- `getTools()` returns `RegisteredTool` objects without `execute` (and, in Chrome 154, with `inputSchema` as a JSON string; the collector accepts both). `annotations` come back with all three hints, defaults filled in, when any were given.
- `executeTool(tool, input)` takes the tool object, not a name. Chrome 154 wants `input` as a JSON string; the fixture sends that first and falls back to the object the specification describes. The promise resolves with a string: JSON for objects, `String(value)` for primitives, `"undefined"` when the callback returned nothing.
- Registering a name twice rejects with `InvalidStateError`; unregistering is the `AbortSignal` passed to `registerTool()`. The pre-spec `unregisterTool`, `provideContext` and `clearContext` exist only in the shim.
- `getTools({ fromOrigins })` rejects `"*"`; a frame whose `<iframe>` lacks `allow="tools"` cannot register at all (the `tools` permissions policy), so `iframe-allow-tools` only ever fires against the shim.
- Declarative `<select>` fields get a schema with one `const` per option plus `enum`; `schema-unsupported-keywords` skips browser-derived schemas for that reason.
- A declarative tool without `toolautosubmit` fills the form and keeps the call open until a person submits it; that submit event carries `agentInvoked` and `respondWith`, and the call resolves with what `respondWith()` received. `webmcp.call()` therefore stays pending until the test (or a human) submits; `examples/react-shop` shows the pattern.

When both the page hooks and the CDP domain observe the same execution, the fixture keeps one record: the page side knows a page script started it (`via: "api"`), the domain knows the fixture did (`"fixture"`), an agent driver did (`"agent"`), or nobody it can see did (`"agent"`).

Two Chrome 154 behaviours the fixture works around rather than mirrors: under load, `getTools()` in a page occasionally never resolves, so the collector bounds it and fills the frame from the registry the CDP domain reported; and the `invokeTool` response can be delivered after the invocation's own events, so the collector queues its request before sending. Set `WEBMCP_DEBUG=1` to log every CDP event and invocation to stderr when something looks off.

### Running against a real model

Playwright launches Chrome with a fresh profile, so settings made in `chrome://flags` do not apply. Launch Chrome Canary yourself with the flags enabled in its profile and a DevTools port, then point the tests at it:

1. In Chrome Canary enable `#optimization-guide-on-device-model`, `#prompt-api-for-gemini-nano`, `#prompt-api-tool-use`, and `#webmcp-for-testing`, then restart. Wait for the on-device model to finish downloading (check `chrome://components`).
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

The fake honours `tools`, `initialPrompts`, `inputQuota`, and can simulate a build without tool use via `rejectTools: true`. It exists to test your own Prompt API wiring; a scripted model proves nothing about an eval case, so keep it out of eval suites. For deterministic agent-shaped tests without a model, `defineAgent()` with a scripted driver does the same job in Node.

## Cross-origin exposure

WebMCP lets a page expose tools to embedders with `exposedTo`, and lets an embedder opt in with `<iframe allow="tools">`. The test shim implements both over `postMessage`: `getTools({ fromOrigins })` in the embedder asks each allowed cross-origin frame for the tools exposed to the embedder's origin, and remote tools execute through the same channel. `snapshot()` still sees every frame because Playwright evaluates inside them, so you can assert both what exists and what an agent can actually reach:

```ts
await expect(webmcp).toReachTool("partner_quote");
await expect(webmcp).not.toReachTool("partner_private");
```

The `exposed-to-secure-origins` rule flags `exposedTo` entries that the API would reject, and `iframe-allow-tools` points at cross-origin frames that register tools nobody can reach.

## Mocks and replay

`mock(name, impl)` swaps a tool's implementation for one that runs in Node, so agent tests can exercise `add_to_cart` without side effects, and a `{ error }` mock reproduces backend failures. `replay(recording)` mocks every tool in a recording so calls with the same arguments return the recorded result, which turns any recording, including one made against the on-device model, into a deterministic fixture. Restoring the original works when the page's API exposes `execute` (the shim does; native builds may not).

## Registration timeline

The recorder timestamps every registration and removal relative to navigation. `timeline()` reports time to first tool, tools that appear only after the load event, and tools that flap:

| Rule                  | Severity | Checks                                                        |
| --------------------- | -------- | ------------------------------------------------------------- |
| `tools-register-late` | warning  | First tool later than `lateMs` (3000) after navigation start. |
| `tools-after-load`    | info     | Tools registered after the load event.                        |
| `tool-churn`          | warning  | A tool unregistered `churnCount` (3) or more times.           |

## Coverage, score, codegen, docs

- **Coverage** counts tools and parameters the recorded calls exercised. The reporter aggregates it across the suite into `coverage.json`.
- **Score** is a 0..100 number with a breakdown: declarations (weight 40) from non-safety lint findings, runtime (30) from smoke findings when a smoke run is supplied, safety (15) from the injection, sensitive-parameter, autosubmit, and exposure rules, and coverage (15). Errors cost 15 points of a category, warnings 5. Categories without input are left out and the rest renormalised.
- **Codegen** renders a Playwright test from the recording, with the `promptApi` fixture's `run(prompt)` for agent-made calls when a prompt is given, and a `toMatchCalls` assertion.
- **Docs** renders a Markdown reference of the tools with parameter tables and example calls; the reporter writes it as `TOOLS.md`.

## Injection scanning

Descriptions are read by every agent that visits a page, and tool results go straight into a model's context. `description-injection` (error) flags instruction overrides, role markers, exfiltration phrasing, and zero-width or bidirectional characters in tool and parameter descriptions. The smoke rule `result-suspicious-content` (warning) applies the same detector to string values in results. The CDP domain marks tool output as untrusted for the same reason.

## Site audit

```sh
npx webmcp-audit https://shop.example --max-pages 20 --smoke --out .webmcp-audit
```

Crawls same-origin links, lints every page, detects tools whose description or schema differ between pages (`cross-page-drift`), and writes `report.json` plus a Markdown report with a per-page and overall agent-readiness score. With `--smoke` it also calls tools with inputs derived from their schemas, as described under [Smoke](#smoke-runtime-checks-from-schemas): only tools annotated read-only by default, every tool with `--all-tools`. The report lists each input that ran with its arguments and outcome, and says so when a page had no read-only tool to call. Exit code 1 when any page failed to load or a finding at or above `--fail-on` (default `error`) exists, 2 on usage errors.

`--header "Authorization: Bearer …"` sends a header with every request, for a protected staging site; anything beyond headers (logins, cookies, storage state) is a job for the Playwright fixture. `--baseline report.json` compares each page's tools with a previous run and reports `contract-changed` and `baseline-page-missing`, so a site without a test suite still learns when its tool surface moves. `--format github` prints one workflow-command annotation per finding and appends the Markdown report to the job summary. `--settle <ms>` waits longer for late registrations, `--executable` and repeatable `--arg` control the browser, `--quiet` suppresses stdout, and `--help` lists everything. The same is available as `audit()` from the `webmcp-audit` package.

## Smoke: runtime checks from schemas

`smoke()` derives inputs from each tool's `inputSchema` and runs them: the required parameters only, all parameters, boundary values (minimum, maximum, maxLength, empty strings and arrays, each enum value), and invalid inputs (missing required, wrong type, out of range, outside enum). Every result is judged:

| Rule                           | Severity | Checks                                                                       |
| ------------------------------ | -------- | ---------------------------------------------------------------------------- |
| `result-error-on-valid-input`  | error    | A schema-valid call threw or reported an error.                              |
| `result-contains-null`         | error    | Result contains `null` anywhere; Chrome's Prompt API rejects it.             |
| `result-not-serializable`      | error    | Result cannot be JSON serialized.                                            |
| `result-undefined`             | warning  | Tool returned nothing.                                                       |
| `result-too-large`             | warning  | Serialized result above `maxResultBytes` (16 KB).                            |
| `result-slow`                  | warning  | Took longer than `maxDurationMs` (5 s).                                      |
| `result-accepts-invalid-input` | warning  | Invalid input was accepted without an error.                                 |
| `result-string-json`           | info     | Returned JSON as a string rather than an object.                             |
| `result-suspicious-content`    | warning  | Result text looks like an instruction to the agent or has hidden characters. |

Smoke runs execute real tools. By default only tools annotated read-only (`readOnlyHint`, or `readOnly` as the CDP domain reports it) are exercised; pass `tools: [...]`, a predicate, or `all: true` to widen it. Every run is recorded as a `SmokeRun` (tool, input kind and label, arguments, result or error, duration); `formatSmokeRuns()` renders them as a Markdown table, which is what `webmcp-audit` puts in its report.

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

| Rule                               | Severity | Scope | Checks                                                                                           |
| ---------------------------------- | -------- | ----- | ------------------------------------------------------------------------------------------------ |
| `tool-name-valid`                  | error    | tool  | Name is 1-128 chars of `[A-Za-z0-9_.-]`.                                                         |
| `description-missing`              | error    | tool  | Imperative tools have a description.                                                             |
| `description-length`               | warning  | tool  | Between `min` (20) and `max` (600) characters.                                                   |
| `param-description-missing`        | warning  | tool  | Every input property has a description.                                                          |
| `schema-shape`                     | error    | tool  | Object schema; `required` entries exist in `properties`.                                         |
| `schema-no-null-literals`          | error    | tool  | No `null` anywhere in the schema (Chrome's Prompt API rejects it).                               |
| `schema-depth`                     | warning  | tool  | Property nesting at most `max` (3) levels.                                                       |
| `schema-unsupported-keywords`      | warning  | tool  | Flags `$ref`, `allOf`, `oneOf`, `anyOf`, `not`, `if`/`then`/`else`, `patternProperties`.         |
| `sensitive-params`                 | warning  | tool  | Parameter names that look like credentials or payment data.                                      |
| `duplicate-tool-name`              | error    | page  | Same name registered more than once across frames.                                               |
| `similar-descriptions`             | warning  | page  | Lexical description similarity above `threshold` (0.7). A `similarity` function can be supplied. |
| `too-many-tools`                   | warning  | page  | More than `max` (20) tools on a page.                                                            |
| `no-tools`                         | info     | page  | Page exposes nothing.                                                                            |
| `iframe-allow-tools`               | info     | page  | Cross-origin frame registers tools but its `<iframe>` lacks `allow="tools"`.                     |
| `declarative-description`          | error    | tool  | `<form toolname>` also has `tooldescription`.                                                    |
| `declarative-field-description`    | warning  | tool  | Each named field has a label or `toolparamdescription`.                                          |
| `declarative-autosubmit-sensitive` | error    | tool  | `toolautosubmit` on forms with password or payment fields.                                       |
| `description-injection`            | error    | tool  | Instructions to the agent, role markers, or hidden characters in descriptions.                   |
| `naming-consistency`               | warning  | page  | Mixed naming styles across tool or parameter names.                                              |
| `exposed-to-secure-origins`        | error    | tool  | `exposedTo` lists an insecure origin.                                                            |

The declarative rules read `<form>` markup: from the page at runtime, or statically from JSX (`<form toolname="...">` in a React component) through the ESLint plugin.

A project that runs the ESLint plugin can keep its Playwright assertion to the page-level rules, so a finding is reported once, where it is fixed: `await expect(webmcp).toPassLint({ scope: "page" })`. Without `scope` the assertion runs everything, which is the right default when there is no static lint.

Configure per rule: `false` disables, a severity string re-levels, an object overrides options.

```ts
await expect(webmcp).toPassLint({
  failOn: "warning",
  rules: { "too-many-tools": { max: 40 }, "similar-descriptions": "error", "no-tools": false },
});
```

Custom rules use `defineRule` from `webmcp-lint` and are passed through `extraRules`; give them `scope: "tool"` when they only read one tool.

## The rules outside Playwright

The same engine runs wherever tool definitions are available.

**In ESLint or oxlint.** `eslint-plugin-webmcp` exposes every tool-scoped rule as `webmcp/<rule-id>`, run statically against the object literals passed to `registerTool()`, `provideContext({ tools })` and `useWebMCP()` from `use-webmcp-tool`, plus any wrapper you name in `settings.webmcp.definitions`, and against `<form toolname>` elements in JSX. A `const` holding the literal is followed. Literal fields are read; computed ones are skipped rather than guessed. The same package loads as an oxlint JS plugin (`"jsPlugins": ["eslint-plugin-webmcp"]`), which the test suite exercises against the real oxlint binary.

```js
// eslint.config.js
import webmcp from "eslint-plugin-webmcp";
export default [
  webmcp.configs.recommended,
  { rules: { "webmcp/description-length": ["warn", { min: 30 }] } },
];
```

**On definitions you already have**, in a unit test of the module that builds your tools, or on the `tools.json` the reporter writes:

```ts
import { lintTools } from "webmcp-lint";

const result = lintTools(myTools, { rules: { "too-many-tools": { max: 40 } } });
expect(result.counts.error).toBe(0);
```

```sh
npx webmcp-lint .webmcp-report/tools.json --fail-on warning
npx webmcp-lint .webmcp-report/tools.json --format github   # one annotation per finding in a GitHub Actions job
```

**With another driver.** `collectFrame` is self-contained and runs in any frame; `snapshotFromFrames()` assembles what the Playwright fixture would have built:

```ts
import { collectFrame, snapshotFromFrames, lint } from "webmcp-lint";

const frames = await Promise.all(page.frames().map((f) => f.evaluate(collectFrame))); // Puppeteer
const result = lint(snapshotFromFrames(frames, { url: page.url() }));
```

## Development

```sh
pnpm install
pnpm run build           # typecheck resolves workspace packages through their built declarations, so build first
pnpm run typecheck
pnpm run test:unit       # webmcp-lint and eslint-plugin-webmcp, node --test
pnpm run test:e2e        # set PW_CHROMIUM=/path/to/chrome to use a specific binary, PW_ARGS for flags
pnpm run test:native     # the same on Google Chrome Beta with --enable-features=WebMCP
pnpm run lint            # eslint-plugin-webmcp on examples/react-shop
pnpm run format          # Prettier; CI runs format:check
pnpm run lint:publish    # publint on every package
```

`examples/demo-site` is the page the Playwright suite runs against. The four packages share one version and are released together with [changesets](.changeset/README.md): add a changeset to your pull request, and the release workflow opens a version pull request whose merge publishes to npm with provenance.

## Recordings and evals

Every recording the fixture makes, whether from `call()`, `smoke()`, the CDP collector, or the Prompt API harness, is a list of `RecordedCall` entries: tool, arguments, result or error, timing, and who made the call. A recording is a useful regression test on its own (`toMatchCalls()` here, `webmcp-evals smoke` in the CLI), and `codegen()` renders one as a Playwright test.

A recording is not an eval, though, and this repository deliberately does not export recordings as eval cases. An eval's value is in an expectation someone chose: `$contains` instead of a literal, `optional: true` on a lookup, an unordered group where order does not matter. Recording `webmcp.call()` invocations only transcribes what the test author typed, and recording one model run only snapshots one nondeterministic trajectory. Write cases by hand and treat them as the source of truth that both Playwright and the CLI consume.

When a recording is a convenient starting point, `toEvalCase()` from `webmcp-lint` turns one into a draft to edit:

```ts
import { writeFileSync } from "node:fs";
import { toEvalCase } from "webmcp-lint";

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

- Pre-1.0. APIs will move, and the WebMCP specification itself is still changing (Chrome 149 runs an origin trial).
- The CDP collector and the fixture are exercised against Google Chrome Beta 154 with `--enable-features=WebMCP` (see [Running on native WebMCP](#running-on-native-webmcp)); the beta channel moves weekly, so the native CI job is informational until the API ships to stable.
- The shim exists for tests only; it is not a production polyfill. Its cross-origin bridge approximates `exposedTo` and `allow="tools"` over `postMessage`; it does not implement `requestUserInteraction` or `toolcanceled`.
- Page-side recording covers executions that go through `modelContext` in the page, including the ones the `promptApi` fixture and `defineAgent()` drivers trigger. Calls driven by Chrome's own built-in agent are only visible through the CDP collector.
- The declarative schema derivation follows the explainer, whose exact algorithm is still marked as TBD.
- The similarity rule is lexical. Embedding-based similarity was considered and left out for now.
- On-device runs need Chrome Canary with the flags above; the fake model covers CI.

## License

Apache-2.0
