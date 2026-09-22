---
"webmcp-lint": minor
"playwright-webmcp": minor
"webmcp-audit": minor
"eslint-plugin-webmcp": minor
---

Require Node 24 or newer.

Node 22 is in maintenance until April 2027 and Node 24 (`Krypton`) is the active LTS, so `engines.node` moves from `>=20` to `>=24` across the four packages and `.node-version` follows. `@types/node` moves to `^24` so the types match the runtime the packages now ask for, and the CI matrix runs the end-to-end suites on 24 and 26 rather than 22 and 24.

Dropping Node 22 also settles the npm version question for npm's trusted publishing: Node 24 ships npm 11.19, past the 11.5.1 that trusted publishing needs, so the release workflow does not have to upgrade npm before it publishes.
