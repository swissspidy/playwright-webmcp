---
"@swissspidy/playwright-webmcp": minor
"@swissspidy/webmcp-lint": minor
---

Breaking: `isReadOnly` is no longer exported from `@swissspidy/playwright-webmcp`; it was a deprecated alias of `isReadOnlyTool` from `@swissspidy/webmcp-lint`.

A rule option that takes one of a fixed set of values now rejects anything else: `tool-name-style` with a `style` it does not know throws from `lint()`, is a usage error in the `webmcp-lint` CLI and fails ESLint's option validation, where it used to report nothing. Rules declare such options with `enums`.

`@swissspidy/webmcp-lint` exports `findingsAtOrAbove()` (what `failOn` and `--fail-on` mean) and `UsageError`.
