---
"@swissspidy/webmcp-lint": patch
"@swissspidy/playwright-webmcp": patch
---

`lint()` no longer throws on an `inputSchema` whose property is `null` (`schema-no-null-literals` and `param-description-missing` report it instead), and `properties` given as an array is not read as parameters. Smoke's `result-string-json` fires only for a string that encodes an object or an array, not for text such as `"42"` or `"true"`. A `promptApi` run that times out now says so in `reason`.
