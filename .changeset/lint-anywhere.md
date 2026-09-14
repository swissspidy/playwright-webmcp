---
"webmcp-lint": minor
"playwright-webmcp": minor
"webmcp-audit": minor
"eslint-plugin-webmcp": minor
---

Make the lint engine usable without Playwright, add an ESLint plugin, and make `webmcp-audit --smoke` explain itself.

- `webmcp-lint` gains `lintTools()`, `snapshotFromTools()` and `snapshotFromFrames()`, so the rules run on plain `registerTool()`-style definitions, on a `webmcp-evals` `tools.json`, or on `collectFrame()` results gathered through Puppeteer or any other driver. Every rule declares a `scope` (`"tool"` or `"page"`), and `lint({ scope: "tool" })` runs only the rules a single definition can satisfy.
- New `webmcp-lint` CLI: `npx webmcp-lint tools.json --fail-on warning --rule no-tools=off --format json`.
- New `eslint-plugin-webmcp` package: one ESLint rule per tool-scoped `webmcp-lint` rule (`webmcp/tool-name-valid`, `webmcp/description-injection`, ...), run statically against the literals passed to `registerTool()`, `provideContext()` and `use-webmcp-tool`'s `useWebMCP()`, or to any wrapper named in `settings.webmcp.definitions`; a `const` holding the literal is followed. Ships `recommended` and `all` flat configs, and loads in oxlint as a JS plugin (tested against the real binary). Dynamic fields are skipped rather than guessed.
- The demo site annotates its read-only tools with `readOnlyHint`, so `webmcp.smoke()` and `webmcp-audit --smoke` exercise them by default.
- Verified against native WebMCP in Google Chrome Beta 154 (`--enable-features=WebMCP`), and aligned with what Chrome does: the collector accepts `inputSchema` as a JSON string, `webmcp.call()` and the Prompt API harness send the input as a JSON string first and decode the string result, page hooks and the CDP domain no longer record the same execution twice, and CDP error text is taken from the exception when `errorText` is empty. The shim now rejects duplicate names with `InvalidStateError`, resolves `executeTool()` with a string, fills annotation defaults, derives `<select>` schemas like Chrome, and rejects `"*"` in `fromOrigins`. Mocks take over inside the recorder's execute wrapper instead of re-registering, so they work natively too. `pnpm run test:native` and a CI job run the suites on Chrome Beta.
- `webmcp-audit` gains `--header` for protected sites, `--baseline report.json` (findings `contract-changed` and `baseline-page-missing`), and `--format md|json|github`; `webmcp-lint` gains `--format github`; `toGitHubAnnotations()` renders findings as workflow commands.
- The smoke judge understands MCP `{ content: [...], isError }` results, the shape `use-webmcp-tool` produces.
- `toHaveTool` and `toReachTool` wait for the expect timeout like locator assertions, `webmcp.call()` waits up to `timeoutMs` (5 s) for a tool to be registered and throws `ToolNotFoundError` after that, and `collectFrame()` bounds a `getTools()` that never settles, reporting it as `frame.error` in the snapshot.
- `eslint-plugin-webmcp` lints `<form toolname>` in JSX with the `declarative-*` rules. `examples/react-shop` shows the plugin, `use-webmcp-tool` and the Playwright fixture together.
- `webmcp-audit --smoke` says what it does in `--help`, the Markdown report lists every generated input with its outcome, an empty run explains that no tool is annotated read-only, and `--fail-on <severity>` controls the exit code. `formatSmokeRuns()` from `webmcp-lint` renders the table.
