# webmcp-audit

Crawl a site and audit its [WebMCP](https://github.com/webmachinelearning/webmcp) tools from the outside: lint every page, optionally call the tools with inputs derived from their schemas, detect tools whose description or schema drift between pages, and score agent readiness. Built on [`playwright-webmcp`](https://www.npmjs.com/package/playwright-webmcp). No test suite or code access needed; point it at a URL.

```sh
npm install --save-dev webmcp-audit @playwright/test
npx playwright install chromium
npx webmcp-audit https://shop.example --max-pages 20 --smoke --out .webmcp-audit
```

The browser has to implement WebMCP. Playwright's Chromium does behind a flag, which the audit passes on its own (`--enable-features=WebMCP`); `--executable` points it at another build, such as Chrome Beta or Canary.

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
  --baseline <file>     A previous report.json; report tools whose description, schema
                        or annotations changed on a page since then (contract-changed)
  --header <name: value>
                        HTTP header sent with every request to the audited origin
                        (not to third-party frames or resources), e.g. an
                        Authorization header for a protected staging site; repeatable
  --settle <ms>         Wait this long after load for tools to register, then for the
                        tool list to hold still for as long again (default 500)
  --out <dir>           Output directory (default .webmcp-audit)
  --format <format>     What to print: md (default, the Markdown report), json (the
                        report), or github (one workflow-command annotation per
                        finding; also appends the Markdown to $GITHUB_STEP_SUMMARY)
  --executable <path>   Chrome/Chromium binary (default: Playwright's Chromium, or $PW_CHROMIUM).
                        The browser has to implement WebMCP; --enable-features=WebMCP is
                        always passed, which turns it on in Chromium builds that carry it
  --arg <flag>          Extra browser argument; repeatable
  --quiet               Do not print the report to stdout
```

Writes `report.json` and `report.md`. Exit code 2 on usage errors. Further browser flags go through `--arg`, for example `--arg --enable-experimental-web-platform-features` or `--arg=--enable-experimental-web-platform-features`.

## What `--smoke` runs

Nothing is invented: every input comes from the tool's own `inputSchema`. For each tool the audit generates

- the required parameters only, with a sample value per type (enum first value, `format` aware strings, `minimum` for numbers),
- all parameters,
- boundary values: each number at its `minimum` and `maximum`, strings at `maxLength` and empty, each further enum value, empty arrays,
- invalid inputs: each required parameter missing, each parameter with the wrong type, values outside `enum`, below `minimum`, above `maximum`,

and executes them through the page's `modelContext`, then judges the results (errors on valid input, `null` in results, unserializable or oversized results, slow tools, invalid input accepted silently, instruction-like text in results). The Markdown report has one table row per input with its arguments and outcome, so you can see exactly what was called.

Because these are real executions, only tools that declare `annotations: { readOnlyHint: true }` are called by default. A page with no read-only tools reports zero runs and says so; `--all-tools` calls everything, which on a shop means adding to carts and submitting forms, so use it against staging.

## On CI

```yaml
- run: npx webmcp-audit https://staging.shop.example --smoke --format github --fail-on warning --header "Authorization: Bearer ${{ secrets.STAGING_TOKEN }}" --baseline audit-baseline/report.json
```

Findings become annotations on the run, the Markdown report lands in the job summary, and `--baseline` turns a stored `report.json` from an earlier run into a contract: a tool whose description, schema or annotations changed on a page reports `contract-changed`, a page that disappeared reports `baseline-page-missing`. Logins, cookies and storage state are out of scope here; use the `playwright-webmcp` fixture for those.

To audit with another Chrome build, for example the current beta: `--executable /opt/google/chrome-beta/chrome`.

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
