# playwright-webmcp-evals

Playwright reporter that collects scenarios recorded with `webmcp.scenario()` and writes `evals.json`, `tools.json` and `index.json` in the formats consumed by the `webmcp-evals` CLI. See the [repository README](../../README.md).

```ts
reporter: [["list"], ["playwright-webmcp-evals", { outputDir: ".webmcp-evals" }]],
```
