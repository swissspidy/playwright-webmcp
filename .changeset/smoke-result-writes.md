---
"@swissspidy/webmcp-lint": minor
"@swissspidy/playwright-webmcp": minor
"@swissspidy/webmcp-audit": minor
---

Smoke reports `result-writes` (error) when a tool that declares `readOnlyHint` sends a request other than GET, HEAD or OPTIONS to the page's origin during the call, and `result-writes-cross-origin` (warning) when the request goes to another origin. `firstPartyOrigins` (`--first-party-origin` in the audit CLI) marks a backend on another host as the site's own. `runSmoke()` takes a `SmokeWatch` (`watchPage(page)` for a Playwright page) as its fourth argument; a bare URL getter still works. Requests the page sends on its own, such as analytics, can be left out with `ignoreRequests` (URL globs, regular expressions or a predicate that also gets the request body), or `--ignore-request <glob>` in the audit CLI.
