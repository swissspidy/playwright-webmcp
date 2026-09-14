# webmcp-audit

Crawl a site and audit its [WebMCP](https://github.com/webmachinelearning/webmcp) tools from the outside: lint every page, optionally call the tools with inputs derived from their schemas, detect tools whose description or schema drift between pages, and score agent readiness. Built on [`playwright-webmcp`](https://www.npmjs.com/package/playwright-webmcp), so it works on plain Chromium as well as Chrome with WebMCP enabled. No test suite or code access needed; point it at a URL.

```sh
npx webmcp-audit https://shop.example --max-pages 20 --smoke --out .webmcp-audit
```

```
Usage: webmcp-audit <url> [options]

  --max-pages <n>       Maximum pages to visit (default 10)
  --no-crawl            Audit only <url>; do not follow links
  --smoke               Call tools with inputs derived from each tool's inputSchema
                        (required parameters only, all parameters, boundary values,
                        invalid values) and judge what comes back. Only tools annotated
                        read-only (readOnlyHint) are called unless --all-tools is given;
                        the report lists every input that ran.
  --all-tools           With --smoke: also call tools that are not annotated read-only.
                        These may have side effects (adding to a cart, sending mail).
  --fail-on <severity>  Exit 1 when a finding of this severity or worse exists: error
                        (default), warning, info, or never. Pages that fail to load
                        always exit 1.
  --settle <ms>         Wait this long after load for tools to register (default 500)
  --out <dir>           Output directory (default .webmcp-audit)
  --executable <path>   Chrome/Chromium binary (default: Playwright's, or $PW_CHROMIUM)
  --arg <flag>          Extra browser argument; repeatable
  --quiet               Do not print the Markdown report to stdout
```

Writes `report.json` and `report.md`. Exit code 2 on usage errors. Browser flags go through `--arg`, for example `--arg --enable-features=WebMCP` or `--arg=--enable-features=WebMCP`.

## What `--smoke` runs

Nothing is invented: every input comes from the tool's own `inputSchema`. For each tool the audit generates

- the required parameters only, with a sample value per type (enum first value, `format` aware strings, `minimum` for numbers),
- all parameters,
- boundary values: each number at its `minimum` and `maximum`, strings at `maxLength` and empty, each further enum value, empty arrays,
- invalid inputs: each required parameter missing, each parameter with the wrong type, values outside `enum`, below `minimum`, above `maximum`,

and executes them through the page's `modelContext`, then judges the results (errors on valid input, `null` in results, unserializable or oversized results, slow tools, invalid input accepted silently, instruction-like text in results). The Markdown report has one table row per input with its arguments and outcome, so you can see exactly what was called.

Because these are real executions, only tools that declare `annotations: { readOnlyHint: true }` are called by default. A page with no read-only tools reports zero runs and says so; `--all-tools` calls everything, which on a shop means adding to carts and submitting forms, so use it against staging.

## As a library

```ts
import { audit, renderMarkdown } from "webmcp-audit";

const report = await audit({
  url: "https://shop.example",
  maxPages: 20,
  smoke: true,
  smokeOptions: { tools: ["search_products", "list_reviews"] }, // or { all: true }
});
console.log(renderMarkdown(report));
for (const page of report.pages) console.log(page.url, page.score?.score, page.smoke?.runs.length);
```

`smokeOptions` accepts everything `webmcp.smoke()` does: `tools` (names or a predicate), `all`, `kinds`, `maxBoundary`, `maxInvalid`, `maxResultBytes`, `maxDurationMs`. See the [repository README](https://github.com/swissspidy/playwright-webmcp#readme) for the rules and the score.
