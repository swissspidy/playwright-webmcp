# webmcp-audit

Crawl a site and audit its [WebMCP](https://github.com/webmachinelearning/webmcp) tools from the outside: lint every page, optionally run schema-driven smoke calls against read-only tools, detect tools whose description or schema drift between pages, and score agent readiness. Built on [`playwright-webmcp`](https://www.npmjs.com/package/playwright-webmcp), so it works on plain Chromium as well as Chrome with WebMCP enabled.

```sh
npx webmcp-audit https://shop.example --max-pages 20 --smoke --out .webmcp-audit
```

```
Usage: webmcp-audit <url> [options]

  --max-pages <n>       Maximum pages to visit (default 10)
  --no-crawl            Audit only <url>; do not follow links
  --smoke               Execute generated inputs against read-only tools
  --all-tools           With --smoke: execute every tool, including ones with side effects
  --settle <ms>         Wait this long after load for tools to register (default 500)
  --out <dir>           Output directory (default .webmcp-audit)
  --executable <path>   Chrome/Chromium binary (default: Playwright's, or $PW_CHROMIUM)
  --arg <flag>          Extra browser argument; repeatable
  --quiet               Do not print the Markdown report to stdout
```

Writes `report.json` and `report.md`. Exit code 1 when any error-level finding exists, 2 on usage errors.

As a library:

```ts
import { audit, renderMarkdown } from "webmcp-audit";

const report = await audit({ url: "https://shop.example", maxPages: 20, smoke: true });
console.log(renderMarkdown(report));
```

See the [repository README](https://github.com/swissspidy/playwright-webmcp#readme) for the rules and the score.
