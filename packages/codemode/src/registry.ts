/**
 * A live view of the WebMCP tools in one page, fed by the CDP `WebMCP` and
 * `Page` domains, plus tool invocation that understands navigation.
 *
 * Two behaviours of Chromium's WebMCP domain shape this class (checked
 * against Chromium 156):
 *
 * - A cross-document navigation keeps the frame id but does not send
 *   `WebMCP.toolsRemoved` for the old document's tools. The new document's
 *   tools arrive as `toolsAdded` after `Page.frameNavigated`. The registry
 *   therefore drops a frame's tools itself when the frame navigates.
 * - An invocation still pending when its document unloads is answered with
 *   `status: "Completed"` and `output: []`. The registry reports such a call
 *   as `navigated` instead of passing the placeholder on as a result.
 */

export interface CdpLikeSession {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  on(event: string, handler: (params: any) => void): unknown;
}

export interface ToolAnnotations {
  readOnly?: boolean;
  untrustedContent?: boolean;
  consequential?: boolean;
  [key: string]: unknown;
}

export interface ToolInfo {
  /** Opaque id of this registration; a re-registration under the same name gets a new one. */
  toolId?: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  frameId: string;
}

export type InvokeOutcome =
  | { status: "completed"; output: unknown }
  /** `stale` is set when the browser refused the invocation itself, e.g. because the registration is gone. */
  | { status: "error"; error: string; stale?: boolean }
  | { status: "canceled" }
  /** The tool's document navigated away while the call was pending; `output` is set when the tool answered first. */
  | { status: "navigated"; url: string; output?: unknown };

export class WebMcpUnsupportedError extends Error {
  override name = "WebMcpUnsupportedError";
  constructor() {
    super("This browser does not implement the CDP WebMCP domain. Launch Chromium with --enable-features=WebMCP.");
  }
}

export class ToolTimeoutError extends Error {
  override name = "ToolTimeoutError";
}

export interface RegistryOptions {
  /** How long to wait for a response after the tool's frame navigated away, before reporting the call as navigated. */
  navigationGraceMs?: number;
}

interface Frame {
  url: string;
  parentId?: string;
  /** Incremented on every cross-document navigation. */
  generation: number;
}

interface Pending {
  frameId: string;
  generation: number;
  resolve: (outcome: InvokeOutcome) => void;
  graceTimer?: ReturnType<typeof setTimeout>;
}

type Responded = { status: string; output?: unknown; errorText?: string; exception?: { description?: string } };

export class ToolRegistry {
  private readonly tools = new Map<string, ToolInfo>();
  private readonly frames = new Map<string, Frame>();
  private readonly pending = new Map<string, Pending>();
  /** Responses that arrived before WebMCP.invokeTool returned their invocation id. */
  private readonly early = new Map<string, Responded>();
  private readonly listeners = new Set<() => void>();
  private readonly loadListeners = new Set<() => void>();
  private readonly loading = new Set<string>();
  private lastChange = Date.now();
  private started = false;
  mainFrameId = "";

  constructor(
    readonly session: CdpLikeSession,
    private readonly options: RegistryOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const s = this.session;
    s.on("WebMCP.toolsAdded", (p) => {
      for (const t of p.tools ?? []) {
        this.tools.set(key(t.frameId, t.name), {
          ...(t.toolId ? { toolId: t.toolId } : {}),
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema,
          annotations: t.annotations,
          frameId: t.frameId,
        });
      }
      this.changed();
    });
    s.on("WebMCP.toolsRemoved", (p) => {
      for (const t of p.tools ?? []) {
        const k = key(t.frameId, t.name);
        // A removal for an older registration must not drop the newer one with the same name.
        if (t.toolId && this.tools.get(k)?.toolId && this.tools.get(k)?.toolId !== t.toolId) continue;
        this.tools.delete(k);
      }
      this.changed();
    });
    s.on("WebMCP.toolResponded", (p) => this.onResponded(p));
    s.on("Page.frameNavigated", (p) => this.onFrameNavigated(p.frame));
    s.on("Page.frameDetached", (p) => this.dropFrame(p.frameId));
    // A frame that is loading is about to replace its tools; settle() waits for it.
    s.on("Page.frameStartedLoading", (p) => {
      this.loading.add(p.frameId);
      this.changed();
    });
    s.on("Page.frameStoppedLoading", (p) => {
      this.loading.delete(p.frameId);
      this.changed();
    });
    s.on("Page.loadEventFired", () => {
      for (const l of [...this.loadListeners]) l();
    });
    await s.send("Page.enable");
    const { frameTree } = await s.send("Page.getFrameTree");
    const visit = (node: any, parentId?: string) => {
      this.frames.set(node.frame.id, { url: node.frame.url ?? "", parentId, generation: 0 });
      for (const child of node.childFrames ?? []) visit(child, node.frame.id);
    };
    visit(frameTree);
    this.mainFrameId = frameTree.frame.id;
    try {
      await s.send("WebMCP.enable");
    } catch {
      throw new WebMcpUnsupportedError();
    }
  }

  /** The main frame's URL. */
  url(): string {
    return this.frames.get(this.mainFrameId)?.url ?? "";
  }

  /** Tools in every frame, main frame first. */
  list(): ToolInfo[] {
    const all = [...this.tools.values()];
    return [...all.filter((t) => t.frameId === this.mainFrameId), ...all.filter((t) => t.frameId !== this.mainFrameId)];
  }

  /** The tool with this name, preferring the main frame's. */
  get(name: string): ToolInfo | undefined {
    return this.tools.get(key(this.mainFrameId, name)) ?? this.list().find((t) => t.name === name);
  }

  /** Called whenever the tool list or a frame changes. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves with the tool once it is registered, or undefined after `timeoutMs`. */
  waitForTool(name: string, timeoutMs: number, signal?: AbortSignal): Promise<ToolInfo | undefined> {
    const found = this.get(name);
    if (found || timeoutMs <= 0) return Promise.resolve(found);
    return new Promise((resolve) => {
      const done = (tool: ToolInfo | undefined) => {
        clearTimeout(timer);
        off();
        signal?.removeEventListener("abort", abort);
        resolve(tool);
      };
      const abort = () => done(undefined);
      const timer = setTimeout(() => done(undefined), timeoutMs);
      const off = this.onChange(() => {
        const tool = this.get(name);
        if (tool) done(tool);
      });
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  /**
   * Resolves once no frame is loading and neither the tool list nor any frame has changed for
   * `quietMs`, or after `timeoutMs`.
   */
  async settle(quietMs = 150, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const quietFor = Date.now() - this.lastChange;
      if ((quietFor >= quietMs && !this.loading.size) || Date.now() >= deadline) return;
      await sleep(Math.max(10, Math.min(quietMs - quietFor, deadline - Date.now())));
    }
  }

  /** Invoke a tool and wait for its outcome. */
  async invoke(tool: ToolInfo, input: Record<string, unknown>, timeoutMs: number): Promise<InvokeOutcome> {
    const frame = this.frames.get(tool.frameId);
    const generation = frame?.generation ?? 0;
    let invocationId: string;
    try {
      // Prefer the registration id: it fails cleanly if the tool was re-registered in the meantime,
      // instead of reaching a different registration that happens to share the name.
      const target = tool.toolId ? { toolId: tool.toolId } : { toolName: tool.name };
      ({ invocationId } = await this.session.send("WebMCP.invokeTool", { frameId: tool.frameId, ...target, input }));
    } catch (err) {
      return { status: "error", error: String((err as Error)?.message ?? err), stale: true };
    }
    const early = this.early.get(invocationId);
    if (early) {
      this.early.delete(invocationId);
      return this.outcome(early, tool.frameId, generation);
    }
    const result = new Promise<InvokeOutcome>((resolve) => {
      this.pending.set(invocationId, { frameId: tool.frameId, generation, resolve });
      // The frame may have navigated between the command and now.
      if ((this.frames.get(tool.frameId)?.generation ?? 0) !== generation) this.startGrace(invocationId);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.forget(invocationId);
        void this.session.send("WebMCP.cancelInvocation", { invocationId }).catch(() => {});
        reject(new ToolTimeoutError(`Tool "${tool.name}" did not respond within ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([result, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Navigate the main frame and wait for the load event and the tool list to settle. */
  async navigate(url: string, timeoutMs = 30_000): Promise<void> {
    const loaded = this.waitForLoad(timeoutMs);
    const res = await this.session.send("Page.navigate", { url });
    if (res?.errorText) {
      loaded.cancel();
      throw new Error(`Navigation to ${url} failed: ${res.errorText}`);
    }
    // Same-document navigations (only the fragment changed) fire no load event.
    if (!res?.loaderId) loaded.cancel();
    else await loaded.promise;
    await this.settle();
  }

  /** Go back in the session history. Resolves false when there is no previous entry. */
  async back(timeoutMs = 30_000): Promise<boolean> {
    const { currentIndex, entries } = await this.session.send("Page.getNavigationHistory");
    const entry = entries?.[currentIndex - 1];
    if (!entry) return false;
    const loaded = this.waitForLoad(timeoutMs);
    await this.session.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    await loaded.promise.catch(() => {});
    await this.settle();
    return true;
  }

  async reload(timeoutMs = 30_000): Promise<void> {
    const loaded = this.waitForLoad(timeoutMs);
    await this.session.send("Page.reload");
    await loaded.promise;
    await this.settle();
  }

  private waitForLoad(timeoutMs: number): { promise: Promise<void>; cancel: () => void } {
    let cancel = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.loadListeners.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.loadListeners.delete(done);
        reject(new Error(`Page did not finish loading within ${timeoutMs} ms`));
      }, timeoutMs);
      cancel = () => {
        clearTimeout(timer);
        this.loadListeners.delete(done);
        resolve();
      };
      this.loadListeners.add(done);
    });
    return { promise, cancel };
  }

  private outcome(p: Responded, frameId: string, generation: number): InvokeOutcome {
    const frame = this.frames.get(frameId);
    const navigated = (frame?.generation ?? generation) !== generation || !frame;
    if (p.status === "Completed") {
      if (!navigated) return { status: "completed", output: p.output };
      const placeholder = Array.isArray(p.output) && p.output.length === 0;
      return { status: "navigated", url: frame?.url ?? "", ...(placeholder ? {} : { output: p.output }) };
    }
    if (p.status === "Canceled") return navigated ? { status: "navigated", url: frame?.url ?? "" } : { status: "canceled" };
    return { status: "error", error: p.errorText || p.exception?.description || p.status };
  }

  private onResponded(p: Responded & { invocationId: string }) {
    const entry = this.pending.get(p.invocationId);
    if (!entry) {
      // Either a response that beat its command reply, or a stale duplicate; keep a few.
      this.early.set(p.invocationId, p);
      while (this.early.size > 50) this.early.delete(this.early.keys().next().value!);
      return;
    }
    this.forget(p.invocationId);
    entry.resolve(this.outcome(p, entry.frameId, entry.generation));
  }

  private forget(invocationId: string) {
    const entry = this.pending.get(invocationId);
    if (entry?.graceTimer) clearTimeout(entry.graceTimer);
    this.pending.delete(invocationId);
  }

  private startGrace(invocationId: string) {
    const entry = this.pending.get(invocationId);
    if (!entry || entry.graceTimer) return;
    entry.graceTimer = setTimeout(() => {
      this.pending.delete(invocationId);
      entry.resolve({ status: "navigated", url: this.frames.get(entry.frameId)?.url ?? "" });
    }, this.options.navigationGraceMs ?? 2000);
  }

  private onFrameNavigated(frame: { id: string; url: string; parentId?: string; urlFragment?: string }) {
    const prev = this.frames.get(frame.id);
    this.frames.set(frame.id, {
      url: frame.url + (frame.urlFragment ?? ""),
      parentId: frame.parentId,
      generation: (prev?.generation ?? 0) + 1,
    });
    if (!frame.parentId) this.mainFrameId = frame.id;
    // The old document is gone; so are its tools and its child frames.
    for (const [k, t] of this.tools) if (t.frameId === frame.id) this.tools.delete(k);
    for (const [id, f] of this.frames) if (f.parentId === frame.id) this.dropFrame(id);
    for (const [id, p] of this.pending) if (p.frameId === frame.id) this.startGrace(id);
    this.changed();
  }

  private dropFrame(frameId: string) {
    if (!this.frames.has(frameId)) return;
    this.frames.delete(frameId);
    this.loading.delete(frameId);
    for (const [k, t] of this.tools) if (t.frameId === frameId) this.tools.delete(k);
    for (const [id, f] of this.frames) if (f.parentId === frameId) this.dropFrame(id);
    for (const [id, p] of this.pending) if (p.frameId === frameId) this.startGrace(id);
    this.changed();
  }

  private changed() {
    this.lastChange = Date.now();
    for (const l of [...this.listeners]) l();
  }
}

function key(frameId: string, name: string) {
  return `${frameId}::${name}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
