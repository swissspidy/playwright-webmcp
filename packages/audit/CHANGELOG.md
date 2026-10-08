# @swissspidy/webmcp-audit

## 0.2.0

### Minor Changes

- [#34](https://github.com/swissspidy/playwright-webmcp/pull/34) [`0f5270b`](https://github.com/swissspidy/playwright-webmcp/commit/0f5270b4de551750fb1a2103fb2937eb248f37c3) Thanks [@swissspidy](https://github.com/swissspidy)! - Drop the agent-readiness score from the audit. `AuditReport.score` and `PageAudit.score` are gone, and the Markdown report and CLI progress no longer print a score. Lighthouse's Agentic Browsing category now scores a page's WebMCP setup; the audit focuses on what a single-page report does not cover: calling tools, cross-page drift, baseline comparisons, and every frame against the full rule set. `computeScore()` and `toHaveAgentReadinessScore()` in the other packages are unchanged.

### Patch Changes

- Updated dependencies []:
  - @swissspidy/webmcp-lint@0.2.0
  - @swissspidy/playwright-webmcp@0.2.0

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
  - @swissspidy/playwright-webmcp@0.1.0
