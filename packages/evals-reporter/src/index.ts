import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FullConfig, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import type { EvalCase, EvalToolSchema, EvalToolsSchema } from "webmcp-lint";

export interface EvalsReporterOptions {
  /** Directory to write into. Default: `.webmcp-evals`. */
  outputDir?: string;
  /** Prefix eval names with the test title. Default true. */
  prefixWithTestTitle?: boolean;
}

/** Attachment names produced by the playwright-webmcp fixture. */
export const ATTACHMENTS = {
  eval: "webmcp-eval",
  tools: "webmcp-tools",
} as const;

interface ScenarioAttachment {
  url: string;
  eval: EvalCase;
}

/**
 * Collects scenario attachments from every test and writes
 * `evals.json` (array of eval cases) and `tools.json` (merged tool schemas)
 * in the format consumed by the webmcp-evals CLI:
 *
 *   webmcp-evals web --url <page> --evals .webmcp-evals/evals.json
 *   webmcp-evals local --tools .webmcp-evals/tools.json --evals .webmcp-evals/evals.json
 */
export default class WebMCPEvalsReporter implements Reporter {
  private readonly outputDir: string;
  private readonly prefix: boolean;
  private readonly evals: EvalCase[] = [];
  private readonly byUrl = new Map<string, EvalCase[]>();
  private readonly tools = new Map<string, EvalToolSchema>();
  private rootDir = process.cwd();

  constructor(options: EvalsReporterOptions = {}) {
    this.outputDir = options.outputDir ?? ".webmcp-evals";
    this.prefix = options.prefixWithTestTitle ?? true;
  }

  onBegin(config: FullConfig) {
    this.rootDir = config.configFile ? dirname(config.configFile) : config.rootDir;
  }

  onTestEnd(test: TestCase, result: TestResult) {
    for (const a of result.attachments) {
      if (!a.body) continue;
      if (a.name === ATTACHMENTS.eval) {
        const payload = JSON.parse(a.body.toString("utf8")) as ScenarioAttachment;
        const evalCase: EvalCase = { ...payload.eval };
        if (this.prefix) evalCase.name = evalCase.name ? `${test.title} › ${evalCase.name}` : test.title;
        this.evals.push(evalCase);
        this.byUrl.set(payload.url, [...(this.byUrl.get(payload.url) ?? []), evalCase]);
      } else if (a.name === ATTACHMENTS.tools) {
        const schema = JSON.parse(a.body.toString("utf8")) as EvalToolsSchema;
        for (const t of schema.tools) if (!this.tools.has(t.name)) this.tools.set(t.name, t);
      }
    }
  }

  onEnd() {
    const dir = resolve(this.rootDir, this.outputDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "evals.json"), JSON.stringify(this.evals, null, 2) + "\n");
    writeFileSync(join(dir, "tools.json"), JSON.stringify({ tools: [...this.tools.values()] }, null, 2) + "\n");
    const index = [...this.byUrl.entries()].map(([url, cases]) => ({ url, count: cases.length, names: cases.map((c) => c.name) }));
    writeFileSync(join(dir, "index.json"), JSON.stringify(index, null, 2) + "\n");
    if (this.evals.length) {
      console.log(`playwright-webmcp-evals: wrote ${this.evals.length} eval case(s) and ${this.tools.size} tool schema(s) to ${dir}`);
    }
  }

  printsToStdio() {
    return false;
  }
}
