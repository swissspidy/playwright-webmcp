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
import { formatScore, type TimelineBudgets } from "webmcp-lint";
import { WebMCP } from "./fixture.js";
import { evaluateAgent, isEvalAgent, type EvalAgent, type EvalRunOptions } from "./agent.js";
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

interface MatcherContext {
  isNot?: boolean;
  timeout?: number;
}

/**
 * Re-evaluate a snapshot-based check until it holds (or, under `.not`, until
 * it stops holding) or the expect timeout elapses, the way Playwright's own
 * locator assertions wait. Tools register after load and native getTools()
 * can lag, so a single look is the wrong default.
 */
async function until<T extends { pass: boolean }>(ctx: MatcherContext, check: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + (ctx.timeout ?? 5000);
  for (;;) {
    const result = await check();
    if ((ctx.isNot ? !result.pass : result.pass) || Date.now() >= deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function checkTool(webmcp: WebMCP, name: string, expected: ToolExpectation) {
  const tools = await webmcp.tools();
  const tool = tools.find((t) => t.name === name);
  const problems: string[] = [];
  if (!tool) {
    problems.push(`no tool named "${name}"; found: ${tools.map((t) => t.name).join(", ") || "(none)"}`);
  } else {
    if (expected.description !== undefined) {
      // A fresh copy so a global or sticky pattern's lastIndex cannot flip the answer between polls.
      const ok =
        expected.description instanceof RegExp
          ? new RegExp(expected.description.source, expected.description.flags).test(tool.description)
          : tool.description === expected.description;
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
    message: () => (pass ? `Expected page not to expose tool "${name}", but it does.` : `Expected page to expose tool "${name}":\n  ${problems.join("\n  ")}`),
    actual: tool,
    expected: { name, ...expected },
  };
}

export const expect = baseExpect.extend({
  async toHaveTool(received: unknown, name: string, expected: ToolExpectation = {}) {
    const webmcp = resolve(received);
    return until(this as MatcherContext, () => checkTool(webmcp, name, expected));
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
    const check = async () => {
      const result = await webmcp.matchToolContract(name);
      return {
        pass: result.pass,
        name: "toMatchToolContract",
        message: () =>
          result.pass
            ? `Expected the tool contract to differ from ${result.path}, but it matched.`
            : `Tool contract differs from ${result.path}:\n${formatChanges(result.changes)}\nRun with --update-snapshots to accept the change.`,
      };
    };
    // Writing a contract must not capture a page that is still registering; comparing can simply wait.
    if (webmcp.updatesSnapshots(name)) {
      await webmcp.settle();
      return check();
    }
    return until(this as MatcherContext, check);
  },

  async toReachTool(received: unknown, name: string, options: { from?: number } = {}) {
    const webmcp = resolve(received);
    return until(this as MatcherContext, async () => {
      const reachable = await webmcp.reachableTools(options);
      const pass = reachable.some((t) => t.name === name);
      return {
        pass,
        name: "toReachTool",
        message: () =>
          pass
            ? `Expected tool "${name}" not to be reachable from frame ${options.from ?? 0}, but it is.`
            : `Tool "${name}" is not reachable from frame ${options.from ?? 0}. Reachable: ${reachable.map((t) => `${t.name}${t.remote ? ` (${t.origin})` : ""}`).join(", ") || "(none)"}`,
      };
    });
  },

  async toHaveToolCoverage(received: unknown, minimum: number) {
    const webmcp = resolve(received);
    const report = await webmcp.coverage();
    const min = minimum > 1 ? minimum / 100 : minimum;
    const pass = report.ratio >= min;
    return {
      pass,
      name: "toHaveToolCoverage",
      message: () =>
        `Tool coverage is ${Math.round(report.ratio * 100)}% (${report.called}/${report.total}); expected ${pass ? "less than" : "at least"} ${Math.round(min * 100)}%.${report.uncalled.length ? ` Never called: ${report.uncalled.join(", ")}` : ""}`,
    };
  },

  async toHaveAgentReadinessScore(received: unknown, minimum: number, options: { smoke?: boolean } = {}) {
    const webmcp = resolve(received);
    const score = await webmcp.score(options);
    const pass = score.score >= minimum;
    return {
      pass,
      name: "toHaveAgentReadinessScore",
      message: () => `${formatScore(score)}\nExpected ${pass ? "below" : "at least"} ${minimum}.`,
    };
  },

  async toRegisterToolsWithin(received: unknown, ms: number, budgets: TimelineBudgets = {}) {
    const webmcp = resolve(received);
    const report = await webmcp.timeline(budgets);
    const pass = report.timeToFirstTool !== undefined && report.timeToFirstTool <= ms;
    return {
      pass,
      name: "toRegisterToolsWithin",
      message: () =>
        report.timeToFirstTool === undefined
          ? `No tool registrations were observed on ${webmcp.page.url()}.`
          : `First tool registered ${Math.round(report.timeToFirstTool)} ms after navigation; expected ${pass ? "more than" : "at most"} ${ms} ms.`,
    };
  },

  async toPassEval(received: unknown, evalCase: EvalCase, options: EvalRunOptions & { agent?: EvalAgent } = {}) {
    // Two receivers: the promptApi fixture (an agent that knows its page), or the webmcp fixture with `{ agent }`.
    const harness = received as { run?: unknown; webmcp?: WebMCP } | null;
    let webmcp: WebMCP;
    let agent: EvalAgent;
    const { agent: given, ...evalOptions } = options;
    if (harness && typeof harness.run === "function" && harness.webmcp) {
      webmcp = harness.webmcp;
      agent = harness as unknown as EvalAgent;
    } else {
      webmcp = resolve(received);
      if (!isEvalAgent(given)) {
        throw new TypeError(
          "toPassEval needs an agent: expect(webmcp).toPassEval(evalCase, { agent }) with an AI SDK agent, an object with generate() or run(), or an async function; or expect(promptApi).toPassEval(evalCase)",
        );
      }
      agent = given;
    }
    const result = await evaluateAgent(webmcp, agent, evalCase, evalOptions);
    const label = evalCase.name ?? evalCase.messages.map((m) => ("content" in m ? m.content : m.type)).join(" / ");
    return {
      pass: result.pass,
      name: "toPassEval",
      message: () =>
        result.pass
          ? `Expected eval "${label}" to fail, but the model satisfied it.`
          : `Eval "${label}" failed (${result.status}):\n  ${result.problems.join("\n  ")}\nModel calls: ${
              result.calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(", ") || "(none)"
            }\nModel response: ${result.responses.join(" | ") || "(none)"}`,
    };
  },

  toMatchCalls(received: unknown, expected: ExpectedCallNode[], options: ReconcileOptions = {}) {
    const calls = callsOf(received);
    const result = reconcileCalls(
      expected,
      calls.map((c) => ({ name: c.name, args: c.args, result: c.result })),
      options,
    );
    return {
      pass: result.ok,
      name: "toMatchCalls",
      message: () =>
        result.ok
          ? `Expected calls not to match the expectation, but they did.`
          : `Recorded calls do not satisfy the expectation:\n  ${result.problems.join("\n  ")}\nRecorded: ${
              calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(", ") || "(none)"
            }`,
    };
  },
});
