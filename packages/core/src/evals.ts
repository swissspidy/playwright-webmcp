import type { EvalCase, EvalFunctionCall, EvalMessage, EvalToolsSchema, ExpectedCallNode } from "./evals-types.js";
import type { PageSnapshot, RecordedCall } from "./types.js";

export type ArgumentsMode = "exact" | "types" | "any";

export interface ToEvalOptions {
  name?: string;
  /** The natural language request an agent would receive. */
  prompt: string;
  /** How recorded arguments become expectations. Default "exact". */
  argumentsMode?: ArgumentsMode;
  /** Wrap all calls in an unordered group instead of the default ordered list. */
  unordered?: boolean;
  /** Include recorded results as `result` expectations. Default false. */
  includeResults?: boolean;
}

function typeConstraint(value: unknown): unknown {
  if (value === null) return { $type: "null" };
  if (Array.isArray(value)) return { $type: "array" };
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return { $type: t };
  return { $type: "object" };
}

function toExpectedArguments(args: Record<string, unknown>, mode: ArgumentsMode): object | null {
  if (mode === "any") return null;
  if (mode === "exact") return args;
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeConstraint(v)]));
}

export function toExpectedCalls(calls: RecordedCall[], options: Pick<ToEvalOptions, "argumentsMode" | "unordered" | "includeResults">): ExpectedCallNode[] {
  const mode = options.argumentsMode ?? "exact";
  const nodes: EvalFunctionCall[] = calls.map((c) => {
    const node: EvalFunctionCall = { functionName: c.name, arguments: toExpectedArguments(c.args, mode) };
    if (options.includeResults && c.result !== undefined) node.result = c.result;
    return node;
  });
  return options.unordered && nodes.length > 1 ? [{ unordered: nodes }] : nodes;
}

export function toEvalCase(calls: RecordedCall[], options: ToEvalOptions): EvalCase {
  const messages: EvalMessage[] = [{ role: "user", type: "message", content: options.prompt }];
  return { name: options.name, messages, expectedCall: toExpectedCalls(calls, options) };
}

export function toToolsSchema(snapshot: Pick<PageSnapshot, "tools">): EvalToolsSchema {
  const seen = new Set<string>();
  const tools = [];
  for (const t of snapshot.tools) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    tools.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? null, outputSchema: null });
  }
  return { tools };
}
