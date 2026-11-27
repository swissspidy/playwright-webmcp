---
"@swissspidy/playwright-webmcp": patch
---

Smoke runs no longer miss a write that a read-only tool sends without awaiting it. After each call, the request watch keeps listening until no new request has arrived for 100 ms (at most a second), where it used to stop after one round trip to the page, before the browser's event for a routed request or one on a busy machine could reach Playwright.
