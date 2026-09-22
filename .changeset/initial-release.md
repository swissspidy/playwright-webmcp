---
"webmcp-lint": minor
"playwright-webmcp": minor
"webmcp-audit": minor
"@swissspidy/eslint-plugin-webmcp": minor
---

Initial release.

- `webmcp-lint`: the rule engine (tool and page rules, injection scanning, `capability-trifecta`, `tool-shadowing`, `third-party-registration`), `lintTools()`, `snapshotFromFrames()`, a `webmcp-lint` CLI, schema-driven smoke checks, tool contracts, coverage, scoring, codegen, docs, and the `webmcp-evals` argument and trajectory matchers.
- `playwright-webmcp`: `test`/`expect` with the `webmcp` fixture (discovery in every frame, `call()`, recording, lint, smoke, contracts, mocks, timeline), the CDP `WebMCP` collector, the `promptApi` fixture on Chromium's Prompt API tool-use protocol, `toolsForAgent()`/`runAgent()`/`toPassEval` for agents you run from Node, and a reporter that writes `tools.json`, `coverage.json` and `TOOLS.md`.
- `webmcp-audit`: a crawler and CLI that lints every page, runs smoke calls, detects cross-page drift, compares with a baseline and scores agent readiness.
- `@swissspidy/eslint-plugin-webmcp`: the tool-scoped rules as ESLint rules for `registerTool()`, `useWebMCP()`, your own wrappers and `<form toolname>` in JSX, plus `no-interpolated-text`; loads in oxlint.

Everything runs against the browser's own WebMCP implementation (`document.modelContext`): Playwright's Chromium with `--enable-features=WebMCP`, or Chrome Beta and Canary.
