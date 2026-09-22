# webmcp-lint

The rule engine behind [`playwright-webmcp`](https://www.npmjs.com/package/playwright-webmcp), [`webmcp-audit`](https://www.npmjs.com/package/webmcp-audit) and [`@swissspidy/eslint-plugin-webmcp`](https://www.npmjs.com/package/@swissspidy/eslint-plugin-webmcp): a plain-JSON snapshot model for a page's [WebMCP](https://github.com/webmachinelearning/webmcp) tools, lint rules that see the whole page, schema-driven smoke checks, tool contracts, coverage and scoring, and the argument matcher and trajectory matcher of Google's [`webmcp-evals`](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/webmcp-evals) CLI. No dependencies, no browser required.

```sh
npm install --save-dev webmcp-lint
```

## Lint tool definitions you already have

```ts
import { lintTools, formatFindings } from "webmcp-lint";

const result = lintTools([
  {
    name: "search_products",
    description: "Search the product catalogue by keyword and return matching products.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Keyword" } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
]);
console.log(formatFindings(result));
if (result.counts.error) process.exitCode = 1;
```

`lintTools()` takes an array of `registerTool()`-style objects (extra keys such as `execute` are ignored), a `webmcp-evals` tools file (`{ tools: [...] }`, the `tools.json` the Playwright reporter writes), or a full `PageSnapshot`. Options are the same as `lint()`: per-rule config through `rules`, custom rules through `extraRules`, and `scope: "tool"` to run only the rules a single definition can satisfy.

## Lint from the command line

```sh
npx webmcp-lint .webmcp-report/tools.json
npx webmcp-lint tools.json --fail-on warning --rule no-tools=off --rule 'too-many-tools={"max":40}'
cat snapshot.json | npx webmcp-lint - --format json
```

Exit code 1 when a finding at or above `--fail-on` exists (default `error`), 2 on usage errors. `--scope tool` skips page-level rules, `--url` labels the findings, and `--format github` prints one workflow-command annotation per finding for GitHub Actions.

## Lint a live page with any driver

`collectFrame` is a self-contained function that runs inside a frame and returns that frame's tools and facts. Evaluate it with whatever drives your browser and hand the results to `snapshotFromFrames()`:

```ts
import puppeteer from "puppeteer";
import { collectFrame, snapshotFromFrames, lint, formatFindings } from "webmcp-lint";

const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.goto("https://shop.example/");
const frames = await Promise.all(page.frames().map((frame) => frame.evaluate(collectFrame)));
const snapshot = snapshotFromFrames(frames, { url: page.url() });
console.log(formatFindings(lint(snapshot)));
```

`webmcp-lint/collect` exports `collectFrame` alone for bundling into a page. The browser has to implement WebMCP (`document.modelContext`); see the repository README for how to enable it in Chrome.

## Everything else

| Area               | Exports                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- |
| Snapshot           | `collectFrame`, `snapshotFromFrames`, `snapshotFromTools`, `PageSnapshot`, `ToolSnapshot` |
| Lint               | `lint`, `lintTools`, `formatFindings`, `builtinRules`, `defineRule`, `Rule.scope`         |
| Matching           | `matchesArgument`, `reconcileCalls`, `evaluateTrajectory`                                 |
| Evals files        | `toEvalCase`, `toToolsSchema`, `EvalCase`, `ExpectedCallNode`                             |
| Runtime checks     | `generateArguments`, `judgeRuns`, `formatSmokeRuns`, `SMOKE_RULES`                        |
| Contracts and docs | `toContract`, `diffContracts`, `formatChanges`, `renderToolDocs`, `toPlaywrightTest`      |
| Quality signals    | `computeCoverage`, `computeScore`, `judgeTimeline`, `detectInjection`, `toolHints`        |

```ts
import { reconcileCalls } from "webmcp-lint";

// Same semantics as the webmcp-evals CLI:
reconcileCalls(evalCase.expectedCall, calls, { mode: "evals" });
```

The rule list, matcher semantics and file formats are documented in the [repository README](https://github.com/swissspidy/playwright-webmcp#readme).
