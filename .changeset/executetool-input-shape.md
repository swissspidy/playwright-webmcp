---
"webmcp-lint": patch
"playwright-webmcp": patch
"webmcp-audit": patch
"eslint-plugin-webmcp": patch
---

Send `executeTool` input as an object, and fall back to the JSON string.

Chrome Beta 155 rejects the JSON-string input that 154 required: `TypeError: Failed to execute 'executeTool' on 'ModelContext': invalid input object: value is not an object`. The fixture already carried a string-first, object-fallback pair for exactly this, but the fallback was gated on the 154 message (`/parse input/i`), which 155's wording does not match, so the object was never tried and every call through `WebMCP.call()` and the `promptApi` harness failed on 155.

The object now goes first, with the string as the fallback, and the guard recognises both browsers' wording. Whichever shape is wrong is refused while arguments are validated, before the tool runs, so the retry cannot execute a tool twice — an error from the tool itself is still rethrown on the first attempt, which is now covered by a test. The four tests that drove `modelContext` directly did not have a fallback at all; they share one through `tests/helpers.ts`.
