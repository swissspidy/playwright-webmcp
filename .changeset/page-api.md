---
"@swissspidy/playwright-webmcp": minor
---

Everything the fixture, the recorder and the Prompt API harness run in the page now goes through one in-page API facade (`src/page-api.ts`): listing, finding, executing and canceling tools, and decoding `executeTool()` results. Behaviour is unchanged.

Breaking: `runPromptApiInPage` is no longer exported. Use the `promptApi` fixture (`PromptApiHarness`) instead.
