# @swissspidy/webmcp-lint

## 0.1.0

### Minor Changes

- [#16](https://github.com/swissspidy/playwright-webmcp/pull/16) [`7d0d42e`](https://github.com/swissspidy/playwright-webmcp/commit/7d0d42e4e662c9e84b3e683a4bbdf964fa7f1818) Thanks [@swissspidy](https://github.com/swissspidy)! - Initial release.
  
  - `@swissspidy/webmcp-lint`: the rule engine (tool and page rules, injection scanning, `capability-trifecta`, `tool-shadowing`, `third-party-registration`, and the opt-in `tool-name-style`, `tool-title-missing` and `annotations-explicit`), `lintTools()`, `snapshotFromFrames()`, a `webmcp-lint` CLI, schema-driven smoke checks, tool contracts, coverage, scoring, codegen, docs, and the `webmcp-evals` argument and trajectory matchers.
  - `@swissspidy/playwright-webmcp`: `test`/`expect` with the `webmcp` fixture (discovery in every frame, `call()`, recording, lint, smoke, contracts, mocks, timeline), the CDP `WebMCP` collector, the `promptApi` fixture on Chromium's Prompt API tool-use protocol, `toolsForAgent()`/`runAgent()`/`toPassEval` for agents you run from Node, and a reporter that writes `tools.json`, `coverage.json` and `TOOLS.md`.
  - `@swissspidy/webmcp-audit`: a crawler and CLI that lints every page, runs smoke calls, detects cross-page drift, compares with a baseline and scores agent readiness.
  - `@swissspidy/eslint-plugin-webmcp`: the tool-scoped rules as ESLint rules for `registerTool()`, `useWebMCP()`, your own wrappers and `<form toolname>` in JSX, plus `valid-event-name` and `no-interpolated-text`; loads in oxlint.
  
  Every rule has a generated reference page under `docs/rules/`, which is also where a finding's `url` points from the ESLint plugin.
  
  Everything runs against the browser's own WebMCP implementation (`document.modelContext`): Playwright's Chromium with `--enable-features=WebMCP`, or Chrome Beta and Canary.
