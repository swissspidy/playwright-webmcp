---
"@swissspidy/webmcp-lint": patch
"@swissspidy/playwright-webmcp": patch
"@swissspidy/webmcp-audit": patch
"@swissspidy/eslint-plugin-webmcp": patch
---

Fixes from a pass over the whole repository.

- `@swissspidy/webmcp-lint`: `lint()`, `diffContracts()`, `generateArguments()` and `renderToolDocs()` no longer throw on an `inputSchema` whose property is `null`. A clean page with full coverage scores 100 instead of 99. Lenient `reconcileCalls()` finds the assignment in an unordered group where a loose expectation could take a stricter one's call. Smoke inputs match their labels: no empty string under `minLength`, no "wrong type" that the declared types accept, no string of `maxLength` beyond 100,000 characters. `result-string-json` fires only for a string that encodes an object or an array. The `webmcp-lint` CLI exits 2 on an unknown `--rule` id and on a `tools` entry that is not a tool. Generated code keeps a quote inside an argument key, and `TOOLS.md` keeps a multi-line parameter description on one table row.
- `@swissspidy/webmcp-audit`: with `--smoke`, links are read before tools are called, so a tool that navigates no longer sends the crawl to the wrong page's links. The browser is closed when setup fails. The CLI rejects a URL that is not http(s) and `--max-pages 0`, and creates `--out` before the crawl.
- `@swissspidy/eslint-plugin-webmcp`: a tool-shaped literal that is changed after it is written (`tool.description = ...`) is left alone. `navigation-consequential` no longer takes `args.location.replace()`, a `location` or `history` parameter, or `state.location = ...` for navigation. In JSX forms, a spread on the `<form>` may carry the description, a `<label htmlFor>` outside the form counts, a radio group is one parameter, and an empty `aria-label` is not a label. A null `title` inside `inputSchema` is reported at the schema.
- `@swissspidy/playwright-webmcp`: a `promptApi` run that times out says so in `reason`.
