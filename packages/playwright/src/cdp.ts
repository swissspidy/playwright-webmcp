/**
 * Collector for the CDP `WebMCP` domain (Chrome 150+). It sees every tool
 * registration and invocation the browser mediates, including calls made by
 * Chrome's own agent or by other CDP clients, which page scripts cannot see.
 *
 * The session is abstracted to the two methods Playwright's CDPSession has,
 * so the collector can be unit tested with a scripted session.
 */
import type { RecordedCall } from "webmcp-lint";

export interface CdpLikeSession {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  on(event: string, handler: (params: any) => void): unknown;
}

export interface CdpAnnotations {
  readOnly?: boolean;
  untrustedContent?: boolean;
  consequential?: boolean;
  autosubmit?: boolean;
}

export interface CdpTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: CdpAnnotations;
  frameId: string;
  /** Present for declarative tools. */
  backendNodeId?: number;
  location?: { url: string; line: number; column: number };
}

interface Pending {
  name: string;
  frameId: string;
  input: Record<string, unknown>;
  startedAt: number;
  ours: boolean;
  resolve?: (value: { ok: boolean; result?: unknown; error?: string }) => void;
}

export interface CdpCollectorOptions {
  /** Called for every completed invocation. */
  onCall?: (call: RecordedCall) => void;
}

function parseInput(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return { raw: input };
    }
  }
  return (input as Record<string, unknown>) ?? {};
}

function keyOf(frameId: string, name: string): string {
  return `${frameId}::${name}`;
}

export class CdpCollector {
  private readonly tools = new Map<string, CdpTool>();
  private readonly pending = new Map<string, Pending>();
  private readonly ownInvocations = new Set<string>();
  private frameUrls = new Map<string, string>();
  enabled = false;

  constructor(
    private readonly session: CdpLikeSession,
    private readonly options: CdpCollectorOptions = {},
  ) {}

  /** Returns false when the browser does not implement the WebMCP domain. */
  async enable(): Promise<boolean> {
    if (this.enabled) return true;
    this.session.on("WebMCP.toolsAdded", (p) => this.onToolsAdded(p));
    this.session.on("WebMCP.toolsRemoved", (p) => this.onToolsRemoved(p));
    this.session.on("WebMCP.toolInvoked", (p) => this.onToolInvoked(p));
    this.session.on("WebMCP.toolResponded", (p) => this.onToolResponded(p));
    try {
      await this.session.send("WebMCP.enable");
    } catch {
      return false;
    }
    this.enabled = true;
    await this.refreshFrames();
    return true;
  }

  async disable(): Promise<void> {
    if (!this.enabled) return;
    this.enabled = false;
    try {
      await this.session.send("WebMCP.disable");
    } catch {
      /* ignore */
    }
  }

  /** Map CDP frame ids to URLs so tools can be matched to Playwright frames. */
  async refreshFrames(): Promise<void> {
    try {
      const { frameTree } = await this.session.send("Page.getFrameTree");
      const urls = new Map<string, string>();
      const visit = (node: any) => {
        if (node?.frame?.id) urls.set(node.frame.id, node.frame.url ?? "");
        for (const child of node?.childFrames ?? []) visit(child);
      };
      visit(frameTree);
      this.frameUrls = urls;
    } catch {
      /* Page domain unavailable; leave the map as is */
    }
  }

  frameUrl(frameId: string): string | undefined {
    return this.frameUrls.get(frameId);
  }

  /** Native registrations currently known to the browser. */
  list(): CdpTool[] {
    return [...this.tools.values()];
  }

  find(name: string, frameId?: string): CdpTool | undefined {
    if (frameId) return this.tools.get(keyOf(frameId, name));
    return this.list().find((t) => t.name === name);
  }

  /**
   * Invoke a tool through the browser and wait for its response event.
   * The protocol sends the invokeTool response before toolInvoked/toolResponded,
   * so the invocation id is known before either event arrives.
   */
  async invoke(name: string, input: Record<string, unknown>, frameId?: string, timeoutMs = 30_000): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const tool = this.find(name, frameId);
    if (!tool) throw new Error(`CDP collector knows no tool named "${name}"`);
    const { invocationId } = await this.session.send("WebMCP.invokeTool", { frameId: tool.frameId, toolName: name, input });
    this.ownInvocations.add(invocationId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(invocationId);
        reject(new Error(`Tool "${name}" did not respond within ${timeoutMs} ms`));
      }, timeoutMs);
      const existing = this.pending.get(invocationId);
      const entry: Pending = existing ?? { name, frameId: tool.frameId, input, startedAt: Date.now(), ours: true };
      entry.ours = true;
      entry.resolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.pending.set(invocationId, entry);
    });
  }

  private onToolsAdded(params: { tools: any[] }) {
    for (const t of params.tools ?? []) {
      const frame = t.stackTrace?.callFrames?.[0];
      this.tools.set(keyOf(t.frameId, t.name), {
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema,
        annotations: t.annotations,
        frameId: t.frameId,
        backendNodeId: t.backendNodeId,
        location: frame ? { url: frame.url, line: (frame.lineNumber ?? 0) + 1, column: (frame.columnNumber ?? 0) + 1 } : undefined,
      });
    }
  }

  private onToolsRemoved(params: { tools: any[] }) {
    for (const t of params.tools ?? []) this.tools.delete(keyOf(t.frameId, t.name));
  }

  private onToolInvoked(params: { toolName: string; frameId: string; invocationId: string; input: unknown }) {
    const existing = this.pending.get(params.invocationId);
    const entry: Pending = existing ?? {
      name: params.toolName,
      frameId: params.frameId,
      input: parseInput(params.input),
      startedAt: Date.now(),
      ours: this.ownInvocations.has(params.invocationId),
    };
    entry.name = params.toolName;
    entry.frameId = params.frameId;
    entry.input = parseInput(params.input);
    this.pending.set(params.invocationId, entry);
  }

  private onToolResponded(params: {
    invocationId: string;
    status: "Completed" | "Canceled" | "Error";
    output?: unknown;
    errorText?: string;
    exception?: { description?: string };
  }) {
    const entry = this.pending.get(params.invocationId);
    if (!entry) return;
    this.pending.delete(params.invocationId);
    this.ownInvocations.delete(params.invocationId);
    const ok = params.status === "Completed";
    const error = ok ? undefined : (params.errorText ?? params.exception?.description ?? params.status);
    const call: RecordedCall = {
      name: entry.name,
      args: entry.input,
      startedAt: entry.startedAt,
      durationMs: Date.now() - entry.startedAt,
      via: entry.ours ? "fixture" : "agent",
      source: "cdp" as const,
      ...(ok ? { result: params.output } : { error }),
    };
    this.options.onCall?.(call);
    entry.resolve?.({ ok, result: params.output, error });
  }
}
