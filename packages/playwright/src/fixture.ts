import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test as base, type Browser, type CDPSession, type Frame, type Page, type TestInfo } from "@playwright/test";
import {
  ATTACHMENTS,
  collectFrame,
  computeCoverage,
  computeScore,
  diffContracts,
  formatChanges,
  judgeTimeline,
  lint,
  reconcileCalls,
  renderToolDocs,
  serializeContract,
  toContract,
  toPlaywrightTest,
  type CodegenOptions,
  type ContractChange,
  type CoverageReport,
  type EvalCase,
  type FrameCollectResult,
  type LintOptions,
  type LintResult,
  type PageSnapshot,
  type RecordedCall,
  type ReconcileOptions,
  type RegistrationEvent,
  type Score,
  type SmokeReport,
  type TimelineBudgets,
  type TimelineReport,
  type ToolContract,
  type ToolSnapshot,
} from "@swissspidy/webmcp-lint";
import { CdpCollector, type CdpTool } from "./cdp.js";

const debug = process.env.WEBMCP_DEBUG
  ? (...args: unknown[]) => console.error(`[webmcp fixture ${new Date().toISOString().slice(11, 23)}]`, ...args)
  : () => {};
import { runSmoke, type SmokeOptions } from "./smoke.js";
import { RECORDER_SOURCE } from "./recorder.js";
import { executeToolInputShape, type ExecuteToolInputShape } from "./input-shape.js";
import { PromptApiHarness } from "./prompt-api.js";

export interface WebMCPOptions {
  /** Record tool executions triggered from inside the page. */
  record: boolean;
  /** Default lint options for `webmcp.lint()` and `toPassLint()`. */
  lint: LintOptions;
  /**
   * "auto": attach to the CDP WebMCP domain when the browser has it, so calls
   * made by Chrome's own agent are recorded too. "never": page-side hooks only.
   */
  cdp: "auto" | "never";
}

export const DEFAULT_OPTIONS: WebMCPOptions = { record: true, lint: {}, cdp: "auto" };

export { ATTACHMENTS };

export type MockImplementation = ((args: Record<string, unknown>) => unknown | Promise<unknown>) | { result: unknown } | { error: string };

export interface ReachableTool {
  name: string;
  origin: string;
  remote: boolean;
}

export interface ContractMatchResult {
  pass: boolean;
  /** "matched" | "written" (new or updated on disk) | "changed" */
  outcome: "matched" | "written" | "changed";
  path: string;
  changes: ContractChange[];
  contract: ToolContract;
}

const instances = new WeakMap<Page, WebMCP>();

/** Thrown by call() when no frame currently lists the tool; call() retries on it until its timeout. */
export class ToolNotFoundError extends Error {}

export class WebMCP {
  private recorded: RecordedCall[] = [];
  private installed = false;
  private cdpSession: CDPSession | undefined;
  private timelineEvents: RegistrationEvent[] = [];
  /** The page's id for each timeline event, so a rejection can take back the report it follows. */
  private readonly registrationIds = new WeakMap<RegistrationEvent, string>();
  private readonly mocks = new Map<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>();
  private lastSnapshot: PageSnapshot | undefined;
  /** CDP collector; `enabled` is true only when the browser implements the WebMCP domain. */
  cdp: CdpCollector | undefined;

  constructor(
    readonly page: Page,
    private readonly testInfo: TestInfo | undefined,
    readonly options: WebMCPOptions = DEFAULT_OPTIONS,
  ) {
    instances.set(page, this);
  }

  /** Returns the fixture instance bound to a page, if one exists. */
  static for(page: Page): WebMCP | undefined {
    return instances.get(page);
  }

  /** Install the recorder. Must run before navigation; the fixture does this for you. */
  async install(): Promise<void> {
    if (this.installed) return;
    this.installed = true;
    if (this.options.record) {
      await this.page.exposeBinding("__webmcpReport", (source, json: string) => {
        const entry = JSON.parse(json) as { kind?: string } & Record<string, unknown>;
        if (entry.kind === "registration") {
          // A report from a document that has since been navigated away can arrive after the
          // navigation reset the timeline; it belongs to the old page, not this one.
          if (typeof entry.frameUrl === "string" && source.frame.url() !== entry.frameUrl) return;
          const id = typeof entry.id === "string" ? entry.id : undefined;
          if (entry.type === "rejected") {
            // The page reports a registration as it makes it; the browser refused this one.
            if (id !== undefined) this.timelineEvents = this.timelineEvents.filter((e) => this.registrationIds.get(e) !== id);
            return;
          }
          const event: RegistrationEvent = {
            type: entry.type as RegistrationEvent["type"],
            name: String(entry.name),
            at: Number(entry.at),
            frameUrl: String(entry.frameUrl),
          };
          if (id !== undefined) this.registrationIds.set(event, id);
          this.timelineEvents.push(event);
        } else {
          const { kind: _kind, ...call } = entry;
          this.recordObserved(call as unknown as RecordedCall);
        }
      });
      await this.page.exposeBinding("__webmcpMock", async (_source, json: string) => {
        const { name, args } = JSON.parse(json) as { name: string; args: Record<string, unknown> };
        const impl = this.mocks.get(name);
        if (!impl) return JSON.stringify({ __error: `No mock installed for ${name}` });
        try {
          const result = await impl(args ?? {});
          return JSON.stringify(result === undefined ? null : result);
        } catch (err) {
          return JSON.stringify({ __error: String((err as Error)?.message ?? err) });
        }
      });
      this.page.on("framenavigated", (frame) => {
        if (frame === this.page.mainFrame()) this.timelineEvents = [];
      });
    }
    if (this.options.record) await this.page.addInitScript(RECORDER_SOURCE);
    if (this.options.cdp === "auto") await this.attachCdp();
  }

  /** Try to attach the CDP WebMCP collector. Returns whether the domain is available. */
  async attachCdp(): Promise<boolean> {
    if (this.cdp?.enabled) return true;
    try {
      this.cdpSession = await this.page.context().newCDPSession(this.page);
    } catch {
      return false;
    }
    const collector = new CdpCollector(this.cdpSession, { onCall: (call, meta) => this.recordObserved(call, meta.ours) });
    const ok = await collector.enable();
    if (!ok) {
      await this.cdpSession.detach().catch(() => {});
      this.cdpSession = undefined;
      return false;
    }
    this.cdp = collector;
    return true;
  }

  /** Collect tools and frame facts from every frame of the page. */
  async snapshot(): Promise<PageSnapshot> {
    const frames = this.page.frames();
    const topOrigin = safeOrigin(this.page.url());
    // With the CDP registry at hand a page-side getTools() that hangs is not fatal, so wait less for it.
    const getToolsTimeoutMs = this.cdp?.enabled ? 1000 : 3000;
    const results = await Promise.all(frames.map((f) => collectInFrame(f, getToolsTimeoutMs)));
    debug(
      "snapshot collected",
      results.map((r, i) => `${frames[i].url()}: ${r ? (r.frame.error ? `error(${r.frame.error})` : r.tools.map((t) => t.name).join("+")) : "none"}`),
    );
    // Playwright and CDP both list frames parents first, siblings in document order, so the n-th
    // frame with a URL on one side is the n-th with that URL on the other. Matching by URL alone
    // would give two same-URL iframes each other's tools.
    const registryFor = (i: number): CdpTool[] => {
      const url = frames[i].url();
      const position = frames.slice(0, i).filter((f) => f.url() === url).length;
      const frameId = this.cdp!.frameIdsFor(url)[position];
      return frameId === undefined ? [] : this.cdp!.list().filter((c) => c.frameId === frameId);
    };
    if (this.cdp?.enabled) {
      // The browser's registry is the source of truth. When a frame's own getTools() has not
      // caught up with a tool the CDP domain already reported for it, look at that frame again.
      await this.cdp.refreshFrames();
      for (let attempt = 0; attempt < 20; attempt++) {
        const lagging = frames
          .map((f, i) => i)
          .filter((i) => {
            const r = results[i];
            if (!r || r.frame.error) return false; // filled from the registry below
            const listed = new Set(r.tools.map((t) => t.name));
            return registryFor(i).some((c) => !listed.has(c.name));
          });
        if (!lagging.length) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
        for (const i of lagging) results[i] = await collectInFrame(frames[i], getToolsTimeoutMs);
      }
    }
    const snapshot: PageSnapshot = { url: this.page.url(), capturedAt: new Date().toISOString(), frames: [], tools: [] };
    this.lastSnapshot = snapshot;
    for (let i = 0; i < frames.length; i++) {
      let r = results[i];
      if (this.cdp?.enabled && (!r || r.frame.error)) {
        // getTools() failed or never settled in this frame (seen on Chrome under load); the
        // registry the browser reported over CDP stands in for it.
        const url = frames[i].url();
        const fromRegistry = registryFor(i);
        debug(
          "snapshot fallback",
          url,
          "registry:",
          fromRegistry.map((c) => c.name),
          "frame ids for url:",
          this.cdp.frameIdsFor(url),
        );
        if (fromRegistry.length) {
          const frame: FrameCollectResult["frame"] = {
            url,
            origin: safeOrigin(url),
            isTop: i === 0,
            api: "native",
            error: r?.frame.error ?? "evaluate failed",
          };
          r = { frame, tools: fromRegistry.map((c) => toolFromRegistry(c, frame.origin)) };
          results[i] = r;
        }
      }
      if (!r) {
        snapshot.frames.push({ url: frames[i].url(), origin: safeOrigin(frames[i].url()), isTop: i === 0, api: "none" });
        continue;
      }
      snapshot.frames.push({ ...r.frame, crossOriginFromTop: i > 0 && r.frame.origin !== topOrigin });
      for (const t of r.tools) snapshot.tools.push({ ...t, frame: i });
    }
    if (this.cdp?.enabled) {
      await this.cdp.refreshFrames();
      for (const tool of snapshot.tools) {
        const native = registryFor(tool.frame).find((c) => c.name === tool.name) ?? this.cdp.find(tool.name);
        if (!native) continue;
        if (native.location) tool.location = native.location;
        if (native.annotations && !tool.annotations) tool.annotations = { ...native.annotations };
        if (native.backendNodeId !== undefined && tool.source !== "declarative") tool.source = "declarative";
      }
    }
    return snapshot;
  }

  /**
   * Execute generated inputs against tools and judge the results. Without
   * `tools` or `all`, only tools annotated read-only are exercised.
   */
  async smoke(options: SmokeOptions = {}): Promise<SmokeReport & { skipped: string[] }> {
    const tools = await this.tools();
    const report = await runSmoke(tools, (name, args) => this.call(name, args), options);
    await this.attach(ATTACHMENTS.smoke, { url: this.page.url(), ...report });
    return report;
  }

  /**
   * Tools an agent running in the given frame can actually reach through the
   * API: its own, same-origin frames', and cross-origin frames' tools that
   * are both allowed by the embedding <iframe> and exposed to this origin.
   */
  async reachableTools(options: { from?: number } = {}): Promise<ReachableTool[]> {
    const frame = this.page.frames()[options.from ?? 0];
    if (!frame) throw new Error(`No frame at index ${options.from}`);
    return frame.evaluate(async () => {
      const mc = document.modelContext;
      if (!mc) return [];
      const origins = new Set<string>();
      for (const el of Array.from(document.querySelectorAll("iframe"))) {
        try {
          const origin = new URL((el as HTMLIFrameElement).src, location.href).origin;
          if (origin !== location.origin) origins.add(origin);
        } catch {}
      }
      const listed = origins.size ? await mc.getTools({ fromOrigins: [...origins] }) : await mc.getTools();
      return listed.map((t) => ({
        name: String(t.name),
        origin: String(t.origin ?? location.origin),
        remote: Boolean(t.origin && t.origin !== location.origin),
      }));
    });
  }

  /** Replace a tool's implementation from the test. The mock runs in Node. */
  async mock(name: string, implementation: MockImplementation): Promise<void> {
    if (!this.options.record) throw new Error("mock() needs the recorder; set webmcpOptions.record to true");
    const impl =
      typeof implementation === "function"
        ? implementation
        : "error" in implementation
          ? () => {
              throw new Error(implementation.error);
            }
          : () => implementation.result;
    this.mocks.set(name, impl);
    const owner = await this.ownerFrame(name);
    await owner.evaluate((toolName) => (window as unknown as Record<string, any>).__webmcpInstallMock(toolName), name);
  }

  /** Restore a mocked tool's original implementation when the page still has it. */
  async unmock(name: string): Promise<boolean> {
    this.mocks.delete(name);
    const owner = await this.ownerFrame(name);
    return owner.evaluate((toolName) => (window as unknown as Record<string, any>).__webmcpRestoreMock(toolName), name);
  }

  async unmockAll(): Promise<void> {
    for (const name of [...this.mocks.keys()]) await this.unmock(name).catch(() => {});
  }

  /**
   * Mock every tool that appears in a recording so that calls with the same
   * arguments return the recorded result (or throw the recorded error).
   * Unmatched arguments fall back to the first recording for that tool.
   */
  async replay(recording: RecordedCall[], options: { strict?: boolean } = {}): Promise<void> {
    const byName = new Map<string, RecordedCall[]>();
    for (const c of recording) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
    for (const [name, entries] of byName) {
      await this.mock(name, (args) => {
        const key = JSON.stringify(args ?? {});
        const hit = entries.find((e) => JSON.stringify(e.args ?? {}) === key) ?? (options.strict ? undefined : entries[0]);
        if (!hit) throw new Error(`No recording of ${name} for arguments ${key}`);
        if (hit.error) throw new Error(hit.error);
        return hit.result;
      });
    }
  }

  /** Registration timeline for the current navigation, with late-registration and churn findings. */
  async timeline(budgets: TimelineBudgets = {}): Promise<TimelineReport> {
    // Registrations report as the page makes them, and a rejection takes one back once the browser
    // answers; wait for the tool list to stop changing, then let this evaluate's round trip flush the
    // reports that travel on the same channel.
    await this.settle();
    const marks = await this.page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      return { domContentLoaded: nav?.domContentLoadedEventEnd, load: nav?.loadEventEnd };
    });
    const report = judgeTimeline(this.timelineEvents, marks, budgets);
    await this.attach(ATTACHMENTS.timeline, { url: this.page.url(), ...report });
    return report;
  }

  /** Which exposed tools and parameters the recorded calls exercised. */
  async coverage(): Promise<CoverageReport> {
    return computeCoverage(await this.tools(), this.calls());
  }

  /** Agent-readiness score from lint, optional smoke, and coverage. */
  async score(options: { smoke?: SmokeReport | boolean } = {}): Promise<Score> {
    const lintResult = await this.lint();
    const smoke = options.smoke === true ? await this.smoke() : options.smoke || undefined;
    return computeScore({ lint: lintResult, smoke, coverage: await this.coverage() });
  }

  /** Playwright test source that reproduces the recorded calls. */
  codegen(options: Partial<CodegenOptions> & { name: string }): string {
    let url = "/";
    try {
      const u = new URL(this.page.url());
      url = u.pathname + u.search;
    } catch {}
    return toPlaywrightTest({ url, calls: this.calls(), ...options });
  }

  /** Markdown reference of the page's tools, with examples from recorded calls. */
  async docs(options: { title?: string } = {}): Promise<string> {
    return renderToolDocs(await this.contract(), { calls: this.calls(), url: this.page.url(), title: options.title });
  }

  private async ownerFrame(name: string): Promise<Frame> {
    const frames = this.page.frames();
    const results = await Promise.all(frames.map((f) => collectInFrame(f)));
    const owner = frames.find((_f, i) => results[i]?.tools.some((t) => t.name === name));
    if (!owner) throw new Error(`No WebMCP tool named "${name}" found on ${this.page.url()}`);
    return owner;
  }

  /** The page's current tool contract: names, descriptions, schemas, annotations, sorted and key-stable. */
  async contract(): Promise<ToolContract> {
    return toContract(await this.snapshot());
  }

  /** Whether matchToolContract(name) would write the stored contract rather than compare against it. */
  updatesSnapshots(name = "webmcp-contract.json"): boolean {
    if (!this.testInfo) return false;
    const mode = this.testInfo.config.updateSnapshots;
    if (mode === "all" || mode === "changed") return true;
    return mode !== "none" && !existsSync(this.testInfo.snapshotPath(name));
  }

  /**
   * Compare the page's tool contract with the one stored next to the test
   * (via testInfo.snapshotPath). Honours Playwright's --update-snapshots.
   */
  async matchToolContract(name = "webmcp-contract.json"): Promise<ContractMatchResult> {
    if (!this.testInfo) throw new Error("matchToolContract() needs the test fixture");
    const contract = await this.contract();
    const path = this.testInfo.snapshotPath(name);
    const mode = this.testInfo.config.updateSnapshots;
    const exists = existsSync(path);
    if (!exists) {
      if (mode === "none")
        return {
          pass: false,
          outcome: "changed",
          path,
          changes: contract.tools.map((t) => ({ kind: "tool-added", tool: t.name, detail: "no stored contract" })),
          contract,
        };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, serializeContract(contract));
      return { pass: true, outcome: "written", path, changes: [], contract };
    }
    const stored = JSON.parse(readFileSync(path, "utf8")) as ToolContract;
    const changes = diffContracts(stored, contract);
    if (!changes.length) return { pass: true, outcome: "matched", path, changes, contract };
    if (mode === "all" || mode === "changed") {
      writeFileSync(path, serializeContract(contract));
      return { pass: true, outcome: "written", path, changes, contract };
    }
    await this.attach(ATTACHMENTS.contract, { path, changes: formatChanges(changes), contract });
    return { pass: false, outcome: "changed", path, changes, contract };
  }

  async tools(): Promise<ToolSnapshot[]> {
    return (await this.snapshot()).tools;
  }

  async tool(name: string): Promise<ToolSnapshot | undefined> {
    return (await this.tools()).find((t) => t.name === name);
  }

  /** Run the lint rules against the current page and attach the result to the test. */
  async lint(options: LintOptions = {}): Promise<LintResult> {
    const snapshot = await this.snapshot();
    const merged: LintOptions = {
      ...this.options.lint,
      ...options,
      rules: { ...(this.options.lint.rules ?? {}), ...(options.rules ?? {}) },
      extraRules: [...(this.options.lint.extraRules ?? []), ...(options.extraRules ?? [])],
    };
    const result = lint(snapshot, merged);
    await this.attach(ATTACHMENTS.lint, { url: snapshot.url, ...result });
    return result;
  }

  /**
   * Execute a tool through the page's modelContext and record the call.
   * Waits up to `timeoutMs` (default 5000) for the tool to be registered, since
   * pages register tools after load and native getTools() can lag behind.
   */
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}, options: { timeoutMs?: number; via?: "fixture" | "agent" } = {}): Promise<T> {
    const deadline = Date.now() + (options.timeoutMs ?? 5000);
    for (;;) {
      try {
        return await this.callOnce<T>(name, args, options.via ?? "fixture");
      } catch (err) {
        if (!(err instanceof ToolNotFoundError) || Date.now() >= deadline) throw err;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  private async callOnce<T>(name: string, args: Record<string, unknown>, via: "fixture" | "agent"): Promise<T> {
    if (process.env.WEBMCP_DEBUG)
      console.error(
        `[webmcp call ${new Date().toISOString().slice(11, 23)}] ${name} via=${via} cdp=${Boolean(this.cdp?.enabled && this.cdp.find(name))} url=${this.page.url()}`,
      );
    if (this.cdp?.enabled && this.cdp.find(name)) {
      const outcome = await this.cdp.invoke(name, args, undefined, undefined, via);
      if (!outcome.ok) throw new Error(`Tool "${name}" failed: ${outcome.error}`);
      // toolResponded.output carries the value the agent gets; Chrome sends the string "undefined" for no result.
      return (outcome.result === "undefined" ? undefined : outcome.result) as T;
    }
    const frames = this.page.frames();
    const results = await Promise.all(frames.map((f) => collectInFrame(f)));
    const owner = frames.find((_f, i) => results[i]?.tools.some((t) => t.name === name));
    if (!owner) {
      const problems = results
        .map((r, i) => (r === null ? `${frames[i].url()}: evaluate failed` : r.frame.error ? `${r.frame.url}: ${r.frame.error}` : null))
        .filter(Boolean);
      const known = results.flatMap((r) => r?.tools.map((t) => t.name) ?? []);
      throw new ToolNotFoundError(
        `No WebMCP tool named "${name}" found on ${this.page.url()} (known: ${known.join(", ") || "none"}${
          this.cdp?.enabled
            ? `; cdp knows: ${
                this.cdp
                  .list()
                  .map((t) => t.name)
                  .join(", ") || "none"
              }`
            : ""
        }${problems.length ? `; ${problems.join("; ")}` : ""})`,
      );
    }
    const startedAt = Date.now();
    const outcome = await owner.evaluate(
      async ([toolName, toolArgs, shape]) => {
        const mc = document.modelContext!;
        const listed = (await mc.getTools()) ?? [];
        const tool = listed.find((t) => t.name === toolName);
        if (!tool) return { ok: false as const, error: `No WebMCP tool named "${toolName}" is registered` };
        try {
          // executeTool() takes the RegisteredTool object. The specification declares the input as an
          // object; Chrome 154 and earlier took only a JSON string, which `shape` accounts for.
          const input = shape === "string" ? JSON.stringify(toolArgs) : toolArgs;
          const raw: unknown = await mc.executeTool(tool, input as object, { __playwrightWebmcp: true } as never);
          // The result arrives as a string: JSON for objects, String(value) for primitives, "undefined" for no result.
          let result: unknown;
          if (typeof raw !== "string") result = JSON.parse(JSON.stringify(raw === undefined ? null : raw));
          else if (raw === "undefined") result = undefined;
          else {
            try {
              result = JSON.parse(raw);
            } catch {
              result = raw;
            }
          }
          return { ok: true as const, result };
        } catch (err) {
          return { ok: false as const, error: String((err as Error)?.message ?? err) };
        }
      },
      [name, args, this.inputShape()] as const,
    );
    const entry: RecordedCall = {
      name,
      args,
      startedAt,
      durationMs: Date.now() - startedAt,
      via,
      ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }),
    };
    this.recorded.push(entry);
    if (!outcome.ok) throw new Error(`Tool "${name}" failed: ${outcome.error}`);
    return outcome.result as T;
  }

  /**
   * The shape `executeTool()` takes in this browser: an object as the
   * specification says, or the JSON string Chrome 154 and earlier required.
   */
  inputShape(): ExecuteToolInputShape {
    return executeToolInputShape(this.page.context().browser()?.version());
  }

  /** All recorded calls so far, in execution order. */
  calls(): RecordedCall[] {
    return [...this.recorded].sort((a, b) => a.startedAt - b.startedAt);
  }

  clearCalls(): void {
    this.recorded = [];
  }

  /**
   * Wait for calls reported by page scripts to reach the recorder, then for
   * the set of registered tools to stop changing. Binding calls are delivered
   * in order with other protocol traffic, so one round trip flushes what the
   * page has reported; registration is asynchronous (natively in particular),
   * so the tool list is polled until it is unchanged for `quietMs`.
   */
  async settle(options: { quietMs?: number; timeoutMs?: number } = {}): Promise<void> {
    await this.page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0))).catch(() => {});
    const quietMs = options.quietMs ?? 150;
    const deadline = Date.now() + (options.timeoutMs ?? 2000);
    const key = async () => {
      const frames = this.page.frames();
      const results = await Promise.all(frames.map((f) => collectInFrame(f, this.cdp?.enabled ? 1000 : 3000)));
      // The browser's registry counts too: a registration it has reported that a frame's getTools() has not caught up with is still a change.
      const registry = this.cdp?.enabled
        ? this.cdp
            .list()
            .map((t) => `${t.frameId}::${t.name}`)
            .sort()
        : [];
      return JSON.stringify([results.map((r) => r?.tools.map((t) => t.name).sort() ?? null), registry]);
    };
    let previous = await key();
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, quietMs));
      const next = await key();
      if (next === previous) return;
      previous = next;
    }
  }

  /** Attach the current snapshot and calls to the test result (done automatically at teardown). */
  async flush(): Promise<void> {
    if (this.cdp) await this.cdp.disable();
    if (this.cdpSession) await this.cdpSession.detach().catch(() => {});
    if (!this.testInfo) return;
    if (this.recorded.length) await this.attach(ATTACHMENTS.calls, this.calls());
    if (this.lastSnapshot) await this.attach(ATTACHMENTS.toolSnapshots, this.lastSnapshot.tools);
    if (this.timelineEvents.length) await this.attach(ATTACHMENTS.timeline, { url: this.page.url(), events: this.timelineEvents });
  }

  /** @internal */
  record(call: RecordedCall): void {
    this.recordObserved(call);
  }

  private readonly matchedObservations = new WeakSet<RecordedCall>();

  /**
   * Page-side hooks and the CDP domain both observe an execution the browser
   * mediates. Keep one record: the page hook knows whether page script started
   * it ("api"), the CDP collector knows whether the fixture did ("fixture") and
   * sees agent calls the page cannot. Matching is by tool, arguments and time.
   */
  private recordObserved(call: RecordedCall, ownInvocation = false): void {
    const fromCdp = call.source === "cdp";
    const key = JSON.stringify(call.args ?? {});
    const twin = this.recorded.find(
      (c) =>
        !this.matchedObservations.has(c) &&
        (c.source === "cdp") !== fromCdp &&
        c.name === call.name &&
        Math.abs(c.startedAt - call.startedAt) < 5000 &&
        JSON.stringify(c.args ?? {}) === key,
    );
    if (!twin) {
      this.recorded.push(call);
      return;
    }
    this.matchedObservations.add(twin);
    const cdp = fromCdp ? call : twin;
    const page = fromCdp ? twin : call;
    twin.source = "cdp";
    // The collector knows what it invoked itself (fixture or an agent driver); otherwise the page side knows best.
    twin.via = fromCdp && ownInvocation ? cdp.via : page.via;
    if (twin.result === undefined && cdp.result !== undefined && cdp.result !== "undefined") twin.result = cdp.result;
    if (!twin.error && cdp.error) twin.error = cdp.error;
  }

  /** @internal */
  async attach(name: string, body: unknown): Promise<void> {
    if (!this.testInfo) return;
    await this.testInfo.attach(name, { body: JSON.stringify(body, null, 2), contentType: "application/json" });
  }
}

async function collectInFrame(frame: Frame, getToolsTimeoutMs = 3000): Promise<FrameCollectResult | null> {
  try {
    return await frame.evaluate(collectFrame, { getToolsTimeoutMs });
  } catch {
    return null;
  }
}

/** A registration the CDP domain reported, as the page-side collector would have described it. */
function toolFromRegistry(tool: CdpTool, origin: string): Omit<ToolSnapshot, "frame"> {
  // The CDP domain spells the hints without the "Hint" suffix; the page's getTools() spells them with it.
  // Use the page's spelling so a snapshot built from the registry matches one built from the page.
  const a = tool.annotations;
  const declarative = tool.backendNodeId !== undefined;
  const annotations = !a
    ? undefined
    : declarative
      ? { autosubmit: Boolean(a.autosubmit) }
      : {
          readOnlyHint: Boolean(a.readOnly),
          consequentialHint: Boolean(a.consequential),
          untrustedContentHint: Boolean(a.untrustedContent),
          debugging: Boolean(a.debugging),
        };
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? null,
    annotations,
    origin,
    source: declarative ? "declarative" : "imperative",
    location: tool.location,
  };
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

export interface WebMCPFixtures {
  webmcp: WebMCP;
  /** Chrome's on-device model (the Prompt API) driving the page's tools; created only when a test asks for it. */
  promptApi: PromptApiHarness;
}

export interface WebMCPFixtureOptions {
  webmcpOptions: Partial<WebMCPOptions>;
}

/**
 * Set WEBMCP_CDP to a DevTools endpoint (e.g. http://localhost:9222) to run
 * tests in a Chrome you launched yourself, with the WebMCP and Prompt API
 * flags enabled in that profile. Playwright's own launch uses a fresh profile
 * where chrome://flags settings do not apply; pass `--enable-features=WebMCP`
 * through `launchOptions.args` there instead.
 */
export const test = base.extend<WebMCPFixtures & WebMCPFixtureOptions>({
  browser: [
    async ({ playwright, browser }, use) => {
      const endpoint = process.env.WEBMCP_CDP;
      if (!endpoint) return use(browser);
      const connected: Browser = await playwright.chromium.connectOverCDP(endpoint);
      await use(connected);
      await connected.close();
    },
    { scope: "worker" },
  ],
  webmcpOptions: [{}, { option: true }],
  webmcp: async ({ page, webmcpOptions }, use, testInfo) => {
    const instance = new WebMCP(page, testInfo, { ...DEFAULT_OPTIONS, ...webmcpOptions, lint: { ...DEFAULT_OPTIONS.lint, ...(webmcpOptions.lint ?? {}) } });
    await instance.install();
    await use(instance);
    await instance.flush();
  },
  promptApi: async ({ webmcp }, use) => {
    await use(new PromptApiHarness(webmcp));
  },
});
