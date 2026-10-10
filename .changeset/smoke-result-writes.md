---
"@swissspidy/webmcp-lint": minor
"@swissspidy/playwright-webmcp": minor
"@swissspidy/webmcp-audit": minor
---

Smoke reports `result-writes` (error) when a tool that declares `readOnlyHint` sends a request other than GET, HEAD or OPTIONS during the call. `runSmoke()` takes a `SmokeWatch` (`watchPage(page)` for a Playwright page) as its fourth argument; a bare URL getter still works.
