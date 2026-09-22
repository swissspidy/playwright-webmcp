/**
 * Collector for the CDP `WebMCP` domain. It sees every tool
 * registration and invocation the browser mediates, including calls made by
 * Chrome's own agent or by other CDP clients, which page scripts cannot see.
 *
 * The session is abstracted to the two methods Playwright's CDPSession has,
 * so the collector can be unit tested with a scripted session.
 */
import type { RecordedCall } from "webmcp-lint";

const debug = process.env.WEBMCP_DEBUG ? (...args: unknown[]) => console.error(`[webmcp cdp ${new Date().toISOString().slice(11, 23)}]`, ...args) : () => {};

export interface CdpLikeSession {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  on(event: string, handler: (params: any) => void): unknown;
}

export interface CdpAnnotations {
  readOnly?: boolean;
  untrustedContent?: boolean;
  consequential?: boolean;
  debugging?: boolean;
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

type Outcome = { ok: boolean; result?: unknown; error?: string };

interface Pending {
  name: string;
  frameId: string;
  input: Record<string, unknown>;
  startedAt: number;
  /** The invoke() call that started this invocation, when it was ours. */
  ticket?: Ticket;
}

/**
 * One invoke() call. Created before WebMCP.invokeTool is sent because the
 * browser can deliver toolInvoked and toolResponded in the same chunk as the
 * command's response, in which case the events are dispatched before the
 * response's promise continuation runs.
 */
interface Ticket {
  name: string;
  via: "fixture" | "agent";
  invocationId?: string;
  /** True once the command response has named the invocation id this ticket belongs to. */
  confirmed: boolean;
  outcome?: Outcome;
  /** A completed call recorded while the claim was still provisional. */
  held?: RecordedCall;
  resolve?: (outcome: Outcome) => void;
}

export interface CdpCollectorOptions {
  /** Called for every completed invocation; `ours` is true for invocations made through invoke(). */
  onCall?: (call: RecordedCall, meta: { ours: boolean }) => void;
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
  /** invoke() calls whose invocation id is not known yet, per tool name, oldest first. */
  private readonly waiting = new Map<string, Ticket[]>();
  /** invoke() calls by invocation id. */
  private readonly tickets = new Map<string, Ticket>();
  /** Outcomes of recent invocations, so an invoke() that learns its id late can still find its response. */
  private readonly recent = new Map<string, Outcome>();
  private frameUrls = new Map<string, string>();
  enabled = false;

  constructor(
    private readonly session: CdpLikeSession,
    private readonly options: CdpCollectorOptions = {},
  ) {}

  /** Returns false when the browser does not implement the WebMCP domain. */
  async enable(): Promise<boolean> {
    if (this.enabled) return true;
    this.session.on("WebMCP.toolsAdded", (p) => {
      debug(
        "toolsAdded",
        p.tools?.map((t: any) => `${t.name}@${t.frameId}`),
      );
      this.onToolsAdded(p);
    });
    this.session.on("WebMCP.toolsRemoved", (p) => {
      debug(
        "toolsRemoved",
        p.tools?.map((t: any) => `${t.name}@${t.frameId}`),
      );
      this.onToolsRemoved(p);
    });
    this.session.on("WebMCP.toolInvoked", (p) => {
      debug("toolInvoked", p.toolName, p.invocationId, p.input);
      this.onToolInvoked(p);
    });
    this.session.on("WebMCP.toolResponded", (p) => {
      debug("toolResponded", p.invocationId, p.status, p.errorText ?? "", JSON.stringify(p.output)?.slice(0, 80));
      this.onToolResponded(p);
    });
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

  /** Frame ids with this URL, in frame-tree order (parents before children, siblings in document order). */
  frameIdsFor(url: string): string[] {
    const out: string[] = [];
    for (const [id, u] of this.frameUrls) if (u === url) out.push(id);
    return out;
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
   * A ticket is queued under the tool's name before the command is sent, so
   * the toolInvoked event can claim it whether it arrives before or after the
   * command's response. A claim made before the response is provisional: the
   * response's invocation id confirms it, or hands the claimed invocation
   * back as someone else's.
   */
  async invoke(name: string, input: Record<string, unknown>, frameId?: string, timeoutMs = 30_000, via: "fixture" | "agent" = "fixture"): Promise<Outcome> {
    const tool = this.find(name, frameId);
    if (!tool) throw new Error(`CDP collector knows no tool named "${name}"`);
    const ticket: Ticket = { name, via, confirmed: false };
    const queue = this.waiting.get(name) ?? [];
    queue.push(ticket);
    this.waiting.set(name, queue);
    let invocationId: string;
    debug("invoke ->", name, tool.frameId, JSON.stringify(input));
    try {
      ({ invocationId } = await this.session.send("WebMCP.invokeTool", { frameId: tool.frameId, toolName: name, input }));
      debug("invoke <-", name, invocationId, ticket.outcome ? "already responded" : ticket.invocationId ? "claimed" : "awaiting events");
    } catch (err) {
      debug("invoke failed", name, String((err as Error)?.message));
      this.unqueue(ticket);
      this.release(ticket);
      throw err;
    }
    if (ticket.invocationId !== undefined && ticket.invocationId !== invocationId) {
      // The events that claimed this ticket belonged to another invocation of the same tool
      // (another client's, or the browser's own agent) that landed first.
      debug("invoke rebinding", name, "claimed", ticket.invocationId, "actual", invocationId);
      this.release(ticket);
    }
    ticket.confirmed = true;
    if (ticket.held) {
      this.options.onCall?.(ticket.held, { ours: true });
      ticket.held = undefined;
    }
    if (ticket.outcome) return ticket.outcome;
    if (ticket.invocationId === undefined) {
      this.unqueue(ticket);
      // The response for our id may already have gone by while the ticket was bound elsewhere.
      const done = this.recent.get(invocationId);
      if (done) return done;
      const inFlight = this.pending.get(invocationId);
      if (inFlight) inFlight.ticket = ticket;
      // Otherwise the events have not arrived yet; bind the ticket to the id so they find it.
      ticket.invocationId = invocationId;
      this.tickets.set(invocationId, ticket);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.tickets.delete(invocationId);
        this.pending.delete(invocationId);
        reject(new Error(`Tool "${name}" did not respond within ${timeoutMs} ms`));
      }, timeoutMs);
      ticket.resolve = (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      };
      if (ticket.outcome) ticket.resolve(ticket.outcome);
    });
  }

  /** Undo a provisional claim: the invocation the ticket took was not ours after all. */
  private release(ticket: Ticket): void {
    if (ticket.invocationId === undefined) return;
    const claimed = this.pending.get(ticket.invocationId);
    if (claimed) claimed.ticket = undefined;
    this.tickets.delete(ticket.invocationId);
    if (ticket.held) this.options.onCall?.({ ...ticket.held, via: "agent" }, { ours: false });
    ticket.invocationId = undefined;
    ticket.outcome = undefined;
    ticket.held = undefined;
  }

  private remember(invocationId: string, outcome: Outcome): void {
    this.recent.set(invocationId, outcome);
    while (this.recent.size > 100) this.recent.delete(this.recent.keys().next().value!);
  }

  private unqueue(ticket: Ticket): void {
    const queue = this.waiting.get(ticket.name);
    if (!queue) return;
    const at = queue.indexOf(ticket);
    if (at >= 0) queue.splice(at, 1);
    if (!queue.length) this.waiting.delete(ticket.name);
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
    let ticket = this.tickets.get(params.invocationId);
    if (!ticket) {
      // Events beat the command response: the oldest invoke() waiting on this tool is the one.
      const claimed = this.waiting.get(params.toolName)?.shift();
      if (claimed) {
        if (!this.waiting.get(params.toolName)?.length) this.waiting.delete(params.toolName);
        claimed.invocationId = params.invocationId;
        this.tickets.set(params.invocationId, claimed);
        ticket = claimed;
      }
    }
    this.pending.set(params.invocationId, {
      name: params.toolName,
      frameId: params.frameId,
      input: parseInput(params.input),
      startedAt: Date.now(),
      ticket,
    });
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
    this.tickets.delete(params.invocationId);
    const ok = params.status === "Completed";
    const error = ok ? undefined : params.errorText || params.exception?.description || params.status;
    this.remember(params.invocationId, { ok, result: params.output, error });
    const ticket = entry.ticket;
    const call: RecordedCall = {
      name: entry.name,
      args: entry.input,
      startedAt: entry.startedAt,
      durationMs: Date.now() - entry.startedAt,
      via: ticket ? ticket.via : "agent",
      source: "cdp" as const,
      ...(ok ? { result: params.output } : { error }),
    };
    // A provisional claim is reported once the command response confirms whose invocation it was.
    if (ticket && !ticket.confirmed) ticket.held = call;
    else this.options.onCall?.(call, { ours: Boolean(ticket) });
    if (ticket) {
      ticket.outcome = { ok, result: params.output, error };
      ticket.resolve?.(ticket.outcome);
    }
  }
}
