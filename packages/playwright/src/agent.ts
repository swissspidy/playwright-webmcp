/**
 * Evals against any agent. The page's tools become callables through
 * `toolsForAgent()`; whatever runs them from Node (the Vercel AI SDK's
 * `ToolLoopAgent`, an Anthropic or OpenAI client, a hand-written loop) is
 * driven by `runAgent()` and judged by `evaluateAgent()`, which is what
 * `expect(webmcp).toPassEval(evalCase, { agent })` calls. The `promptApi`
 * fixture is an agent too. Calls are read back from the fixture, so nothing
 * has to report them.
 */
import { reconcileCalls, toolHints, type EvalCase, type JsonSchema, type ReconcileOptions, type RecordedCall } from "@swissspidy/webmcp-lint";
import type { WebMCP } from "./fixture.js";

export interface AgentCall {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  startedAt: number;
  durationMs: number;
}

/** A page tool as an agent framework wants it: a schema and a function that executes it in the page. */
export interface AgentTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: Record<string, unknown>;
  /** True when the tool is annotated read-only under either spelling. */
  readOnly: boolean;
  /** Executes the tool in the page and records the call with `via: "agent"`. */
  execute(args: Record<string, unknown>): Promise<unknown>;
}

/** The page's tools with `execute` wired to `webmcp.call()`, recorded as agent calls. */
export async function toolsForAgent(webmcp: WebMCP, options: { toolNames?: string[] } = {}): Promise<AgentTool[]> {
  const tools = await webmcp.tools();
  return tools
    .filter((t) => !options.toolNames || options.toolNames.includes(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      annotations: t.annotations,
      readOnly: toolHints(t.annotations).readOnly === true,
      execute: (args) => webmcp.call(t.name, args ?? {}, { via: "agent" }),
    }));
}

export interface AgentRunOptions {
  /** User turns, sent in order within one conversation. */
  prompts: string[];
  systemPrompt?: string;
  /** Only offer these tools. Default: every tool the page exposes. */
  toolNames?: string[];
  /** Give up after this long. For a function agent, the clock starts once its tools have been discovered. Default 60 s. */
  timeoutMs?: number;
  /** How long a function agent's tool discovery may take, apart from `timeoutMs`; past it the run is a timeout. Default 10 s. */
  discoveryTimeoutMs?: number;
}

export interface AgentRunResult {
  status: "ok" | "unavailable" | "error" | "timeout";
  reason?: string;
  /** The agent's final text per user turn, when it produced any. */
  responses: string[];
  /** Tool calls the agent made during this run, in order. */
  calls: AgentCall[];
  /** The tools the agent was given; empty when the agent does not report them (an AI SDK agent holds its own). */
  toolsOffered: string[];
}

/** An agent with a `run()` method, like the `promptApi` fixture. */
export interface AgentRunner {
  run(options: AgentRunOptions | string): Promise<AgentRunResult>;
}

/**
 * An agent with a `generate()` method, like the AI SDK's `ToolLoopAgent`.
 * The first turn is sent as `{ prompt }`; later turns as `{ messages }` with
 * the earlier turns and whatever `response.messages` the result carried.
 */
export interface AgentGenerator {
  generate(options: { prompt?: unknown; messages?: unknown; abortSignal?: AbortSignal }): Promise<unknown>;
}

/** Context handed to a function agent for each user turn. */
export interface AgentTurn {
  /** Zero-based index of this turn. */
  index: number;
  prompts: string[];
  systemPrompt?: string;
  /** The page's tools as callables; every call is recorded as an agent call, and rejects once the run has timed out. */
  tools: AgentTool[];
  /** Aborted when the run times out. */
  signal: AbortSignal;
}

/** A function called once per user turn; returning text is optional. */
export type AgentFunction = (prompt: string, turn: AgentTurn) => Promise<unknown>;

/** Anything `runAgent()` can drive: the `promptApi` fixture, an AI SDK agent, or a function. */
export type EvalAgent = AgentRunner | AgentGenerator | AgentFunction;

export function isEvalAgent(value: unknown): value is EvalAgent {
  if (typeof value === "function") return true;
  const v = value as { run?: unknown; generate?: unknown } | null;
  return Boolean(v && (typeof v.run === "function" || typeof v.generate === "function"));
}

function textOf(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  const text = (result as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : undefined;
}

function responseMessages(result: unknown): unknown[] {
  const messages = (result as { response?: { messages?: unknown } } | null)?.response?.messages;
  return Array.isArray(messages) ? messages : [];
}

function toAgentCall(c: RecordedCall): AgentCall {
  return { name: c.name, args: c.args, result: c.result, error: c.error, startedAt: c.startedAt, durationMs: c.durationMs };
}

/**
 * Send the prompts to an agent, one user turn at a time, and report what it
 * answered and which of the page's tools it called (read back from the
 * fixture as calls with `via: "agent"`). A thrown error is `status: "error"`,
 * running past `timeoutMs` is `status: "timeout"`; a runner's own status is
 * passed through.
 */
export async function runAgent(webmcp: WebMCP, agent: EvalAgent, options: AgentRunOptions | string): Promise<AgentRunResult> {
  const opts = typeof options === "string" ? { prompts: [options] } : options;
  const before = new Set(webmcp.calls());
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const discoveryTimeoutMs = opts.discoveryTimeoutMs ?? 10_000;
  // The clock bounds the agent's own work, so it starts once the agent has what it needs. Tool
  // discovery is the fixture's part: a child frame whose getTools() is slow to settle under load can
  // hold it up for a second or more, which would spend a short budget before the agent ran at all.
  // Discovery has a deadline of its own instead, so a snapshot that never finishes still ends the run.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startClock = (ms = timeoutMs, message = `Agent run exceeded ${timeoutMs} ms`) => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(message)), ms);
  };
  const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
  const result: AgentRunResult = { status: "ok", responses: [], calls: [], toolsOffered: [] };
  let ownCalls: AgentCall[] | undefined;
  const race = <T>(p: Promise<T>) => Promise.race([p, aborted]);
  try {
    if (typeof agent !== "function" && typeof (agent as AgentRunner).run === "function") {
      startClock();
      const ran = await race((agent as AgentRunner).run({ ...opts, timeoutMs }));
      result.status = ran.status;
      result.reason = ran.reason;
      result.responses = ran.responses ?? [];
      result.toolsOffered = ran.toolsOffered ?? [];
      // A runner reports its own calls (the Prompt API harness records what the model did in the page);
      // natively the CDP collector sees those executions too, so reading the fixture back would count them twice.
      if (Array.isArray(ran.calls)) ownCalls = ran.calls;
    } else if (typeof agent === "function") {
      startClock(discoveryTimeoutMs, `Tool discovery did not finish within ${discoveryTimeoutMs} ms`);
      const discovered = await race(toolsForAgent(webmcp, { toolNames: opts.toolNames }));
      startClock();
      // A driver that ignores the signal must not still be able to act on the page after the run
      // returned: a late call would mutate it and be counted against whichever run comes next.
      const tools = discovered.map((t) => ({
        ...t,
        execute: (args: Record<string, unknown>) => {
          if (controller.signal.aborted) return Promise.reject(controller.signal.reason ?? new Error("Agent run timed out"));
          return t.execute(args);
        },
      }));
      result.toolsOffered = tools.map((t) => t.name);
      for (const [index, prompt] of opts.prompts.entries()) {
        const text = textOf(await race(agent(prompt, { index, prompts: opts.prompts, systemPrompt: opts.systemPrompt, tools, signal: controller.signal })));
        if (text !== undefined) result.responses.push(text);
      }
    } else {
      startClock();
      const history: unknown[] = [];
      for (const [index, prompt] of opts.prompts.entries()) {
        const turn = index === 0 ? { prompt } : { messages: [...history, { role: "user", content: prompt }] };
        const generated = await race((agent as AgentGenerator).generate({ ...turn, abortSignal: controller.signal }));
        history.push({ role: "user", content: prompt }, ...responseMessages(generated));
        const text = textOf(generated);
        if (text !== undefined) result.responses.push(text);
      }
    }
    if (controller.signal.aborted) {
      result.status = "timeout";
      result.reason = String((controller.signal.reason as Error)?.message ?? controller.signal.reason);
    }
  } catch (err) {
    result.status = controller.signal.aborted ? "timeout" : "error";
    result.reason = String((err as Error)?.message ?? err);
  } finally {
    clearTimeout(timer);
  }
  result.calls =
    ownCalls ??
    webmcp
      .calls()
      .filter((c) => !before.has(c) && c.via === "agent")
      .map(toAgentCall);
  return result;
}

export interface EvalRunOptions extends ReconcileOptions, Omit<AgentRunOptions, "prompts"> {
  /** Further options forwarded to a runner's run(), e.g. the Prompt API harness's toolResultFormat. */
  [key: string]: unknown;
}

export interface EvalRunResult extends AgentRunResult {
  pass: boolean;
  problems: string[];
}

/**
 * Run an evals case through an agent and reconcile the calls it made with
 * the case's `expectedCall`, using the `webmcp-evals` CLI's positional
 * semantics unless `mode: "lenient"` is passed. Only user messages of type
 * "message" are sent; other message kinds are ignored.
 */
export async function evaluateAgent(webmcp: WebMCP, agent: EvalAgent, evalCase: EvalCase, options: EvalRunOptions = {}): Promise<EvalRunResult> {
  const { strict, mode = "evals", ...runOptions } = options;
  const prompts = evalCase.messages.filter((m) => m.role === "user" && m.type === "message").map((m) => (m as { content: string }).content);
  const result = await runAgent(webmcp, agent, { ...(runOptions as Omit<AgentRunOptions, "prompts">), prompts });
  if (result.status !== "ok") {
    return { ...result, pass: false, problems: [`${result.status}: ${result.reason ?? "no details"}`] };
  }
  const reconciled = reconcileCalls(
    evalCase.expectedCall,
    result.calls.map((c) => ({ name: c.name, args: c.args, result: c.result })),
    { strict, mode },
  );
  return { ...result, pass: reconciled.ok, problems: reconciled.problems };
}
