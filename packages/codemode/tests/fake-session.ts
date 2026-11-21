import type { CdpLikeSession } from "../src/index.js";

/**
 * A scripted CDP session. `respond` decides what happens when a tool is invoked:
 * return events to emit after the command reply (or nothing to leave the call pending).
 */
export class FakeSession implements CdpLikeSession {
  handlers = new Map<string, Array<(p: any) => void>>();
  sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  next = 1;
  webmcp = true;
  history = { currentIndex: 0, entries: [{ id: 1, url: "http://shop/" }] };
  /** Overrides for commands; return undefined to fall through to the defaults. */
  commands: Record<string, (params?: Record<string, unknown>) => unknown> = {};
  respond?: (invocationId: string, params: Record<string, unknown>) => void;

  async send(method: string, params?: Record<string, unknown>) {
    this.sent.push({ method, params });
    const override = this.commands[method]?.(params);
    if (override instanceof Error) throw override;
    if (override !== undefined) return override;
    switch (method) {
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "main", url: "http://shop/" }, childFrames: [{ frame: { id: "child", url: "http://shop/ad" } }] } };
      case "WebMCP.enable":
        if (!this.webmcp) throw new Error("'WebMCP.enable' wasn't found");
        return {};
      case "WebMCP.invokeTool": {
        const invocationId = `inv-${this.next++}`;
        if (this.respond) setTimeout(() => this.respond!(invocationId, params!), 0);
        return { invocationId };
      }
      case "Page.getNavigationHistory":
        return this.history;
      default:
        return {};
    }
  }
  on(event: string, handler: (p: any) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  emit(event: string, params: any) {
    for (const h of this.handlers.get(event) ?? []) h(params);
  }
  addTools(...tools: Array<Record<string, unknown>>) {
    this.emit("WebMCP.toolsAdded", {
      tools: tools.map((t) => ({ description: String(t.name), frameId: "main", inputSchema: { type: "object", properties: {} }, ...t })),
    });
  }
  /** Answer every invocation with the given tool response fields. */
  answer(fields: (input: Record<string, unknown>, toolName: string) => Record<string, unknown>) {
    this.respond = (invocationId, params) =>
      this.emit("WebMCP.toolResponded", { invocationId, ...fields((params.input ?? {}) as Record<string, unknown>, String(params.toolName ?? params.toolId)) });
  }
}

export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
