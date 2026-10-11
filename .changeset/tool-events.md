---
"@swissspidy/webmcp-lint": minor
"@swissspidy/playwright-webmcp": minor
"@swissspidy/eslint-plugin-webmcp": minor
---

The fixture records `toolactivated` and `toolcancel` events (`events()`, `waitForEvent()`, and `toolEvents` in `timeline()`), and can cancel calls: `call()` takes a `signal` and `cancelAfter` (milliseconds, or `"activated"`), and `cancel(name)` cancels pending calls, an agent's included when the browser has the CDP `WebMCP` domain. A canceled call rejects with `ToolCanceledError` and is recorded with `canceled: true`.

New ESLint rule `webmcp/consequential-abort-signal` (warning, in `recommended`): a tool that declares `consequentialHint` and waits in its `execute` should read the abort signal it is given, so a canceled call stops instead of carrying out its side effect.
