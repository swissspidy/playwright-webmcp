---
"@swissspidy/eslint-plugin-webmcp": minor
---

Angular's WebMCP APIs are definition sites out of the box: each tool in `provideExperimentalWebMcpTools([...])`, the tool passed to `declareExperimentalWebMcpTool()`, and the `experimentalWebMcpTool` option of Signal Forms' `form()`. A form tool's input schema, title and annotations come from Angular, so findings about them are not reported for it.

Definition sites in `settings.webmcp.definitions` take an array of tools as their argument, a `property` that holds one tool on an options object (searched in every argument unless `argument` is given), and `derived`, the fields a framework fills in at that site.
