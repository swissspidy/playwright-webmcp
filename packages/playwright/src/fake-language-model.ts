/**
 * A scripted stand-in for Chrome's `LanguageModel` global, for running
 * agent-shaped tests deterministically where no on-device model exists.
 *
 * Each plan turn matches a user prompt (by regex, or in order when no
 * `match` is given), executes the listed tool calls through the tools the
 * harness offered, and returns `response`. `{{result:<index>}}` inside the
 * response is replaced with the JSON of that call's result.
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
    class FakeSession {
      constructor(options) {
        this.cursor = 0;
        this.tools = Array.isArray(options && options.tools) ? options.tools : [];
        this.inputUsage = 0;
        this.inputQuota = plan.inputQuota ?? 6144;
        this.history = (options && options.initialPrompts) ? [...options.initialPrompts] : [];
      }
      async prompt(input, options) {
        const text = typeof input === "string" ? input : JSON.stringify(input);
        this.history.push({ role: "user", content: text });
        this.inputUsage += Math.ceil(text.length / 4);
        let turn = plan.turns.find((t, i) => i >= this.cursor && t.match && new RegExp(t.match).test(text));
        if (!turn) turn = plan.turns.slice(this.cursor).find((t) => !t.match);
        if (!turn) return "";
        this.cursor = plan.turns.indexOf(turn) + 1;
        const results = [];
        for (const call of turn.calls || []) {
          if (options && options.signal && options.signal.aborted) throw new DOMException("Aborted", "AbortError");
          const tool = this.tools.find((t) => t.name === call.name);
          if (!tool) { results.push({ error: "no such tool " + call.name }); continue; }
          results.push(await tool.execute(call.args || {}));
        }
        let response = turn.response ?? "";
        response = response.replace(/\\{\\{result:(\\d+)\\}\\}/g, (_, i) => {
          const r = results[Number(i)];
          return typeof r === "string" ? r : JSON.stringify(r);
        });
        this.history.push({ role: "assistant", content: response });
        return response;
      }
      async promptStreaming(input, options) {
        const text = await this.prompt(input, options);
        return new ReadableStream({ start(c) { c.enqueue(text); c.close(); } });
      }
      destroy() {}
    }
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
