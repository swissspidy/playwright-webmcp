import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test as base, type Browser, type CDPSession, type Frame, type Page, type TestInfo } from "@playwright/test";
import {
  collectFrame,
  diffContracts,
  formatChanges,
  lint,
  reconcileCalls,
  serializeContract,
  toContract,
  toEvalCase,
  toToolsSchema,
  type ContractChange,
  type EvalCase,
  type FrameCollectResult,
  type LintOptions,
  type LintResult,
  type PageSnapshot,
  type RecordedCall,
  type ReconcileOptions,
  type SmokeReport,
  type ToEvalOptions,
  type ToolContract,
  type ToolSnapshot,
} from "webmcp-lint";
import { CdpCollector } from "./cdp.js";
import { runSmoke, type SmokeOptions } from "./smoke.js";
import { SHIM_SOURCE } from "./shim.js";
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

export const ATTACHMENTS = {
  eval: "webmcp-eval",
  tools: "webmcp-tools",
  lint: "webmcp-lint",
  snapshot: "webmcp-snapshot",
  calls: "webmcp-calls",
  promptApi: "webmcp-prompt-api",
  smoke: "webmcp-smoke",
  contract: "webmcp-contract",
} as const;

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
   * made with the case's `expectedCall`. Only user messages of type
   * "message" are sent; other message kinds are ignored.
   */
  async evaluate(evalCase: EvalCase, options: EvalRunOptions = {}): Promise<EvalRunResult> {
    const { strict, ...runOptions } = options;
    const prompts = evalCase.messages.filter((m) => m.role === "user" && m.type === "message").map((m) => (m as { content: string }).content);
    const result = await this.run({ ...runOptions, prompts });
    if (result.status !== "ok") {
      return { ...result, pass: false, problems: [`${result.status}: ${result.reason ?? "no details"}`] };
    }
    const reconciled = reconcileCalls(evalCase.expectedCall, result.calls.map((c) => ({ name: c.name, args: c.args, result: c.result })), { strict });
    return { ...result, pass: reconciled.ok, problems: reconciled.problems };
  }
}

export interface ScenarioOptions extends Omit<ToEvalOptions, "name"> {
  name?: string;
}

const instances = new WeakMap<Page, WebMCP>();

export class WebMCP {
  private recorded: RecordedCall[] = [];
  private installed = false;
  private cdpSession: CDPSession | undefined;
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
        this.recorded.push(JSON.parse(json) as RecordedCall);
      });
    }
    if (this.options.shim !== "never") {
      await this.page.addInitScript(this.options.shim === "always" ? SHIM_SOURCE.replace("if (document.modelContext || (navigator && navigator.modelContext)) return;", "") : SHIM_SOURCE);
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
        const native = this.cdp.list().find((c) => c.name === tool.name && (this.cdp!.frameUrl(c.frameId) ?? frameUrl) === frameUrl) ?? this.cdp.find(tool.name);
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
      if (mode === "none") return { pass: false, outcome: "changed", path, changes: contract.tools.map((t) => ({ kind: "tool-added", tool: t.name, detail: "no stored contract" })), contract };
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
   * Run `body`, capture every tool call it produced, and attach the result as
   * a webmcp-evals case. The `playwright-webmcp-evals` reporter turns these
   * attachments into evals.json / tools.json.
   */
  async scenario(options: ScenarioOptions, body: () => Promise<void>): Promise<EvalCase> {
    const before = this.recorded.length;
    await body();
    const calls = this.recorded.slice(before).sort((a, b) => a.startedAt - b.startedAt);
    const evalCase = toEvalCase(calls, { ...options, name: options.name });
    const snapshot = await this.snapshot();
    await this.attach(ATTACHMENTS.eval, { url: snapshot.url, eval: evalCase });
    await this.attach(ATTACHMENTS.tools, toToolsSchema(snapshot));
    return evalCase;
  }

  /** Attach the current snapshot and calls to the test result (done automatically at teardown). */
  async flush(): Promise<void> {
    if (this.cdp) await this.cdp.disable();
    if (this.cdpSession) await this.cdpSession.detach().catch(() => {});
    if (!this.testInfo) return;
    if (this.recorded.length) await this.attach(ATTACHMENTS.calls, this.calls());
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
