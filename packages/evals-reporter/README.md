# playwright-webmcp-evals

A Playwright reporter for suites that use [`playwright-webmcp`](https://www.npmjs.com/package/playwright-webmcp). It collects the scenarios and calls the fixture attaches to each test and writes, into `outputDir` (default `.webmcp-evals`):

| File            | Contents                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evals.json`    | One [`webmcp-evals`](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/webmcp-evals) case per `webmcp.scenario()`, named after the test. |
| `tools.json`    | Merged tool schemas in the CLI's `local` mode format.                                                                                             |
| `index.json`    | Which page each case was recorded on.                                                                                                             |
| `coverage.json` | Tool and parameter coverage across the whole suite.                                                                                               |
| `TOOLS.md`      | Markdown reference of every tool the suite saw, with example calls.                                                                               |

```sh
npm install --save-dev playwright-webmcp-evals
```

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [
    ["list"],
    ["playwright-webmcp-evals", { outputDir: ".webmcp-evals", prefixWithTestTitle: true }],
  ],
});
```

```sh
npx webmcp-evals browser -u http://localhost:3000 -e .webmcp-evals/evals.json
npx webmcp-evals local -t .webmcp-evals/tools.json -e .webmcp-evals/evals.json
npx webmcp-evals smoke -u http://localhost:3000 -e .webmcp-evals/evals.json
```

Add the output directory to `.gitignore`; it changes on every run. See the [repository README](https://github.com/swissspidy/playwright-webmcp#readme) for how scenarios are recorded and when a recorded trajectory makes a good eval.
