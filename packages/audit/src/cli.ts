#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Severity } from "webmcp-lint";
import { audit, renderMarkdown } from "./index.js";

const SEVERITY_RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 };

const HELP = `Usage: webmcp-audit <url> [options]

Crawls same-origin pages from <url>, lints every page's WebMCP tools, optionally
runs schema-driven smoke calls, and writes report.json and report.md.
Exits 1 when any page failed to load or a finding at or above --fail-on exists,
2 on usage errors.

Options:
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
  --arg <flag>          Extra browser argument; repeatable, e.g. --arg=--enable-features=WebMCP
  --quiet               Do not print the Markdown report to stdout
  -h, --help            Show this help
`;

class UsageError extends Error {}

function fail(message: string): never {
  throw new UsageError(message);
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
        "fail-on": { type: "string", default: "error" },
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
/**
 * Returns the exit code instead of calling process.exit(), so that stdout
 * (which may be a pipe) drains before the process ends.
 */
async function main(): Promise<number> {
  const { values, positionals } = parse();

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const url = positionals[0];
  if (!url) fail("missing <url>");
  if (positionals.length > 1) fail(`unexpected argument ${JSON.stringify(positionals[1])}`);
  try {
    new URL(url);
  } catch {
    fail(`${JSON.stringify(url)} is not a valid URL`);
  }
  const failOn = String(values["fail-on"]);
  if (!["error", "warning", "info", "never"].includes(failOn)) fail(`--fail-on expects error, warning, info or never, got ${JSON.stringify(failOn)}`);
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
  const threshold = failOn === "never" ? Infinity : SEVERITY_RANK[failOn as Severity];
  return failedPages.length || report.findings.some((f) => SEVERITY_RANK[f.severity] >= threshold) ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`webmcp-audit: ${err.message}\n`);
    console.error(HELP);
    process.exitCode = 2;
  } else {
    throw err;
  }
}
