# webmcp-lint

The engine behind [`playwright-webmcp`](https://www.npmjs.com/package/playwright-webmcp): a plain-JSON snapshot model for a page's [WebMCP](https://github.com/webmachinelearning/webmcp) tools, lint rules that see the whole page, schema-driven smoke checks, tool contracts, coverage and scoring, and the argument matcher and trajectory matcher of Google's [`webmcp-evals`](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/webmcp-evals) CLI. It has no dependencies and runs in Node against a snapshot; the browser-facing part is one self-contained function.

```sh
npm install --save-dev webmcp-lint
```

```ts
import {
  lint,
  formatFindings,
  reconcileCalls,
  matchesArgument,
  defineRule,
  toolHints,
} from "webmcp-lint";

const result = lint(snapshot, { rules: { "too-many-tools": { max: 40 } } });
console.log(formatFindings(result));

// Same semantics as the webmcp-evals CLI:
reconcileCalls(evalCase.expectedCall, calls, { mode: "evals" });
```

| Area               | Exports                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| Snapshot           | `collectFrame` (also `webmcp-lint/collect`), `PageSnapshot`, `ToolSnapshot`, `toolHints` |
| Lint               | `lint`, `formatFindings`, `builtinRules`, `defineRule`                                   |
| Matching           | `matchesArgument`, `reconcileCalls`, `evaluateTrajectory`                                |
| Evals files        | `toEvalCase`, `toToolsSchema`, `EvalCase`, `ExpectedCallNode`                            |
| Runtime checks     | `generateArguments`, `judgeRuns`, `SMOKE_RULES`                                          |
| Contracts and docs | `toContract`, `diffContracts`, `formatChanges`, `renderToolDocs`, `toPlaywrightTest`     |
| Quality signals    | `computeCoverage`, `computeScore`, `judgeTimeline`, `detectInjection`                    |

The rule list, matcher semantics and file formats are documented in the [repository README](https://github.com/swissspidy/playwright-webmcp#readme).
