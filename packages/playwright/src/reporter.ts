/**
 * Playwright reporter that aggregates what the `webmcp` fixture attached to
 * each test and writes suite-wide reports:
 *
 *   tools.json     every tool the suite saw, in the schema format `webmcp-evals local -t` reads
 *   coverage.json  which tools and parameters the recorded calls exercised
 *   TOOLS.md       a Markdown reference of the tools with example calls
 *
 *   // playwright.config.ts
 *   reporter: [["list"], ["@swissspidy/playwright-webmcp/reporter", { outputDir: ".webmcp-report" }]]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FullConfig, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { ATTACHMENTS, computeCoverage, renderToolDocs, toContract, toToolsSchema, type RecordedCall, type ToolSnapshot } from "@swissspidy/webmcp-lint";

export interface WebMCPReporterOptions {
  /** Directory to write into, relative to the Playwright config. Default `.webmcp-report`. */
  outputDir?: string;
  /** Heading of TOOLS.md. Default "WebMCP tools seen by the test suite". */
  title?: string;
}

export default class WebMCPReporter implements Reporter {
  private readonly outputDir: string;
  private readonly title: string;
  private readonly calls: RecordedCall[] = [];
  private readonly snapshots = new Map<string, ToolSnapshot>();
  private rootDir = process.cwd();

  constructor(options: WebMCPReporterOptions = {}) {
    this.outputDir = options.outputDir ?? ".webmcp-report";
    this.title = options.title ?? "WebMCP tools seen by the test suite";
  }

  onBegin(config: FullConfig) {
    this.rootDir = config.configFile ? dirname(config.configFile) : config.rootDir;
  }

  onTestEnd(_test: TestCase, result: TestResult) {
    for (const a of result.attachments) {
      if (!a.body) continue;
      if (a.name === ATTACHMENTS.calls) {
        this.calls.push(...(JSON.parse(a.body.toString("utf8")) as RecordedCall[]));
      } else if (a.name === ATTACHMENTS.toolSnapshots) {
        for (const t of JSON.parse(a.body.toString("utf8")) as ToolSnapshot[]) if (!this.snapshots.has(t.name)) this.snapshots.set(t.name, t);
      }
    }
  }

  onEnd() {
    if (!this.snapshots.size) return;
    const dir = resolve(this.rootDir, this.outputDir);
    mkdirSync(dir, { recursive: true });
    const tools = [...this.snapshots.values()];
    const snapshot = { url: "", capturedAt: "", frames: [], tools };
    writeFileSync(join(dir, "tools.json"), JSON.stringify(toToolsSchema(snapshot), null, 2) + "\n");
    writeFileSync(join(dir, "coverage.json"), JSON.stringify(computeCoverage(tools, this.calls), null, 2) + "\n");
    writeFileSync(join(dir, "TOOLS.md"), renderToolDocs(toContract(snapshot), { calls: this.calls, title: this.title }));
  }

  printsToStdio() {
    return false;
  }
}
