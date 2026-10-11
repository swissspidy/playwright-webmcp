# @swissspidy/eslint-plugin-webmcp

## 0.3.0

### Minor Changes

- [#48](https://github.com/swissspidy/playwright-webmcp/pull/48) [`1476e1b`](https://github.com/swissspidy/playwright-webmcp/commit/1476e1b34c8901f94052fbd61846ee3242845388) Thanks [@swissspidy](https://github.com/swissspidy)! - The fixture records `toolactivated` and `toolcancel` events (`events()`, `waitForEvent()`, and `toolEvents` in `timeline()`), and can cancel calls: `call()` takes a `signal` and `cancelAfter` (milliseconds, or `"activated"`), and `cancel(name)` cancels pending calls, an agent's included when the browser has the CDP `WebMCP` domain. A canceled call rejects with `ToolCanceledError` and is recorded with `canceled: true`.
  
  New ESLint rule `webmcp/consequential-abort-signal` (warning, in `recommended`): a tool that declares `consequentialHint` and waits in its `execute` should read the abort signal it is given, so a canceled call stops instead of carrying out its side effect.

### Patch Changes

- Updated dependencies [[`fa14c0b`](https://github.com/swissspidy/playwright-webmcp/commit/fa14c0bf3f23b2c2079ec8f75aedcc80d5694672), [`1476e1b`](https://github.com/swissspidy/playwright-webmcp/commit/1476e1b34c8901f94052fbd61846ee3242845388)]:
  - @swissspidy/webmcp-lint@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies []:
  - @swissspidy/webmcp-lint@0.2.0

## 0.1.0

### Minor Changes

- [#16](https://github.com/swissspidy/playwright-webmcp/pull/16) [`7d0d42e`](https://github.com/swissspidy/playwright-webmcp/commit/7d0d42e4e662c9e84b3e683a4bbdf964fa7f1818) Thanks [@swissspidy](https://github.com/swissspidy)! - Initial release.
  
  - `@swissspidy/webmcp-lint`: the rule engine (tool and page rules, injection scanning, `capability-trifecta`, `tool-shadowing`, `third-party-registration`, and the opt-in `tool-name-style`, `tool-title-missing`, `description-when-to-use` and `annotations-explicit`), `lintTools()`, `snapshotFromFrames()`, a `webmcp-lint` CLI, schema-driven smoke checks, tool contracts, coverage, scoring, codegen, docs, and the `webmcp-evals` argument and trajectory matchers.
  - `@swissspidy/playwright-webmcp`: `test`/`expect` with the `webmcp` fixture (discovery in every frame, `call()`, recording, lint, smoke, contracts, mocks, timeline), the CDP `WebMCP` collector, the `promptApi` fixture on Chromium's Prompt API tool-use protocol, `toolsForAgent()`/`runAgent()`/`toPassEval` for agents you run from Node, and a reporter that writes `tools.json`, `coverage.json` and `TOOLS.md`.
  - `@swissspidy/webmcp-audit`: a crawler and CLI that lints every page, runs smoke calls, detects cross-page drift, compares with a baseline and scores agent readiness.
  - `@swissspidy/eslint-plugin-webmcp`: the tool-scoped rules as ESLint rules for `registerTool()`, `useWebMCP()`, your own wrappers, tool-shaped object literals exported for registration elsewhere, and `<form toolname>` in JSX, plus `valid-event-name`, `no-interpolated-text` and `navigation-consequential`; loads in oxlint.
  
  Every rule has a generated reference page under `docs/rules/`, which is also where a finding's `url` points from the ESLint plugin.
  
  Everything runs against the browser's own WebMCP implementation (`document.modelContext`): Playwright's Chromium with `--enable-features=WebMCP`, or Chrome Beta and Canary.

### Patch Changes

- Updated dependencies [[`7d0d42e`](https://github.com/swissspidy/playwright-webmcp/commit/7d0d42e4e662c9e84b3e683a4bbdf964fa7f1818)]:
  - @swissspidy/webmcp-lint@0.1.0
