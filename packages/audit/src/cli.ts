#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { toGitHubAnnotations, type Severity } from "webmcp-lint";
import { audit, renderMarkdown, type AuditReport } from "./index.js";

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
  --executable <path>   Chrome/Chromium binary (default: Playwright's, or $PW_CHROMIUM)
  --arg <flag>          Extra browser argument; repeatable, e.g. --arg=--enable-features=WebMCP
  --quiet               Do not print the report to stdout
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

export function parseHeaders(specs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of specs) {
    const colon = spec.indexOf(":");
    const name = colon > 0 ? spec.slice(0, colon).trim() : "";
    if (!name) fail(`--header expects "Name: value", got ${JSON.stringify(spec)}`);
    out[name] = spec.slice(colon + 1).trim();
  }
  return out;
}

function readBaseline(path: string): Pick<AuditReport, "pages"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return fail(`could not read --baseline ${path}: ${(err as Error).message}`);
  }
  const pages = (parsed as AuditReport | null)?.pages;
  const isPage = (p: unknown) =>
    Boolean(p && typeof p === "object" && typeof (p as { url?: unknown }).url === "string" && typeof (p as { status?: unknown }).status === "string");
  if (!parsed || typeof parsed !== "object" || !Array.isArray(pages) || !pages.every(isPage)) fail(`--baseline ${path} is not a webmcp-audit report.json`);
  return parsed as Pick<AuditReport, "pages">;
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
        baseline: { type: "string" },
        header: { type: "string", multiple: true, default: [] as string[] },
        settle: { type: "string" },
        out: { type: "string", default: ".webmcp-audit" },
        format: { type: "string", default: "md" },
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
  const format = String(values.format);
  if (!["md", "json", "github"].includes(format)) fail(`--format expects md, json or github, got ${JSON.stringify(format)}`);
  const headers = parseHeaders(values.header as string[]);
  const baseline = values.baseline ? readBaseline(values.baseline) : undefined;
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
    headers,
    baseline,
    onPage: (p) => console.error(`${p.status === "ok" ? "audited" : "failed "} ${p.url}${p.score ? `  score ${p.score.score}` : ""}`),
  });

  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(values.out, "report.md"), renderMarkdown(report));
  // The step summary is a report destination like --out, not console output, so --quiet does not suppress it.
  if (format === "github" && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report) + "\n");
  if (!values.quiet) {
    if (format === "json") console.log(JSON.stringify(report, null, 2));
    else if (format === "github") {
      const annotations = toGitHubAnnotations(report.findings, { tool: "webmcp-audit" });
      if (annotations) console.log(annotations);
    } else console.log(renderMarkdown(report));
  }
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
