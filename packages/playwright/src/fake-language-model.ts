/**
 * A scripted stand-in for Chrome's `LanguageModel` global, for running
 * agent-shaped tests deterministically where no on-device model exists.
 *
 * It speaks the tool-use protocol Chromium implements: a session created
 * with `tools` and `expectedOutputs: [{ type: "tool-call" }]` answers a
 * prompt with a content sequence carrying `tool-call` items, the page
 * executes them and prompts again with `tool-response` items, and the model
 * then answers in text. Each plan turn matches a user prompt (by regex, or
 * in order when no `match` is given), asks for the listed tool calls, and
 * returns `response` once their results are back. `{{result:<index>}}`
 * inside the response is replaced with that call's result text.
 */
export interface FakeTurn {
  /** Regex source tested against the prompt text. Omit to match the next unmatched prompt. */
  match?: string;
  calls?: Array<{ name: string; args?: Record<string, unknown> }>;
  response?: string;
}

export interface FakeLanguageModelPlan {
  /** What availability() returns. Default "available". */
  availability?: "available" | "downloadable" | "downloading" | "unavailable";
  /** Throw NotSupportedError from create() when tools are passed, to simulate a build without tool use. */
  rejectTools?: boolean;
  turns: FakeTurn[];
  inputQuota?: number;
}

export function fakeLanguageModelSource(plan: FakeLanguageModelPlan): string {
  return `(() => {
    const plan = ${JSON.stringify(plan)};
    // The tool-use value classes, as Chromium exposes them behind AIPromptAPIToolUse.
    class LanguageModelToolCall {
      constructor(init) { this.callID = init.callID; this.name = init.name; this.arguments = init.arguments ?? null; }
    }
    class LanguageModelToolSuccess {
      constructor(init) { this.callID = init.callID; this.name = init.name; this.result = Object.freeze([...init.result]); }
    }
    class LanguageModelToolError {
      constructor(init) { this.callID = init.callID; this.name = init.name; this.errorMessage = init.errorMessage; }
    }
    let callSeq = 0;
    function resultText(value) {
      if (value instanceof LanguageModelToolError || (value && typeof value.errorMessage === "string")) return JSON.stringify({ error: value.errorMessage });
      const items = (value && value.result) || [];
      return items.map((item) => (item.type === "text" ? String(item.value) : JSON.stringify(item.value))).join("");
    }
    class FakeSession {
      constructor(options) {
        this.cursor = 0;
        this.tools = Array.isArray(options && options.tools) ? options.tools : [];
        this.toolCalls = Array.isArray(options && options.expectedOutputs) && options.expectedOutputs.some((e) => e && e.type === "tool-call");
        this.inputUsage = 0;
        this.inputQuota = plan.inputQuota ?? 6144;
        this.history = (options && options.initialPrompts) ? [...options.initialPrompts] : [];
        this.pending = null;
      }
      async prompt(input, options) {
        if (options && options.signal && options.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const messages = typeof input === "string" ? [{ role: "user", content: input }] : input;
        const responses = [];
        let text = "";
        for (const message of messages) {
          const content = typeof message.content === "string" ? [{ type: "text", value: message.content }] : message.content;
          for (const item of content) {
            if (item.type === "tool-response") responses.push(item.value);
            else if (item.type === "text") text += String(item.value);
          }
          this.history.push(message);
        }
        this.inputUsage += Math.ceil(JSON.stringify(messages).length / 4);
        if (responses.length) {
          const turn = this.pending;
          this.pending = null;
          if (!turn) return "";
          const byId = new Map(responses.map((r) => [r.callID, r]));
          const results = turn.calls.map((c) => resultText(byId.get(c.callID)));
          const response = (turn.response ?? "").replace(/\\{\\{result:(\\d+)\\}\\}/g, (_, i) => results[Number(i)] ?? "");
          this.history.push({ role: "assistant", content: response });
          return response;
        }
        let turn = plan.turns.find((t, i) => i >= this.cursor && t.match && new RegExp(t.match).test(text));
        if (!turn) turn = plan.turns.slice(this.cursor).find((t) => !t.match);
        if (!turn) return "";
        this.cursor = plan.turns.indexOf(turn) + 1;
        const calls = (turn.calls || []).filter((call) => this.tools.some((t) => t.name === call.name));
        if (!calls.length || !this.toolCalls) {
          const response = turn.response ?? "";
          this.history.push({ role: "assistant", content: response });
          return response;
        }
        const requested = calls.map((call) => ({ callID: "call-" + (++callSeq), name: call.name, arguments: call.args || {} }));
        this.pending = { calls: requested, response: turn.response };
        const content = requested.map((c) => ({ type: "tool-call", value: new LanguageModelToolCall(c) }));
        this.history.push({ role: "assistant", content });
        return content;
      }
      async promptStreaming(input, options) {
        const result = await this.prompt(input, options);
        return new ReadableStream({ start(c) { c.enqueue(result); c.close(); } });
      }
      destroy() {}
    }
    globalThis.LanguageModelToolCall = LanguageModelToolCall;
    globalThis.LanguageModelToolSuccess = LanguageModelToolSuccess;
    globalThis.LanguageModelToolError = LanguageModelToolError;
    globalThis.LanguageModel = {
      __fake: true,
      async availability() { return plan.availability || "available"; },
      async create(options = {}) {
        if (plan.rejectTools && options.tools) throw new DOMException("Tools are not supported", "NotSupportedError");
        return new FakeSession(options);
      },
      async params() { return { defaultTopK: 3, maxTopK: 8, defaultTemperature: 1, maxTemperature: 2 }; },
    };
  })();`;
}
