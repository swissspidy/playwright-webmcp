/**
 * Runs an on-device agent turn inside the page with Chrome's Prompt API
 * (`LanguageModel`), offering the page's WebMCP tools to the model.
 *
 * `runPromptApiInPage` is evaluated inside the top frame, so it must stay
 * self contained: no imports, no closures over module scope.
 */

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
}

export interface PromptApiCall {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  startedAt: number;
  durationMs: number;
}

export interface PromptApiRunResult {
  status: "ok" | "unavailable" | "error" | "timeout";
  /** Value returned by LanguageModel.availability(), when the API exists. */
  availability?: string;
  reason?: string;
  responses: string[];
  calls: PromptApiCall[];
  toolsOffered: string[];
  usage?: { inputUsage?: number; inputQuota?: number };
}

type SerializableRunOptions = Required<Omit<PromptApiRunOptions, "systemPrompt" | "toolNames">> & Pick<PromptApiRunOptions, "systemPrompt" | "toolNames">;

export function normalizeRunOptions(options: PromptApiRunOptions): SerializableRunOptions {
  return {
    prompts: options.prompts,
    systemPrompt: options.systemPrompt,
    toolNames: options.toolNames,
    timeoutMs: options.timeoutMs ?? 60_000,
    toolResultFormat: options.toolResultFormat ?? "json-string",
    stripNulls: options.stripNulls ?? true,
    languages: options.languages ?? ["en"],
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
  try {
    listed = (await mc.getTools()) ?? [];
  } catch (err) {
    return { ...result, status: "error", reason: `getTools() failed: ${String((err as Error)?.message ?? err)}` };
  }
  if (options.toolNames) listed = listed.filter((t) => options.toolNames!.includes(t.name));
  result.toolsOffered = listed.map((t) => t.name);

  const tools = listed.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    execute: async (args: Record<string, unknown>) => {
      const startedAt = Date.now();
      try {
        const raw = await mc.executeTool(tool, args ?? {}, { __playwrightWebmcp: true });
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
