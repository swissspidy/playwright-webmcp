---
"@swissspidy/playwright-webmcp": minor
"@swissspidy/webmcp-lint": minor
---

`toHaveTool` and `toPassLint` accept Playwright's own `page.webmcp` and `frame.webmcp` (Playwright 1.64 and later). The README compares the native API with the `webmcp` fixture.

Breaking: Chrome and Chromium 154 and earlier are no longer supported. `executeTool()` input is always sent as an object, `inputSchema` and annotations returned as JSON strings are no longer parsed, and `webmcp.inputShape()`, `executeToolInputShape()`, `chromiumMajor()` and the `ExecuteToolInputShape` type are removed.
