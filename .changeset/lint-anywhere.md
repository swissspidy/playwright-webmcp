---
"webmcp-lint": minor
"playwright-webmcp": minor
"webmcp-audit": minor
"eslint-plugin-webmcp": minor
---

Make the lint engine usable without Playwright, add an ESLint plugin, and make `webmcp-audit --smoke` explain itself.

- `webmcp-lint` gains `lintTools()`, `snapshotFromTools()` and `snapshotFromFrames()`, so the rules run on plain `registerTool()`-style definitions, on a `webmcp-evals` `tools.json`, or on `collectFrame()` results gathered through Puppeteer or any other driver. Every rule declares a `scope` (`"tool"` or `"page"`), and `lint({ scope: "tool" })` runs only the rules a single definition can satisfy.
- New `webmcp-lint` CLI: `npx webmcp-lint tools.json --fail-on warning --rule no-tools=off --format json`.
- New `eslint-plugin-webmcp` package: one ESLint rule per tool-scoped `webmcp-lint` rule (`webmcp/tool-name-valid`, `webmcp/description-injection`, ...), run statically against `registerTool()` and `provideContext()` literals, with `recommended` and `all` flat configs. Dynamic fields are skipped rather than guessed.
- `webmcp-audit --smoke` says what it does in `--help`, the Markdown report lists every generated input with its outcome, an empty run explains that no tool is annotated read-only, and `--fail-on <severity>` controls the exit code. `formatSmokeRuns()` from `webmcp-lint` renders the table.
