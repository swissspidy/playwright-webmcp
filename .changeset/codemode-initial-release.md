---
"@swissspidy/webmcp-codemode": minor
---

First release of `@swissspidy/webmcp-codemode`: code mode for WebMCP. A model writes one script that calls a page's WebMCP tools; the script runs in a QuickJS sandbox in Node and drives Chromium through Playwright, Puppeteer or a CDP session, following the page across navigations and late tool registration. Ships a `webmcp-codemode` MCP server (`webmcp_execute` with the page's API in its description, and `webmcp_api`), the `CodeMode` library API, and an executor compatible with `@cloudflare/codemode`.
