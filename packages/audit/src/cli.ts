#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { audit, renderMarkdown } from "./index.js";

function usage(): never {
  console.error(`Usage: webmcp-audit <url> [--max-pages N] [--no-crawl] [--smoke] [--all-tools] [--out DIR] [--executable PATH] [--arg FLAG]...

Crawls same-origin pages from <url>, lints every page's WebMCP tools, optionally
runs schema-driven smoke calls (read-only tools unless --all-tools), and writes
report.json and report.md to DIR (default .webmcp-audit). Exits 1 when any
error-level finding exists.`);
  process.exit(2);
}

const argv = process.argv.slice(2);
if (!argv.length || argv.includes("--help") || argv.includes("-h")) usage();
const url = argv[0];
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const args = argv.flatMap((a, i) => (a === "--arg" && argv[i + 1] ? [argv[i + 1]] : []));

const report = await audit({
  url,
  maxPages: value("--max-pages") ? Number(value("--max-pages")) : undefined,
  crawl: !flag("--no-crawl"),
  smoke: flag("--smoke"),
  smokeOptions: flag("--all-tools") ? { all: true } : {},
  executablePath: value("--executable") ?? process.env.PW_CHROMIUM,
  args,
  onPage: (p) => console.error(`${p.status === "ok" ? "audited" : "failed "} ${p.url}${p.score ? `  score ${p.score.score}` : ""}`),
});

const out = value("--out") ?? ".webmcp-audit";
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
writeFileSync(join(out, "report.md"), renderMarkdown(report));
console.log(renderMarkdown(report));
process.exit(report.findings.some((f) => f.severity === "error") ? 1 : 0);
