# webmcp-audit

## 0.2.0

### Minor Changes

- [#1](https://github.com/swissspidy/playwright-webmcp/pull/1) [`39bf15a`](https://github.com/swissspidy/playwright-webmcp/commit/39bf15a38d46d20d64647035097c70fa98ce270d) Thanks [@swissspidy](https://github.com/swissspidy)! - Align with the WebMCP specification and the `webmcp-evals` CLI, and prepare the packages for npm.
  
  - `reconcileCalls()` gains `mode: "evals"`, a port of the CLI's positional trajectory matcher; `promptApi.evaluate()` and `toPassEval()` use it by default. `evaluateTrajectory()` exposes the per-call rows.
  - Annotations are read through `toolHints()`, which accepts both `readOnlyHint`/`consequentialHint`/`untrustedContentHint` and the CDP domain's `readOnly`/`consequential`/`untrustedContent`/`autosubmit`.
  - Tool `title` is collected, included in contracts (`title-changed`) and rendered in docs.
  - `shimSource({ force })` replaces the string surgery behind `shim: "always"`; `webmcp.settle()` waits for page-side call reports to arrive.
  - `webmcp.scenario()` and the `playwright-webmcp-evals` package are gone. Eval cases are authored files that Playwright runs with `toPassEval()`; `toEvalCase()` from `webmcp-lint` still turns a recording into a first draft. Suite-wide `tools.json`, `coverage.json` and `TOOLS.md` come from the `playwright-webmcp/reporter` reporter.
  - `webmcp-audit` parses arguments with `parseArgs`, adds `--settle`, `--quiet` and `--help`, and exits 2 on usage errors.
  - Published output is flat (`dist/index.js`); `isReadOnly` from `playwright-webmcp` is deprecated in favour of `isReadOnlyTool` from `webmcp-lint`.

### Patch Changes

- Updated dependencies [[`39bf15a`](https://github.com/swissspidy/playwright-webmcp/commit/39bf15a38d46d20d64647035097c70fa98ce270d)]:
  - webmcp-lint@0.2.0
  - playwright-webmcp@0.2.0
