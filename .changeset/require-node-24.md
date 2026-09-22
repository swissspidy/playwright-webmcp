---
"webmcp-lint": minor
"playwright-webmcp": minor
"webmcp-audit": minor
"eslint-plugin-webmcp": minor
---

Require Node 24 or newer.

Node 22 is in maintenance until April 2027 and Node 24 (`Krypton`) is the active LTS, so `engines.node` moves from `>=20` to `>=24` across the four packages and `.node-version` follows. The CI matrix runs the end-to-end suites on 24 and 26 rather than 22 and 24.
