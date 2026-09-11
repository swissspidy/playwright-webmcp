#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { audit, renderMarkdown } from "./index.js";

const HELP = `Usage: webmcp-audit <url> [options]

Crawls same-origin pages from <url>, lints every page's WebMCP tools, optionally
runs schema-driven smoke calls, and writes report.json and report.md.
Exits 1 when any page failed to load or any error-level finding exists, 2 on usage errors.

Options:
  --max-pages <n>       Maximum pages to visit (default 10)
  --no-crawl            Audit only <url>; do not follow links
  --smoke               Execute generated inputs against read-only tools
  --all-tools           With --smoke: execute every tool, including ones with side effects
  --settle <ms>         Wait this long after load for tools to register (default 500)
  --out <dir>           Output directory (default .webmcp-audit)
  --executable <path>   Chrome/Chromium binary (default: Playwright's, or $PW_CHROMIUM)
  --arg <flag>          Extra browser argument; repeatable, e.g. --arg=--enable-features=WebMCP
  --quiet               Do not print the Markdown report to stdout
  -h, --help            Show this help
`;

function fail(message: string): never {
  console.error(`webmcp-audit: ${message}\n`);
  console.error(HELP);
  process.exit(2);
}

/** `--arg --enable-features=X` reads naturally but parseArgs needs `--arg=--enable-features=X`; rewrite the former. */
function normalizeArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--arg" && i + 1 < argv.length) out.push(`--arg=${argv[++i]}`);
    else out.push(argv[i]);
  }
  return out;
}

function parse() {
  try {
    return parseArgs({
      args: normalizeArgv(process.argv.slice(2)),
      allowPositionals: true,
      options: {
        "max-pages": { type: "string" },
        "no-crawl": { type: "boolean", default: false },
        smoke: { type: "boolean", default: false },
        "all-tools": { type: "boolean", default: false },
        settle: { type: "string" },
        out: { type: "string", default: ".webmcp-audit" },
        executable: { type: "string" },
        arg: { type: "string", multiple: true, default: [] as string[] },
        quiet: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    return fail((err as Error).message);
  }
}
const { values, positionals } = parse();

if (values.help) {
  console.log(HELP);
  process.exit(0);
}
const url = positionals[0];
if (!url) fail("missing <url>");
if (positionals.length > 1) fail(`unexpected argument ${JSON.stringify(positionals[1])}`);
try {
  new URL(url);
} catch {
  fail(`${JSON.stringify(url)} is not a valid URL`);
}
const integer = (name: "max-pages" | "settle"): number | undefined => {
  const raw = values[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) fail(`--${name} expects a non-negative integer, got ${JSON.stringify(raw)}`);
  return n;
};

const report = await audit({
  url,
  maxPages: integer("max-pages"),
  crawl: !values["no-crawl"],
  smoke: values.smoke,
  smokeOptions: values["all-tools"] ? { all: true } : {},
  settleMs: integer("settle"),
  executablePath: values.executable ?? process.env.PW_CHROMIUM,
  args: values.arg,
  onPage: (p) => console.error(`${p.status === "ok" ? "audited" : "failed "} ${p.url}${p.score ? `  score ${p.score.score}` : ""}`),
});

mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
writeFileSync(join(values.out, "report.md"), renderMarkdown(report));
if (!values.quiet) console.log(renderMarkdown(report));
const failedPages = report.pages.filter((p) => p.status === "error");
if (failedPages.length) console.error(`webmcp-audit: ${failedPages.length} page(s) could not be audited`);
process.exit(failedPages.length || report.findings.some((f) => f.severity === "error") ? 1 : 0);
