import { declarations } from "./declarations.js";
import { ToolRegistry, type CdpLikeSession, type InvokeOutcome, type ToolInfo } from "./registry.js";
import { runInSandbox, type LogEntry, type SandboxError, type SandboxLimits } from "./sandbox.js";
import { sessionFor, type PageLike } from "./session.js";

export interface ToolCallRequest {
  name: string;
  args: Record<string, unknown>;
  tool: ToolInfo;
  url: string;
}

export interface CodeModeOptions extends SandboxLimits {
  /** How long a call waits for its tool to be registered, e.g. right after a navigation. */
  toolWaitMs?: number;
  /** How long one tool call may run. */
  toolTimeoutMs?: number;
  /** Maximum tool calls per script. */
  maxCalls?: number;
  /**
   * Approve or deny each tool call. Return true to allow, false or a string (the reason) to deny.
   * By default every call is allowed.
   */
  onToolCall?: (request: ToolCallRequest) => boolean | string | Promise<boolean | string>;
  /** Approve `browser.goto()` targets. Only http(s) URLs are ever allowed; this narrows that further. */
  canNavigate?: (url: URL) => boolean;
  /** Unwrap `{ content: [{ type: "text", text }] }` results and parse JSON text. Default true. */
  unwrapResults?: boolean;
  /** Passed to the registry: how long to wait for a response once a tool's document navigated away. */
  navigationGraceMs?: number;
}

export interface CallRecord {
  name: string;
  args: Record<string, unknown>;
  url: string;
  startedAt: number;
  durationMs: number;
  outcome: "completed" | "navigated" | "error" | "canceled" | "denied" | "unavailable";
  result?: unknown;
  error?: string;
}

export interface ExecuteResult {
  ok: boolean;
  /** The script's return value. */
  result?: unknown;
  error?: SandboxError;
  logs: LogEntry[];
  calls: CallRecord[];
  url: { before: string; after: string };
  tools: { before: string[]; after: string[]; added: string[]; removed: string[] };
  durationMs: number;
}

const BROWSER_PRELUDE = `
(() => {
  const rpc = globalThis.__rpc;
  delete globalThis.__rpc;
  const reserved = new Set(["then", "toJSON", "constructor", "valueOf", "toString"]);
  globalThis.tools = new Proxy(Object.create(null), {
    get(_, name) {
      if (typeof name !== "string" || reserved.has(name)) return undefined;
      return (args) => rpc("call", { name, args: args === undefined ? {} : args });
    },
    has: () => true,
  });
  globalThis.browser = Object.freeze({
    url: () => rpc("url"),
    tools: () => rpc("tools"),
    goto: (url) => rpc("goto", { url: String(url) }),
    back: () => rpc("back"),
    reload: () => rpc("reload"),
    waitForTool: (name, options) => rpc("waitForTool", { name: String(name), timeoutMs: options && options.timeoutMs }),
    sleep: (ms) => rpc("sleep", { ms: Number(ms) }),
  });
})();
`;

function hostError(name: string, message: string, data?: Record<string, unknown>): Error {
  const e = new Error(message);
  e.name = name;
  if (data) Object.assign(e, data);
  return e;
}

/** Turn MCP-style results into plain values: structuredContent, or JSON in a single text item. */
export function unwrapResult(output: unknown): unknown {
  let value = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (v.structuredContent !== undefined) return v.structuredContent;
    if (Array.isArray(v.content)) {
      const texts = v.content.filter((c: any) => c?.type === "text").map((c: any) => String(c.text));
      if (texts.length === v.content.length && texts.length) {
        const text = texts.join("\n");
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
    }
  }
  return value;
}

export class CodeMode {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly registry: ToolRegistry,
    private readonly options: CodeModeOptions,
  ) {}

  /** Attach to a Playwright page, a Puppeteer page, or any CDP session with `send` and `on`. */
  static async create(target: PageLike | CdpLikeSession, options: CodeModeOptions = {}): Promise<CodeMode> {
    const session = await sessionFor(target);
    const registry = new ToolRegistry(session, { navigationGraceMs: options.navigationGraceMs });
    await registry.start();
    await registry.settle();
    return new CodeMode(registry, options);
  }

  get toolWaitMs() {
    return this.options.toolWaitMs ?? 5000;
  }

  /** TypeScript declarations of the sandbox API for the tools registered right now. */
  declarations(): string {
    return declarations(this.registry.list(), { url: this.registry.url(), toolWaitMs: this.toolWaitMs });
  }

  /** Run a script. Scripts run one at a time per page. */
  execute(code: string): Promise<ExecuteResult> {
    const run = this.queue.then(() => this.run(code));
    this.queue = run.catch(() => {});
    return run;
  }

  private async run(code: string): Promise<ExecuteResult> {
    const started = Date.now();
    const registry = this.registry;
    await registry.settle();
    const urlBefore = registry.url();
    const toolsBefore = names(registry.list());
    const calls: CallRecord[] = [];
    const controller = new AbortController();
    const maxCalls = this.options.maxCalls ?? 100;
    let callCount = 0;

    const host = async (op: string, payload: any): Promise<unknown> => {
      switch (op) {
        case "call":
          if (++callCount > maxCalls) throw hostError("CallLimitError", `A script may make at most ${maxCalls} tool calls`);
          return this.call(String(payload?.name), payload?.args ?? {}, calls, controller.signal);
        case "url":
          return registry.url();
        case "tools":
          return registry.list().map((t) => ({
            name: t.name,
            description: t.description,
            ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
            ...(t.annotations ? { annotations: t.annotations } : {}),
          }));
        case "goto": {
          let url: URL;
          try {
            url = new URL(String(payload?.url), registry.url() || undefined);
          } catch {
            throw hostError("TypeError", `Invalid URL: ${payload?.url}`);
          }
          const web = url.protocol === "http:" || url.protocol === "https:";
          if (!web || (this.options.canNavigate && !this.options.canNavigate(url)))
            throw hostError("NavigationDeniedError", `Navigation to ${url.href} is not allowed`);
          await registry.navigate(url.href);
          return null;
        }
        case "back":
          return registry.back();
        case "reload":
          await registry.reload();
          return null;
        case "waitForTool":
          return Boolean(await registry.waitForTool(String(payload?.name), Number(payload?.timeoutMs ?? this.toolWaitMs), controller.signal));
        case "sleep":
          await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(0, Number(payload?.ms) || 0), 30_000)));
          return null;
        default:
          throw hostError("TypeError", `Unknown operation ${op}`);
      }
    };

    let sandbox;
    try {
      sandbox = await runInSandbox(code, host, BROWSER_PRELUDE, this.options);
    } finally {
      // Stop waits the script started but no longer needs.
      controller.abort();
    }
    // A tool may schedule a navigation just after answering; give it a moment to start.
    const lastCallEnd = Math.max(0, ...calls.map((c) => c.startedAt + c.durationMs));
    const grace = lastCallEnd + 250 - Date.now();
    if (grace > 0) await new Promise((resolve) => setTimeout(resolve, grace));
    await registry.settle();
    const toolsAfter = names(registry.list());
    return {
      ok: sandbox.ok,
      ...(sandbox.ok ? { result: sandbox.value } : { error: sandbox.error }),
      logs: sandbox.logs,
      calls,
      url: { before: urlBefore, after: registry.url() },
      tools: {
        before: toolsBefore,
        after: toolsAfter,
        added: toolsAfter.filter((n) => !toolsBefore.includes(n)),
        removed: toolsBefore.filter((n) => !toolsAfter.includes(n)),
      },
      durationMs: Date.now() - started,
    };
  }

  private async call(name: string, args: Record<string, unknown>, calls: CallRecord[], signal: AbortSignal): Promise<unknown> {
    const registry = this.registry;
    const record: CallRecord = { name, args, url: registry.url(), startedAt: Date.now(), durationMs: 0, outcome: "completed" };
    calls.push(record);
    const finish = (patch: Partial<CallRecord>) => Object.assign(record, patch, { durationMs: Date.now() - record.startedAt });

    if (!args || typeof args !== "object" || Array.isArray(args)) {
      finish({ outcome: "error", error: "Tool arguments must be an object" });
      throw hostError("TypeError", `tools.${name}() takes one object argument`);
    }
    for (let attempt = 0; ; attempt++) {
      const tool = await registry.waitForTool(name, this.toolWaitMs, signal);
      if (!tool) {
        const available = names(registry.list());
        finish({ outcome: "unavailable", error: "not registered" });
        throw hostError(
          "ToolUnavailableError",
          `Tool "${name}" is not registered on ${registry.url()} (waited ${this.toolWaitMs} ms). Available: ${available.join(", ") || "none"}`,
          { tool: name, url: registry.url(), available },
        );
      }
      if (attempt === 0 && this.options.onToolCall) {
        const verdict = await this.options.onToolCall({ name, args, tool, url: registry.url() });
        if (verdict !== true) {
          const reason = typeof verdict === "string" ? verdict : "denied by policy";
          finish({ outcome: "denied", error: reason });
          throw hostError("ToolDeniedError", `Call to "${name}" was denied: ${reason}`, { tool: name });
        }
      }
      const outcome: InvokeOutcome = await registry.invoke(tool, args, this.options.toolTimeoutMs ?? 30_000).catch((err) => ({
        status: "error" as const,
        error: String(err?.message ?? err),
      }));
      // The registration went away between lookup and invocation (re-registered, or the page moved
      // on). The browser refused before running anything, so trying the current registration is safe.
      if (outcome.status === "error" && "stale" in outcome && outcome.stale && attempt < 2) continue;
      switch (outcome.status) {
        case "completed": {
          const result = this.options.unwrapResults === false ? outcome.output : unwrapResult(outcome.output);
          finish({ outcome: "completed", result });
          return result;
        }
        case "navigated": {
          const result =
            outcome.output === undefined
              ? { navigated: true, url: outcome.url }
              : this.options.unwrapResults === false
                ? outcome.output
                : unwrapResult(outcome.output);
          finish({ outcome: "navigated", result });
          return result;
        }
        case "canceled":
          finish({ outcome: "canceled" });
          throw hostError("ToolCanceledError", `Call to "${name}" was canceled`, { tool: name });
        case "error":
          finish({ outcome: "error", error: outcome.error });
          throw hostError("ToolError", `Tool "${name}" failed: ${outcome.error}`, { tool: name });
      }
    }
  }
}

function names(tools: ToolInfo[]): string[] {
  return [...new Set(tools.map((t) => t.name))];
}

/** A compact, model-facing rendering of an execution result. */
export function formatResult(r: ExecuteResult, options: { declarations?: string } = {}): string {
  const out: string[] = [];
  if (r.ok) out.push(`Result:\n${stringify(r.result)}`);
  else out.push(`Error: ${r.error?.name}: ${r.error?.message}`);
  if (r.logs.length) out.push(`Console:\n${r.logs.map((l) => (l.level === "log" ? l.text : `[${l.level}] ${l.text}`)).join("\n")}`);
  if (r.calls.length) {
    out.push(
      `Tool calls (${r.calls.length}):\n` +
        r.calls
          .map((c) => `- ${c.name}(${truncate(JSON.stringify(c.args), 120)}) → ${c.outcome}${c.error ? `: ${c.error}` : ""} [${c.durationMs} ms]`)
          .join("\n"),
    );
  }
  if (r.url.before !== r.url.after) out.push(`Page navigated: ${r.url.before} → ${r.url.after}`);
  else out.push(`Page: ${r.url.after}`);
  if (r.tools.added.length || r.tools.removed.length) {
    const diff = [...r.tools.added.map((n) => `+${n}`), ...r.tools.removed.map((n) => `-${n}`)].join(", ");
    out.push(`Tools changed: ${diff}`);
    if (options.declarations) out.push(`Updated API:\n${options.declarations}`);
  }
  return out.join("\n\n");
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return "null";
  return truncate(typeof v === "string" ? v : JSON.stringify(v, null, 2), 20_000);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s;
}
