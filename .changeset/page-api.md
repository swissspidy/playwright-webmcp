---
"@swissspidy/playwright-webmcp": minor
---

Everything the fixture, the recorder and the Prompt API harness run in the page now goes through one in-page API facade (`src/page-api.ts`): listing, finding, executing and canceling tools, and decoding `executeTool()` results. Behaviour is unchanged.

Breaking: `runPromptApiInPage` takes the page API as its first argument, so run it with `inPage(page, runPromptApiInPage, options)` instead of `page.evaluate(runPromptApiInPage, options)`. `inPage` and the `PageApi` type are new exports.
