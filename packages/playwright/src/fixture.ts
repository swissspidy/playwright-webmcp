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
} from "webmcp-lint";
import { CdpCollector } from "./cdp.js";
import { runSmoke, type SmokeOptions } from "./smoke.js";
import { shimSource } from "./shim.js";
import { RECORDER_SOURCE } from "./recorder.js";
import { normalizeRunOptions, runPromptApiInPage, type PromptApiRunOptions, type PromptApiRunResult } from "./prompt-api.js";
import { fakeLanguageModelSource, type FakeLanguageModelPlan } from "./fake-language-model.js";

export interface WebMCPOptions {
  /**
   * "auto": install the test shim only when the browser has no native WebMCP.
   * "always": install it regardless. "never": rely on native support.
   */
  shim: "auto" | "always" | "never";
  /** Record tool executions triggered from inside the page. */
  record: boolean;
  /** Default lint options for `webmcp.lint()` and `toPassLint()`. */
  lint: LintOptions;
  /**
   * "auto": attach to the CDP WebMCP domain when the browser has it (Chrome 150+),
   * so calls made by Chrome's own agent are recorded too. "never": page-side hooks only.
   */
  cdp: "auto" | "never";
}

export const DEFAULT_OPTIONS: WebMCPOptions = { shim: "auto", record: true, lint: {}, cdp: "auto" };

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

export interface EvalRunOptions extends Omit<PromptApiRunOptions, "prompts">, ReconcileOptions {}

export interface EvalRunResult extends PromptApiRunResult {
  pass: boolean;
  problems: string[];
}

/**
 * Drives Chrome's on-device model (the Prompt API) against the page's tools.
 * Available as `webmcp.promptApi`.
 */
export class PromptApiHarness {
  constructor(private readonly owner: WebMCP) {}

  /** Whether `LanguageModel` exists in the page. Does not trigger a download. */
  async exists(): Promise<boolean> {
    return this.owner.page.evaluate(() => typeof (globalThis as Record<string, unknown>).LanguageModel !== "undefined");
  }

  /** LanguageModel.availability() for a tool-using session, or "unavailable" when the API is missing. */
  async availability(): Promise<"available" | "downloadable" | "downloading" | "unavailable"> {
    return this.owner.page.evaluate(async () => {
      const LM = (globalThis as Record<string, any>).LanguageModel;
      if (!LM || typeof LM.availability !== "function") return "unavailable";
      try {
        return await LM.availability({
          expectedInputs: [{ type: "text" }, { type: "tool-response" }],
          expectedOutputs: [{ type: "text" }, { type: "tool-call" }],
        });
      } catch {
        return "unavailable";
      }
    });
  }

  /**
   * Install a scripted `LanguageModel` before navigation so agent tests run
   * deterministically on browsers without an on-device model.
   */
  async useFake(plan: FakeLanguageModelPlan): Promise<void> {
    await this.owner.page.addInitScript(fakeLanguageModelSource(plan));
  }

  /** Send one or more user prompts to the on-device model with the page's tools offered. */
  async run(options: PromptApiRunOptions | string): Promise<PromptApiRunResult> {
    const opts = normalizeRunOptions(typeof options === "string" ? { prompts: [options] } : options);
    const result = await this.owner.page.evaluate(runPromptApiInPage, opts);
    for (const c of result.calls) this.owner.record({ ...c, via: "agent" });
    await this.owner.attach(ATTACHMENTS.promptApi, { url: this.owner.page.url(), prompts: opts.prompts, ...result });
    return result;
  }

  /**
   * Run an evals case against the on-device model and reconcile the calls it
   * made with the case's `expectedCall`, using the same positional semantics
   * as the `webmcp-evals` CLI unless `mode: "lenient"` is passed. Only user
   * messages of type "message" are sent; other message kinds are ignored.
   */
  async evaluate(evalCase: EvalCase, options: EvalRunOptions = {}): Promise<EvalRunResult> {
    const { strict, mode = "evals", ...runOptions } = options;
    const prompts = evalCase.messages.filter((m) => m.role === "user" && m.type === "message").map((m) => (m as { content: string }).content);
    const result = await this.run({ ...runOptions, prompts });
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
}

const instances = new WeakMap<Page, WebMCP>();

export class WebMCP {
  private recorded: RecordedCall[] = [];
  private installed = false;
  private cdpSession: CDPSession | undefined;
  private timelineEvents: RegistrationEvent[] = [];
  private readonly mocks = new Map<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>();
  private lastSnapshot: PageSnapshot | undefined;
  readonly promptApi: PromptApiHarness = new PromptApiHarness(this);
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

  /** Install the shim and recorder. Must run before navigation; the fixture does this for you. */
  async install(): Promise<void> {
    if (this.installed) return;
    this.installed = true;
    if (this.options.record) {
      await this.page.exposeBinding("__webmcpReport", (_source, json: string) => {
        const entry = JSON.parse(json) as { kind?: string } & Record<string, unknown>;
        if (entry.kind === "registration") {
          this.timelineEvents.push({
            type: entry.type as RegistrationEvent["type"],
            name: String(entry.name),
            at: Number(entry.at),
            frameUrl: String(entry.frameUrl),
          });
        } else {
          const { kind: _kind, ...call } = entry;
          this.recorded.push(call as unknown as RecordedCall);
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
    if (this.options.shim !== "never") {
      await this.page.addInitScript(shimSource({ force: this.options.shim === "always" }));
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
    const collector = new CdpCollector(this.cdpSession, { onCall: (call) => this.recorded.push(call) });
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
    const results = await Promise.all(frames.map((f) => collectInFrame(f)));
    const snapshot: PageSnapshot = { url: this.page.url(), capturedAt: new Date().toISOString(), frames: [], tools: [] };
    this.lastSnapshot = snapshot;
    for (let i = 0; i < frames.length; i++) {
      const r = results[i];
      if (!r) {
        snapshot.frames.push({ url: frames[i].url(), origin: safeOrigin(frames[i].url()), isTop: i === 0, api: "none" });
        continue;
      }
      let allow: string | null | undefined;
      if (i > 0) {
        try {
          const el = await frames[i].frameElement();
          allow = await el.getAttribute("allow");
          await el.dispose();
        } catch {
          allow = undefined;
        }
      }
      snapshot.frames.push({ ...r.frame, allow, crossOriginFromTop: i > 0 && r.frame.origin !== topOrigin });
      for (const t of r.tools) snapshot.tools.push({ ...t, frame: i });
    }
    if (this.cdp?.enabled) {
      await this.cdp.refreshFrames();
      for (const tool of snapshot.tools) {
        const frameUrl = snapshot.frames[tool.frame]?.url;
        const native =
          this.cdp.list().find((c) => c.name === tool.name && (this.cdp!.frameUrl(c.frameId) ?? frameUrl) === frameUrl) ?? this.cdp.find(tool.name);
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
      const w = window as unknown as Record<string, any>;
      const mc = (document as unknown as Record<string, any>).modelContext ?? w.navigator?.modelContext;
      if (!mc) return [];
      const origins = new Set<string>();
      for (const el of Array.from(document.querySelectorAll("iframe"))) {
        try {
          const origin = new URL((el as HTMLIFrameElement).src, location.href).origin;
          if (origin !== location.origin) origins.add(origin);
        } catch {}
      }
      const listed: any[] = origins.size ? await mc.getTools({ fromOrigins: [...origins] }) : await mc.getTools();
      return listed.map((t) => ({
        name: String(t.name),
        origin: String(t.origin ?? location.origin),
        remote: Boolean(t._isRemote || (t.origin && t.origin !== location.origin)),
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

  /** Execute a tool through the page's modelContext and record the call. */
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.cdp?.enabled && this.cdp.find(name)) {
      const outcome = await this.cdp.invoke(name, args);
      if (!outcome.ok) throw new Error(`Tool "${name}" failed: ${outcome.error}`);
      return outcome.result as T;
    }
    const frames = this.page.frames();
    const results = await Promise.all(frames.map((f) => collectInFrame(f)));
    const owner = frames.find((_f, i) => results[i]?.tools.some((t) => t.name === name));
    if (!owner) throw new Error(`No WebMCP tool named "${name}" found on ${this.page.url()}`);
    const startedAt = Date.now();
    const outcome = await owner.evaluate(
      async ([toolName, toolArgs]) => {
        const w = window as unknown as Record<string, any>;
        const mc = (document as unknown as Record<string, any>).modelContext ?? w.navigator?.modelContext;
        const listed: any[] = (await mc.getTools()) ?? [];
        const tool = listed.find((t) => t.name === toolName) ?? toolName;
        try {
          const result = await mc.executeTool(tool, toolArgs, { __playwrightWebmcp: true });
          return { ok: true as const, result: JSON.parse(JSON.stringify(result === undefined ? null : result)) };
        } catch (err) {
          return { ok: false as const, error: String((err as Error)?.message ?? err) };
        }
      },
      [name, args] as const,
    );
    const entry: RecordedCall = {
      name,
      args,
      startedAt,
      durationMs: Date.now() - startedAt,
      via: "fixture",
      ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }),
    };
    this.recorded.push(entry);
    if (!outcome.ok) throw new Error(`Tool "${name}" failed: ${outcome.error}`);
    return outcome.result as T;
  }

  /** All recorded calls so far, in execution order. */
  calls(): RecordedCall[] {
    return [...this.recorded].sort((a, b) => a.startedAt - b.startedAt);
  }

  clearCalls(): void {
    this.recorded = [];
  }

  /**
   * Wait for calls reported by page scripts to reach the recorder. Binding
   * calls are delivered in order with other protocol traffic, so one round
   * trip to the page is enough to flush what the page has already reported.
   */
  async settle(): Promise<void> {
    await this.page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0))).catch(() => {});
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
    this.recorded.push(call);
  }

  /** @internal */
  async attach(name: string, body: unknown): Promise<void> {
    if (!this.testInfo) return;
    await this.testInfo.attach(name, { body: JSON.stringify(body, null, 2), contentType: "application/json" });
  }
}

async function collectInFrame(frame: Frame): Promise<FrameCollectResult | null> {
  try {
    return await frame.evaluate(collectFrame);
  } catch {
    return null;
  }
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
}

export interface WebMCPFixtureOptions {
  webmcpOptions: Partial<WebMCPOptions>;
}

/**
 * Set WEBMCP_CDP to a DevTools endpoint (e.g. http://localhost:9222) to run
 * tests in a Chrome you launched yourself, with the WebMCP and Prompt API
 * flags enabled in that profile. Playwright's own launch uses a fresh profile
 * where chrome://flags settings do not apply.
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
});
