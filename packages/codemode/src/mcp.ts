/**
 * A minimal MCP server (newline-delimited JSON-RPC over stdio) with two tools:
 * `webmcp_api` returns the current sandbox declarations, `webmcp_execute`
 * runs a script. Hand-rolled to keep the package free of SDK dependencies.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { formatResult, type CodeMode } from "./codemode.js";

const SERVER_INFO = { name: "webmcp-codemode", version: "0.0.0" };
// 2025-03-26 is left out: it requires JSON-RPC batch support, which this server does not have.
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2024-11-05"];

/**
 * The two tools, as MCP tool definitions (`name`, `description`, `inputSchema`, `annotations`).
 * Reuse them to offer code mode through another tool-calling API.
 */
export const TOOL_DEFINITIONS = [
  {
    name: "webmcp_api",
    description:
      "TypeScript declarations for the tools the current page exposes through WebMCP, plus browser helpers. Read this before writing a script for webmcp_execute.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "webmcp_execute",
    description: [
      "Run JavaScript in a sandbox that can call the current page's WebMCP tools. Use it to chain several tool calls in one step instead of calling tools one at a time.",
      "Write an async function body (use await, return the value you want back) or `async () => { ... }`.",
      "Available globals: `tools.<name>(args)` calls a page tool, `browser.goto/back/reload/url/tools/waitForTool/sleep`, `console.log`. There is no DOM, network or file access.",
      "Tool calls survive navigation: after a tool or browser.goto() loads another page, calling a tool that page registers waits for it to appear.",
      "The response lists every tool call, console output, and, when the page's tools changed, the updated API.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "JavaScript to run" } },
      required: ["code"],
      additionalProperties: false,
    },
  },
] as const;

export interface McpServerOptions {
  input?: Readable;
  output?: Writable;
  /** Reported in serverInfo. */
  version?: string;
}

/** Serve `codeMode` over stdio (or the given streams). Resolves when the input ends. */
export function createMcpServer(codeMode: CodeMode, options: McpServerOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const send = (msg: unknown) => output.write(JSON.stringify(msg) + "\n");
  const rl = createInterface({ input, crlfDelay: Infinity });
  const inflight = new Set<Promise<unknown>>();

  const handle = async (msg: any): Promise<unknown> => {
    switch (msg.method) {
      case "initialize": {
        const requested = msg.params?.protocolVersion;
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO, ...(options.version ? { version: options.version } : {}) },
          instructions: "Call webmcp_api to see the page's tools as a TypeScript API, then webmcp_execute to run a script against them.",
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOL_DEFINITIONS };
      case "tools/call": {
        const name = msg.params?.name;
        const args = msg.params?.arguments ?? {};
        if (name === "webmcp_api") {
          await codeMode.registry.settle();
          return { content: [{ type: "text", text: codeMode.declarations() }] };
        }
        if (name === "webmcp_execute") {
          if (typeof args.code !== "string") return { content: [{ type: "text", text: "`code` must be a string" }], isError: true };
          const result = await codeMode.execute(args.code);
          return {
            content: [{ type: "text", text: formatResult(result, { declarations: codeMode.declarations() }) }],
            isError: !result.ok,
          };
        }
        throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
      }
      default:
        throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
    }
  };

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string") {
      const id = msg && typeof msg === "object" && !Array.isArray(msg) && (typeof msg.id === "string" || typeof msg.id === "number") ? msg.id : null;
      send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    // Notifications (no id) need no answer.
    if (msg.id === undefined || msg.id === null) return;
    const p: Promise<unknown> = handle(msg)
      .then(
        (result) => send({ jsonrpc: "2.0", id: msg.id, result }),
        (err) => send({ jsonrpc: "2.0", id: msg.id, error: { code: err?.code ?? -32603, message: String(err?.message ?? err) } }),
      )
      .finally(() => inflight.delete(p));
    inflight.add(p);
  });

  return new Promise((resolve) => {
    rl.on("close", () => {
      void Promise.all(inflight).then(() => resolve());
    });
  });
}
