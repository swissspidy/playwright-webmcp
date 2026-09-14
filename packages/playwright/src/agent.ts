/**
 * The agent contract: anything that takes prompts, may call the page's
 * WebMCP tools, and reports what it did. The `promptApi` fixture implements
 * it with Chrome's on-device model; `defineAgent()` wraps a function that
 * drives any model or agent framework from Node (the Vercel AI SDK, an
 * Anthropic or OpenAI client, a hand-written loop) and hands it the page's
 * tools as callables. `toPassEval` and `evaluateAgent()` accept either.
 */
import { reconcileCalls, toolHints, type EvalCase, type JsonSchema, type ReconcileOptions, type RecordedCall } from "webmcp-lint";
import type { WebMCP } from "./fixture.js";

export interface AgentCall {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  startedAt: number;
  durationMs: number;
}

export interface AgentRunOptions {
  /** User turns, sent in order within one conversation. */
  prompts: string[];
  systemPrompt?: string;
  /** Only offer these tools. Default: every tool the page exposes. */
  toolNames?: string[];
  /** Give up after this long. Default 60 s. */
  timeoutMs?: number;
}

export interface AgentRunResult {
  status: "ok" | "unavailable" | "error" | "timeout";
  reason?: string;
  /** The agent's final text per user turn, when it produced any. */
  responses: string[];
  /** Tool calls the agent made during this run, in order. */
  calls: AgentCall[];
  toolsOffered: string[];
}

/** Something that can act on a page's tools given natural-language prompts. */
export interface WebMCPAgent {
  run(options: AgentRunOptions | string): Promise<AgentRunResult>;
  /** Optional readiness probe; "unavailable" lets tests skip cleanly. */
  availability?(): Promise<string>;
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

export interface AgentContext {
  webmcp: WebMCP;
  /** The tools to offer, already executable. */
  tools: AgentTool[];
  prompts: string[];
  systemPrompt?: string;
  /** Aborted when the run times out. */
  signal: AbortSignal;
}

/** What a driver returns: text responses, or nothing when only the calls matter. */
export type AgentDriveResult = void | string | string[] | { responses?: string[] };

/**
 * Turn a function that drives a model into an agent. The function receives
 * the page's tools as callables; every call it makes is recorded on the
 * fixture with `via: "agent"` and reported in the run result, so
 * `toPassEval`, `toHaveCalledTool` and `toMatchCalls` all work.
 *
 *   const agent = defineAgent(webmcp, async ({ tools, prompts, systemPrompt }) => {
 *     const { text } = await generateText({ model, system: systemPrompt, prompt: prompts.join("\n"), tools: toAiSdkTools(tools), maxSteps: 5 });
 *     return text;
 *   });
 *   await expect(agent).toPassEval(evalCase);
 */
export function defineAgent(webmcp: WebMCP, drive: (context: AgentContext) => Promise<AgentDriveResult>): WebMCPAgent {
  return {
    async run(options) {
      const opts = typeof options === "string" ? { prompts: [options] } : options;
      const before = new Set(webmcp.calls());
      const controller = new AbortController();
      const timeoutMs = opts.timeoutMs ?? 60_000;
      const timer = setTimeout(() => controller.abort(new Error(`Agent run exceeded ${timeoutMs} ms`)), timeoutMs);
      const result: AgentRunResult = { status: "ok", responses: [], calls: [], toolsOffered: [] };
      const aborted = new Promise<never>((_resolve, reject) =>
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }),
      );
      try {
        // Discovering the tools counts against the budget too, and a page whose getTools() fails is an error, not a crash.
        const tools = await Promise.race([toolsForAgent(webmcp, { toolNames: opts.toolNames }), aborted]);
        result.toolsOffered = tools.map((t) => t.name);
        const outcome = await Promise.race([
          drive({ webmcp, tools, prompts: opts.prompts, systemPrompt: opts.systemPrompt, signal: controller.signal }),
          aborted,
        ]);
        result.responses = typeof outcome === "string" ? [outcome] : Array.isArray(outcome) ? outcome : (outcome?.responses ?? []);
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
      result.calls = webmcp
        .calls()
        .filter((c) => !before.has(c) && c.via === "agent")
        .map(toAgentCall);
      return result;
    },
  };
}

function toAgentCall(c: RecordedCall): AgentCall {
  return { name: c.name, args: c.args, result: c.result, error: c.error, startedAt: c.startedAt, durationMs: c.durationMs };
}

export interface EvalRunOptions extends ReconcileOptions, Omit<AgentRunOptions, "prompts"> {
  /** Further options forwarded to the agent's run(), e.g. the Prompt API harness's toolResultFormat. */
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
export async function evaluateAgent(agent: WebMCPAgent, evalCase: EvalCase, options: EvalRunOptions = {}): Promise<EvalRunResult> {
  const { strict, mode = "evals", ...runOptions } = options;
  const prompts = evalCase.messages.filter((m) => m.role === "user" && m.type === "message").map((m) => (m as { content: string }).content);
  const result = await agent.run({ ...(runOptions as Omit<AgentRunOptions, "prompts">), prompts });
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

export function isAgent(value: unknown): value is WebMCPAgent {
  return Boolean(value && typeof (value as WebMCPAgent).run === "function");
}
