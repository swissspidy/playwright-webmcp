import { expect as baseExpect, type Page } from "@playwright/test";
import {
  explainMismatch,
  formatChanges,
  formatFindings,
  matchesArgument,
  reconcileCalls,
  type EvalCase,
  type ExpectedCallNode,
  type LintOptions,
  type RecordedCall,
  type ReconcileOptions,
  type Severity,
  type ToolSource,
} from "webmcp-lint";
import { WebMCP, type EvalRunOptions } from "./fixture.js";
import type { SmokeOptions } from "./smoke.js";

export interface ToolExpectation {
  description?: string | RegExp;
  /** Matched with subset semantics, so partial schemas work. */
  inputSchema?: unknown;
  source?: ToolSource;
}

export interface LintExpectation extends LintOptions {
  /** Lowest severity that fails the assertion. Default "error". */
  failOn?: Severity;
}

export interface SmokeExpectation extends SmokeOptions {
  /** Lowest severity that fails the assertion. Default "error". */
  failOn?: Severity;
}

function resolve(received: unknown): WebMCP {
  if (received instanceof WebMCP) return received;
  const page = received as Page;
  if (page && typeof page.frames === "function") {
    return WebMCP.for(page) ?? new WebMCP(page, undefined);
  }
  throw new TypeError("Expected a Page or the webmcp fixture");
}

function callsOf(received: unknown): RecordedCall[] {
  if (Array.isArray(received)) return received as RecordedCall[];
  return resolve(received).calls();
}

const RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 };

export const expect = baseExpect.extend({
  async toHaveTool(received: unknown, name: string, expected: ToolExpectation = {}) {
    const webmcp = resolve(received);
    const tools = await webmcp.tools();
    const tool = tools.find((t) => t.name === name);
    const problems: string[] = [];
    if (!tool) {
      problems.push(`no tool named "${name}"; found: ${tools.map((t) => t.name).join(", ") || "(none)"}`);
    } else {
      if (expected.description !== undefined) {
        const ok = expected.description instanceof RegExp ? expected.description.test(tool.description) : tool.description === expected.description;
        if (!ok) problems.push(`description ${JSON.stringify(tool.description)} does not match ${String(expected.description)}`);
      }
      if (expected.inputSchema !== undefined && !matchesArgument(expected.inputSchema, tool.inputSchema)) {
        problems.push(...explainMismatch(expected.inputSchema, tool.inputSchema, "inputSchema"));
      }
      if (expected.source !== undefined && tool.source !== expected.source) problems.push(`source is ${tool.source}, expected ${expected.source}`);
    }
    const pass = problems.length === 0;
    return {
      pass,
      name: "toHaveTool",
      message: () =>
        pass ? `Expected page not to expose tool "${name}", but it does.` : `Expected page to expose tool "${name}":\n  ${problems.join("\n  ")}`,
      actual: tool,
      expected: { name, ...expected },
    };
  },

  async toPassLint(received: unknown, options: LintExpectation = {}) {
    const { failOn = "error", ...lintOptions } = options;
    const webmcp = resolve(received);
    const result = await webmcp.lint(lintOptions);
    const failing = result.findings.filter((f) => RANK[f.severity] >= RANK[failOn]);
    const pass = failing.length === 0;
    return {
      pass,
      name: "toPassLint",
      message: () =>
        pass
          ? `Expected lint findings at severity ${failOn} or above, but there were none.`
          : `WebMCP lint found ${failing.length} finding(s) at severity ${failOn} or above:\n${formatFindings({ ...result, findings: failing })}`,
    };
  },

  toHaveCalledTool(received: unknown, name: string, args?: unknown) {
    const calls = callsOf(received);
    const matching = calls.filter((c) => c.name === name && (args === undefined || matchesArgument(args, c.args)));
    const pass = matching.length > 0;
    const sameName = calls.filter((c) => c.name === name);
    return {
      pass,
      name: "toHaveCalledTool",
      message: () =>
        pass
          ? `Expected tool "${name}" not to have been called${args !== undefined ? ` with ${JSON.stringify(args)}` : ""}, but it was.`
          : sameName.length
            ? `Tool "${name}" was called ${sameName.length} time(s) but never with ${JSON.stringify(args)}:\n  ${sameName
                .map((c) => JSON.stringify(c.args))
                .join("\n  ")}`
            : `Tool "${name}" was never called. Calls: ${calls.map((c) => c.name).join(", ") || "(none)"}`,
    };
  },

  async toPassSmoke(received: unknown, options: SmokeExpectation = {}) {
    const { failOn = "error", ...smokeOptions } = options;
    const webmcp = resolve(received);
    const report = await webmcp.smoke(smokeOptions);
    const failing = report.findings.filter((f) => RANK[f.severity] >= RANK[failOn]);
    const pass = failing.length === 0;
    return {
      pass,
      name: "toPassSmoke",
      message: () =>
        pass
          ? `Expected smoke findings at severity ${failOn} or above, but there were none (${report.runs.length} run(s)).`
          : `Smoke run (${report.runs.length} call(s)) found ${failing.length} finding(s) at severity ${failOn} or above:\n${formatFindings({ findings: failing, counts: report.counts, rulesRun: [] })}`,
    };
  },

  async toMatchToolContract(received: unknown, name?: string) {
    const webmcp = resolve(received);
    const result = await webmcp.matchToolContract(name);
    return {
      pass: result.pass,
      name: "toMatchToolContract",
      message: () =>
        result.pass
          ? `Expected the tool contract to differ from ${result.path}, but it matched.`
          : `Tool contract differs from ${result.path}:\n${formatChanges(result.changes)}\nRun with --update-snapshots to accept the change.`,
    };
  },

  async toPassEval(received: unknown, evalCase: EvalCase, options: EvalRunOptions = {}) {
    const webmcp = resolve(received);
    const result = await webmcp.promptApi.evaluate(evalCase, options);
    const label = evalCase.name ?? evalCase.messages.map((m) => ("content" in m ? m.content : m.type)).join(" / ");
    return {
      pass: result.pass,
      name: "toPassEval",
      message: () =>
        result.pass
          ? `Expected eval "${label}" to fail, but the model satisfied it.`
          : `Eval "${label}" failed (${result.status}):\n  ${result.problems.join("\n  ")}\nModel calls: ${result.calls
              .map((c) => `${c.name}(${JSON.stringify(c.args)})`)
              .join(", ") || "(none)"}\nModel response: ${result.responses.join(" | ") || "(none)"}`,
    };
  },

  toMatchCalls(received: unknown, expected: ExpectedCallNode[], options: ReconcileOptions = {}) {
    const calls = callsOf(received);
    const result = reconcileCalls(expected, calls.map((c) => ({ name: c.name, args: c.args, result: c.result })), options);
    return {
      pass: result.ok,
      name: "toMatchCalls",
      message: () =>
        result.ok
          ? `Expected calls not to match the expectation, but they did.`
          : `Recorded calls do not satisfy the expectation:\n  ${result.problems.join("\n  ")}\nRecorded: ${calls
              .map((c) => `${c.name}(${JSON.stringify(c.args)})`)
              .join(", ") || "(none)"}`,
    };
  },
});
