import { test as base, type Frame, type Page, type TestInfo } from "@playwright/test";
import {
  collectFrame,
  lint,
  toEvalCase,
  toToolsSchema,
  type EvalCase,
  type FrameCollectResult,
  type LintOptions,
  type LintResult,
  type PageSnapshot,
  type RecordedCall,
  type ToEvalOptions,
  type ToolSnapshot,
} from "webmcp-lint";
import { SHIM_SOURCE } from "./shim.js";
import { RECORDER_SOURCE } from "./recorder.js";

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
}

export const DEFAULT_OPTIONS: WebMCPOptions = { shim: "auto", record: true, lint: {} };

export const ATTACHMENTS = {
  eval: "webmcp-eval",
  tools: "webmcp-tools",
  lint: "webmcp-lint",
  snapshot: "webmcp-snapshot",
  calls: "webmcp-calls",
} as const;

export interface ScenarioOptions extends Omit<ToEvalOptions, "name"> {
  name?: string;
}

const instances = new WeakMap<Page, WebMCP>();

export class WebMCP {
  private recorded: RecordedCall[] = [];
  private installed = false;

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
    return snapshot;
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
    if (!this.testInfo) return;
    if (this.recorded.length) await this.attach(ATTACHMENTS.calls, this.calls());
  }

  private async attach(name: string, body: unknown): Promise<void> {
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

export const test = base.extend<WebMCPFixtures & WebMCPFixtureOptions>({
  webmcpOptions: [{}, { option: true }],
  webmcp: async ({ page, webmcpOptions }, use, testInfo) => {
    const instance = new WebMCP(page, testInfo, { ...DEFAULT_OPTIONS, ...webmcpOptions, lint: { ...DEFAULT_OPTIONS.lint, ...(webmcpOptions.lint ?? {}) } });
    await instance.install();
    await use(instance);
    await instance.flush();
  },
});
