/**
 * Runs an on-device agent turn inside the page with Chrome's Prompt API
 * (`LanguageModel`), offering the page's WebMCP tools to the model.
 *
 * `runPromptApiInPage` is evaluated inside the top frame, so it must stay
 * self contained: no imports, no closures over module scope.
 */
import { ATTACHMENTS, type EvalCase } from "webmcp-lint";
import { evaluateAgent, type AgentRunResult, type EvalRunOptions, type EvalRunResult, type WebMCPAgent } from "./agent.js";
import { fakeLanguageModelSource, type FakeLanguageModelPlan } from "./fake-language-model.js";
import type { WebMCP } from "./fixture.js";

export interface PromptApiRunOptions {
  /** User turns, sent in order within one session. */
  prompts: string[];
  systemPrompt?: string;
  /** Only offer these tools. Default: every tool `getTools()` returns. */
  toolNames?: string[];
  /** Abort the whole run after this long. Default 60s. */
  timeoutMs?: number;
  /** How tool results are handed back to the model. Default "json-string", as in the explainer. */
  toolResultFormat?: "json-string" | "object";
  /** Remove null values from tool results before returning them (Chrome rejects nulls). Default true. */
  stripNulls?: boolean;
  /** Languages declared in expectedInputs/expectedOutputs. Default ["en"]. */
  languages?: string[];
  /**
   * Tool names that must be listed by getTools() before the model is offered
   * them; the harness fills this in from the fixture's snapshot, because the
   * top frame's aggregated list can lag behind a child frame's registration.
   */
  expectedTools?: string[];
  /** How long to wait for `expectedTools` to be listed. Default 3000 ms. */
  waitForToolsMs?: number;
}

export interface PromptApiCall {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  startedAt: number;
  durationMs: number;
}

export interface PromptApiRunResult extends AgentRunResult {
  /** Value returned by LanguageModel.availability(), when the API exists. */
  availability?: string;
  calls: PromptApiCall[];
  usage?: { inputUsage?: number; inputQuota?: number };
}

type SerializableRunOptions = Required<Omit<PromptApiRunOptions, "systemPrompt" | "toolNames" | "expectedTools">> &
  Pick<PromptApiRunOptions, "systemPrompt" | "toolNames" | "expectedTools">;

export function normalizeRunOptions(options: PromptApiRunOptions): SerializableRunOptions {
  return {
    prompts: options.prompts,
    systemPrompt: options.systemPrompt,
    toolNames: options.toolNames,
    timeoutMs: options.timeoutMs ?? 60_000,
    toolResultFormat: options.toolResultFormat ?? "json-string",
    stripNulls: options.stripNulls ?? true,
    languages: options.languages ?? ["en"],
    expectedTools: options.expectedTools,
    waitForToolsMs: options.waitForToolsMs ?? 3000,
  };
}

export async function runPromptApiInPage(options: SerializableRunOptions): Promise<PromptApiRunResult> {
  const g = globalThis as unknown as Record<string, any>;
  const LanguageModel = g.LanguageModel;
  const calls: PromptApiCall[] = [];
  const responses: string[] = [];
  const result: PromptApiRunResult = { status: "ok", responses, calls, toolsOffered: [] };

  if (!LanguageModel || typeof LanguageModel.create !== "function") {
    return { ...result, status: "unavailable", reason: "LanguageModel is not defined in this browser." };
  }

  const mc = (document as unknown as Record<string, any>).modelContext ?? g.navigator?.modelContext;
  if (!mc) return { ...result, status: "unavailable", reason: "No WebMCP modelContext on the page." };

  function stripNulls(value: unknown): unknown {
    if (value === null) return undefined;
    if (Array.isArray(value)) return value.map(stripNulls).filter((v) => v !== undefined);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const s = stripNulls(v);
        if (s !== undefined) out[k] = s;
      }
      return out;
    }
    return value;
  }
  function safe(v: unknown): unknown {
    try {
      return JSON.parse(JSON.stringify(v === undefined ? null : v));
    } catch {
      return String(v);
    }
  }

  let listed: any[] = [];
  const expected = options.expectedTools ?? [];
  const waitUntil = Date.now() + options.waitForToolsMs;
  for (;;) {
    try {
      listed = (await mc.getTools()) ?? [];
    } catch (err) {
      return { ...result, status: "error", reason: `getTools() failed: ${String((err as Error)?.message ?? err)}` };
    }
    // The aggregated list of the top frame can trail a child frame's registration; wait for what the fixture has seen.
    if (expected.every((name) => listed.some((t) => t.name === name)) || Date.now() >= waitUntil) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (options.toolNames) listed = listed.filter((t) => options.toolNames!.includes(t.name));
  result.toolsOffered = listed.map((t) => t.name);

  function schemaOf(tool: any): Record<string, unknown> {
    // Chrome 154 hands inputSchema back as the JSON string it was stored as.
    const raw = typeof tool.inputSchema === "string" ? JSON.parse(tool.inputSchema) : tool.inputSchema;
    return raw ?? { type: "object", properties: {} };
  }

  const tools = listed.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: schemaOf(tool),
    execute: async (args: Record<string, unknown>) => {
      const startedAt = Date.now();
      try {
        // Same conventions as WebMCP.call(): JSON-string input first (Chrome 154), object as fallback; string result decoded.
        let returned: unknown;
        try {
          returned = await mc.executeTool(tool, JSON.stringify(args ?? {}), { __playwrightWebmcp: true });
        } catch (err) {
          if (!/parse input/i.test(String((err as Error)?.message))) throw err;
          returned = await mc.executeTool(tool, args ?? {}, { __playwrightWebmcp: true });
        }
        let raw: unknown = returned;
        if (returned === "undefined") raw = undefined;
        else if (typeof returned === "string") {
          try {
            raw = JSON.parse(returned);
          } catch {
            raw = returned;
          }
        }
        const cleaned = options.stripNulls ? stripNulls(safe(raw)) : safe(raw);
        calls.push({ name: tool.name, args: safe(args ?? {}) as Record<string, unknown>, result: cleaned, startedAt, durationMs: Date.now() - startedAt });
        return options.toolResultFormat === "object" ? cleaned : JSON.stringify(cleaned ?? {});
      } catch (err) {
        const message = String((err as Error)?.message ?? err);
        calls.push({ name: tool.name, args: safe(args ?? {}) as Record<string, unknown>, error: message, startedAt, durationMs: Date.now() - startedAt });
        return JSON.stringify({ error: message });
      }
    },
  }));

  const expectedInputs = [{ type: "text", languages: options.languages }, { type: "tool-response" }];
  const expectedOutputs = [{ type: "text", languages: options.languages }, { type: "tool-call" }];

  try {
    if (typeof LanguageModel.availability === "function") {
      result.availability = await LanguageModel.availability({ expectedInputs, expectedOutputs });
      if (result.availability === "unavailable") {
        return { ...result, status: "unavailable", reason: 'LanguageModel.availability() returned "unavailable".' };
      }
    }
  } catch (err) {
    return { ...result, status: "unavailable", reason: `availability() failed: ${String((err as Error)?.message ?? err)}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let session: any;
  try {
    const createOptions: Record<string, unknown> = { tools, expectedInputs, expectedOutputs, signal: controller.signal };
    if (options.systemPrompt) createOptions.initialPrompts = [{ role: "system", content: options.systemPrompt }];
    session = await LanguageModel.create(createOptions);
  } catch (err) {
    clearTimeout(timer);
    const e = err as Error & { name?: string };
    if (controller.signal.aborted) return { ...result, status: "timeout", reason: "Session creation (model download?) timed out." };
    if (e?.name === "NotSupportedError") {
      return { ...result, status: "unavailable", reason: `Tool use not supported by this build (${e.message}). Enable chrome://flags/#prompt-api-tool-use.` };
    }
    return { ...result, status: "error", reason: `LanguageModel.create() failed: ${String(e?.message ?? err)}` };
  }

  try {
    for (const prompt of options.prompts) {
      const text = await session.prompt(prompt, { signal: controller.signal });
      responses.push(typeof text === "string" ? text : String(text));
    }
    result.usage = { inputUsage: session.inputUsage, inputQuota: session.inputQuota };
  } catch (err) {
    if (controller.signal.aborted) result.status = "timeout";
    else {
      result.status = "error";
      result.reason = `prompt() failed: ${String((err as Error)?.message ?? err)}`;
    }
  } finally {
    clearTimeout(timer);
    try {
      session.destroy?.();
    } catch {}
  }
  return result;
}

/**
 * Drives Chrome's on-device model (the Prompt API, `LanguageModel`) against
 * the page's tools, the way an in-page agent would. Available as the
 * `promptApi` fixture; a cheap way to run eval cases locally. It implements
 * the same agent contract as `defineAgent()`, so `toPassEval` accepts it.
 */
export class PromptApiHarness implements WebMCPAgent {
  constructor(readonly webmcp: WebMCP) {}

  /** Whether `LanguageModel` exists in the page. Does not trigger a download. */
  async exists(): Promise<boolean> {
    return this.webmcp.page.evaluate(() => typeof (globalThis as Record<string, unknown>).LanguageModel !== "undefined");
  }

  /** LanguageModel.availability() for a tool-using session, or "unavailable" when the API is missing. */
  async availability(): Promise<"available" | "downloadable" | "downloading" | "unavailable"> {
    return this.webmcp.page.evaluate(async () => {
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
   * Install a scripted `LanguageModel` before navigation. A test double for
   * your own Prompt API wiring; it proves nothing about an eval case.
   */
  async useFake(plan: FakeLanguageModelPlan): Promise<void> {
    await this.webmcp.page.addInitScript(fakeLanguageModelSource(plan));
  }

  /** Send one or more user prompts to the on-device model with the page's tools offered. */
  async run(options: PromptApiRunOptions | string): Promise<PromptApiRunResult> {
    const given = typeof options === "string" ? { prompts: [options] } : options;
    // Offer the model every tool the fixture can see; the in-page list may need a moment to catch up.
    const known = (await this.webmcp.tools()).map((t) => t.name).filter((name) => !given.toolNames || given.toolNames.includes(name));
    const opts = normalizeRunOptions({ expectedTools: known, ...given });
    const result = await this.webmcp.page.evaluate(runPromptApiInPage, opts);
    for (const c of result.calls) this.webmcp.record({ ...c, via: "agent" });
    await this.webmcp.attach(ATTACHMENTS.promptApi, { url: this.webmcp.page.url(), prompts: opts.prompts, ...result });
    return result;
  }

  /** `evaluateAgent()` with this harness; see there. */
  async evaluate(evalCase: EvalCase, options: EvalRunOptions & Partial<Omit<PromptApiRunOptions, "prompts">> = {}): Promise<EvalRunResult> {
    return evaluateAgent(this, evalCase, options);
  }
}
