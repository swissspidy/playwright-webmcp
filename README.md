# playwright-webmcp

Testing tools for [WebMCP](https://github.com/webmachinelearning/webmcp) tool surfaces: a lint engine that understands the whole page, a Playwright fixture with matchers and call recording, and a reporter that turns recorded scenarios into cases for Google's [`webmcp-evals`](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/webmcp-evals) CLI.

The shape is deliberately the same as axe-core: one engine that inspects the live page, thin adapters around it.

| Package                                              | What it is                                                                                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`webmcp-lint`](packages/core)                       | Snapshot model, rules, `lint()`, the `webmcp-evals` argument matcher, and a trajectory matcher with the CLI's exact semantics plus a lenient mode. Runs in Node against a snapshot. |
| [`playwright-webmcp`](packages/playwright)           | `test`/`expect` with a `webmcp` fixture: discover tools in every frame, call them, record calls, lint, and record scenarios. Ships a test-time shim so it runs on any Chromium.     |
| [`playwright-webmcp-evals`](packages/evals-reporter) | Playwright reporter that writes `evals.json`, `tools.json`, `coverage.json` and `TOOLS.md` from recorded scenarios and calls.                                                       |
| [`webmcp-audit`](packages/audit)                     | CLI and library that crawls a site, lints and smokes every page, detects cross-page drift, and scores agent readiness.                                                              |

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

Pair a prompt with the calls it should produce and the reporter exports it as a `webmcp-evals` case. The calls can come from an agent run, which is where a recording earns its keep, or from `webmcp.call()` when you are pinning down a trajectory by hand:

```ts
await webmcp.promptApi.useFake({
  turns: [
    {
      calls: [
        { name: "search_products", args: { query: "red shirt" } },
        { name: "add_to_cart", args: { productId: 1, quantity: 2 } },
      ],
    },
  ],
});
await page.goto("/");
await webmcp.scenario(
  { name: "add two shirts", prompt: "Add two red shirts to my cart", argumentsMode: "types" },
  async () => {
    await webmcp.promptApi.run("Add two red shirts to my cart");
  },
);
```

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [["list"], ["playwright-webmcp-evals", { outputDir: ".webmcp-evals" }]],
});
```

```sh
npx webmcp-evals browser -u http://localhost:3000 -e .webmcp-evals/evals.json
npx webmcp-evals local -t .webmcp-evals/tools.json -e .webmcp-evals/evals.json
npx webmcp-evals smoke -u http://localhost:3000 -e .webmcp-evals/evals.json   # replays the calls without a model
```

## The fixture

`webmcp` is available in every test. Before navigation it installs two init scripts:

- a **shim** implementing `document.modelContext` (also mirrored on `navigator.modelContext`) with `registerTool` including `signal` and `exposedTo`, `getTools` including `fromOrigins`, `executeTool`, `toolchange`, and declarative `<form toolname>` tools with `SubmitEvent.respondWith` and `toolautosubmit`. The pre-spec `unregisterTool`, `provideContext` and `clearContext` are kept for pages written against older explainers. It only activates when the browser has no native WebMCP, so the same tests run on plain Chromium in CI and on Chrome with WebMCP enabled (`chrome://flags/#enable-webmcp-testing`, or the Chrome 149 origin trial).
- a **recorder** that wraps registration and execution so calls made by page scripts or in-page agents are captured.

| Method                                                  | Purpose                                                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `snapshot()`                                            | Tools and frame facts from every frame, including cross-origin ones (Playwright can evaluate there). |
| `tools()`, `tool(name)`                                 | Convenience accessors.                                                                               |
| `call(name, args)`                                      | Execute a tool wherever it lives and record the call.                                                |
| `calls()`, `clearCalls()`                               | Recorded calls in execution order, with `via: "fixture" \| "api"`.                                   |
| `lint(options)`                                         | Run the rules; the result is attached to the test.                                                   |
| `smoke(options)`                                        | Generate inputs from each tool's schema, execute them, and judge the results.                        |
| `contract()`, `matchToolContract(name?)`                | The page's tool contract, and a comparison against the stored one.                                   |
| `scenario(options, body)`                               | Record the calls `body` makes as an eval case and attach it.                                         |
| `settle()`                                              | Wait until calls reported by page scripts have reached the recorder.                                 |
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
| `toHaveTool(name, { description?, inputSchema?, source? })`  | `webmcp` or `page`           | `inputSchema` uses subset matching, so partial schemas work.        |
| `toPassLint({ failOn?, rules?, extraRules? })`               | `webmcp` or `page`           | `failOn` defaults to `"error"`.                                     |
| `toPassSmoke({ tools?, all?, kinds?, failOn?, ...budgets })` | `webmcp` or `page`           | Runtime findings from generated inputs.                             |
| `toMatchToolContract(name?)`                                 | `webmcp` or `page`           | Compares against the stored contract; honours `--update-snapshots`. |
| `toReachTool(name, { from? })`                               | `webmcp` or `page`           | Reachability through the API from a frame.                          |
| `toHaveToolCoverage(min)`                                    | `webmcp` or `page`           | Fraction (0..1) or percent of tools called.                         |
| `toHaveAgentReadinessScore(min, { smoke? })`                 | `webmcp` or `page`           | Score at least `min`.                                               |
| `toRegisterToolsWithin(ms)`                                  | `webmcp` or `page`           | Time to first tool registration.                                    |
| `toHaveCalledTool(name, args?)`                              | `webmcp` or `RecordedCall[]` | `args` accepts the evals constraint operators.                      |
| `toMatchCalls(expectedCall, { strict? })`                    | `webmcp` or `RecordedCall[]` | Full trajectory check with `ordered`, `unordered`, `optional`.      |

### Argument matching

Same operators and semantics as `webmcp-evals`: `$pattern` (with `(?i)` style inline flags), `$contains`, `$gt`, `$gte`, `$lt`, `$lte`, `$type`, `$any`. Objects match as subsets, arrays positionally with equal length.

Trajectory matching comes in two modes, because a Playwright assertion and an eval case want different things:

- **Lenient** (default for `toMatchCalls()`): the expectation is a subsequence of what happened. The top level list is ordered, `{ unordered: [...] }` groups may match in any order, `optional: true` calls may be absent, and extra actual calls are tolerated unless `strict` is set. Good for "the agent did at least this".
- **`mode: "evals"`** (default for `promptApi.evaluate()` and `toPassEval()`): a port of the CLI's own algorithm. Calls are matched positionally, an unordered group draws from a pool of exactly its size, and every actual call the expectation does not explain fails the case. A case that passes here passes in `webmcp-evals`, and vice versa. `evaluateTrajectory()` returns the same per-call rows the CLI reports.

## On-device model runs

`webmcp.promptApi` drives Chrome's Prompt API (`LanguageModel`) inside the page, offering the page's WebMCP tools to the model the way an in-page agent would. Tool results go back to the model as JSON strings with nulls stripped, which is what Chrome accepts.

```ts
test("model can add to cart", async ({ page, webmcp }) => {
  await page.goto("/");
  test.skip(
    (await webmcp.promptApi.availability()) === "unavailable",
    "needs Chrome with the Prompt API",
  );

  const result = await webmcp.promptApi.run("Add two red shirts to my cart");
  expect(result.status).toBe("ok");
  expect(webmcp).toHaveCalledTool("add_to_cart", { quantity: { $gte: 2 } });

  // Or run a recorded evals case straight against the on-device model:
  await expect(webmcp).toPassEval(evalCase);
});
```

| Method                                                              | Purpose                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `exists()`                                                          | Whether `LanguageModel` is defined.                                                         |
| `availability()`                                                    | `LanguageModel.availability()` for a tool-using session.                                    |
| `run(prompt \| { prompts, systemPrompt?, toolNames?, timeoutMs? })` | One session, prompts sent in order. Calls the model makes are recorded with `via: "agent"`. |
| `evaluate(evalCase, { strict? })`                                   | Send the case's user messages and reconcile the calls against `expectedCall`.               |
| `useFake(plan)`                                                     | Install a scripted `LanguageModel` before navigation for deterministic CI runs.             |

### Running against a real model

Playwright launches Chrome with a fresh profile, so settings made in `chrome://flags` do not apply. Launch Chrome Canary yourself with the flags enabled in its profile and a DevTools port, then point the tests at it:

1. In Chrome Canary enable `#optimization-guide-on-device-model`, `#prompt-api-for-gemini-nano`, `#prompt-api-tool-use`, and `#webmcp-for-testing`, then restart. Wait for the on-device model to finish downloading (check `chrome://components`).
2. Start it with `--remote-debugging-port=9222`.
3. Run `WEBMCP_CDP=http://localhost:9222 npx playwright test`.

With `WEBMCP_CDP` set the fixture connects over CDP instead of launching a browser. Tests that need the model call `test.skip()` when `availability()` is `"unavailable"`, so the same suite runs everywhere.

### Deterministic agent tests

```ts
await webmcp.promptApi.useFake({
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

The fake honours `tools`, `initialPrompts`, `inputQuota`, and can simulate a build without tool use via `rejectTools: true`. It exists to test your harness and tool wiring, not the model.

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
- **Codegen** renders a Playwright test from the recording, with `promptApi.run(prompt)` for agent-made calls when a prompt is given, and a `toMatchCalls` assertion.
- **Docs** renders a Markdown reference of the tools with parameter tables and example calls; the reporter writes it as `TOOLS.md`.

## Injection scanning

Descriptions are read by every agent that visits a page, and tool results go straight into a model's context. `description-injection` (error) flags instruction overrides, role markers, exfiltration phrasing, and zero-width or bidirectional characters in tool and parameter descriptions. The smoke rule `result-suspicious-content` (warning) applies the same detector to string values in results. The CDP domain marks tool output as untrusted for the same reason.

## Site audit

```sh
npx webmcp-audit https://shop.example --max-pages 20 --smoke --out .webmcp-audit
```

Crawls same-origin links, lints every page, optionally runs smoke on read-only tools (`--all-tools` widens it), detects tools whose description or schema differ between pages (`cross-page-drift`), and writes `report.json` plus a Markdown report with a per-page and overall agent-readiness score. Exit code 1 when any error-level finding exists, 2 on usage errors. `--settle <ms>` waits longer for late registrations, `--executable` and repeatable `--arg` control the browser, `--quiet` suppresses the Markdown on stdout, and `--help` lists everything. The same is available as `audit()` from the `webmcp-audit` package.

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

Smoke runs execute real tools. By default only tools annotated read-only (`readOnlyHint`, or `readOnly` as the CDP domain reports it) are exercised; pass `tools: [...]`, a predicate, or `all: true` to widen it.

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

Rules see the whole page: every frame, declarative forms, and all tools together. That is why this is not an ESLint plugin.

| Rule                               | Severity | Checks                                                                                           |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `tool-name-valid`                  | error    | Name is 1-128 chars of `[A-Za-z0-9_.-]`.                                                         |
| `description-missing`              | error    | Imperative tools have a description.                                                             |
| `description-length`               | warning  | Between `min` (20) and `max` (600) characters.                                                   |
| `param-description-missing`        | warning  | Every input property has a description.                                                          |
| `schema-shape`                     | error    | Object schema; `required` entries exist in `properties`.                                         |
| `schema-no-null-literals`          | error    | No `null` anywhere in the schema (Chrome's Prompt API rejects it).                               |
| `schema-depth`                     | warning  | Property nesting at most `max` (3) levels.                                                       |
| `schema-unsupported-keywords`      | warning  | Flags `$ref`, `allOf`, `oneOf`, `anyOf`, `not`, `if`/`then`/`else`, `patternProperties`.         |
| `sensitive-params`                 | warning  | Parameter names that look like credentials or payment data.                                      |
| `duplicate-tool-name`              | error    | Same name registered more than once across frames.                                               |
| `similar-descriptions`             | warning  | Lexical description similarity above `threshold` (0.7). A `similarity` function can be supplied. |
| `too-many-tools`                   | warning  | More than `max` (20) tools on a page.                                                            |
| `no-tools`                         | info     | Page exposes nothing.                                                                            |
| `iframe-allow-tools`               | info     | Cross-origin frame registers tools but its `<iframe>` lacks `allow="tools"`.                     |
| `declarative-description`          | error    | `<form toolname>` also has `tooldescription`.                                                    |
| `declarative-field-description`    | warning  | Each named field has a label or `toolparamdescription`.                                          |
| `declarative-autosubmit-sensitive` | error    | `toolautosubmit` on forms with password or payment fields.                                       |
| `description-injection`            | error    | Instructions to the agent, role markers, or hidden characters in descriptions.                   |
| `naming-consistency`               | warning  | Mixed naming styles across tool or parameter names.                                              |
| `exposed-to-secure-origins`        | error    | `exposedTo` lists an insecure origin.                                                            |

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
pnpm run test:e2e        # set PW_CHROMIUM=/path/to/chrome to use a specific binary
pnpm run format          # Prettier; CI runs format:check
pnpm run lint:publish    # publint on every package
```

`examples/demo-site` is the page the Playwright suite runs against. The four packages share one version and are released together with [changesets](.changeset/README.md): add a changeset to your pull request, and the release workflow opens a version pull request whose merge publishes to npm with provenance.

## Turning recorded usage into evals

Every recording the fixture makes, whether from `scenario()`, `smoke()`, the CDP collector, or the Prompt API harness, is a list of `RecordedCall` entries: tool, arguments, result or error, timing, and who made the call. That is most of an evals case. What a recording lacks is the user request that led to it, because agents never tell the page what the user asked.

`scenario({ prompt }, body)` closes that gap by pairing a prompt with the calls `body` produces, and it is worth being clear about what that does and does not give you:

- **When `body` drives an agent** (`promptApi.run()`, or a real agent observed through CDP), the trajectory is model-produced and the prompt is known. Exporting that as a case, reviewing it, and replaying it with `webmcp-evals` or `toPassEval()` turns one good run into a regression test. This is the use the feature is designed for.
- **When `body` calls tools by hand**, the case is a transcription of what you typed. It is validated against the live page, which a hand-written `evals.json` is not, and it captures `tools.json` for free, but the expectation is only as good as your guess at what an agent would do. Prefer `argumentsMode: "types"` or edit the exported arguments into constraints (`{ $contains: "shirt" }`) before treating exact literals as the expected behaviour, since a model will rarely reproduce `query: "red"` verbatim.
- **Without a prompt**, a recording is still a regression test: the CLI's `smoke` mode and `toMatchCalls()` replay and reconcile trajectories without a model. Inferring a prompt from a trajectory with a model is possible but the output needs review, so it stays a script in your repository rather than a feature here.

`codegen()` is the inverse direction: a recording, agent-made or not, rendered as a Playwright test that reproduces it.

## Relationship to Lighthouse and DevTools

Chrome reports declarative form problems as DevTools issues (missing tool name or description, parameters without a name, title or description), and Lighthouse has audits for form coverage, schema validity of declarative tools, and a listing of registered tools. The declarative rules here overlap with those on purpose so a Playwright suite can fail a pull request on the same findings. The imperative rules, page-level rules, smoke runs, contracts, and on-device runs have no Lighthouse counterpart.

## Status and limits

- Pre-1.0. APIs will move, and the WebMCP specification itself is still changing (Chrome 149 runs an origin trial).
- The CDP collector is written against the `WebMCP` domain in `devtools-protocol` and unit tested with a scripted session, but has not yet been exercised against a real Chrome build that ships the domain.
- The shim exists for tests only; it is not a production polyfill. Its cross-origin bridge approximates `exposedTo` and `allow="tools"` over `postMessage`; it does not implement `requestUserInteraction`, `toolcanceled`, or the `content` array result shape the specification describes.
- Page-side recording covers executions that go through `modelContext` in the page, including the ones `webmcp.promptApi` triggers. Calls driven by Chrome's own built-in agent are only visible through the CDP collector.
- The declarative schema derivation follows the explainer, whose exact algorithm is still marked as TBD.
- The similarity rule is lexical. Embedding-based similarity was considered and left out for now.
- On-device runs need Chrome Canary with the flags above; the fake model covers CI.

## License

Apache-2.0
