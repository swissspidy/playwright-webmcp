import { test, expect, runAgent, toolsForAgent, type AgentGenerator, type AgentTool } from "../src/index.js";

const evalCase = {
  name: "buy a hat",
  messages: [{ role: "user" as const, type: "message" as const, content: "Put a hat in my cart" }],
  expectedCall: [
    { functionName: "search_products", arguments: { query: { $contains: "hat" } } },
    { functionName: "add_to_cart", arguments: { productId: 3 } },
  ],
};

/** A scripted stand-in for an agent framework's object: `generate()` runs tools it was given and reports messages back. */
function scriptedGenerator(tools: AgentTool[], log: unknown[]): AgentGenerator {
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return {
    async generate(options) {
      log.push(options);
      const messages = options.messages as Array<{ content: string }> | undefined;
      const prompt = typeof options.prompt === "string" ? options.prompt : String(messages?.at(-1)?.content);
      if (/hat|shirt/i.test(prompt)) {
        const query = /hat/i.test(prompt) ? "hat" : "shirt";
        const found = (await byName.search_products.execute({ query })) as { products: Array<{ id: number }> };
        await byName.add_to_cart.execute({ productId: found.products[0].id, quantity: 1 });
        return { text: `Added a ${query}.`, response: { messages: [{ role: "assistant", content: `Added a ${query}.` }] } };
      }
      return { text: "Nothing to do.", response: { messages: [{ role: "assistant", content: "Nothing to do." }] } };
    },
  };
}

test.describe("bring your own agent", () => {
  test("an object with generate() is driven turn by turn and its tool calls are recorded", async ({ page, webmcp }) => {
    await page.goto("/");
    await expect(webmcp).toHaveTool("list_reviews"); // the reviews iframe registers a little after the top page natively
    const tools = await toolsForAgent(webmcp);
    expect(tools.map((t) => t.name).sort()).toEqual(["add_to_cart", "list_reviews", "search_products", "subscribe_newsletter"]);
    expect(tools.find((t) => t.name === "search_products")?.readOnly).toBe(true);
    expect(tools.find((t) => t.name === "add_to_cart")?.readOnly).toBe(false);

    const log: Array<{ prompt?: string; messages?: unknown[] }> = [];
    const agent = scriptedGenerator(tools, log);
    const result = await runAgent(webmcp, agent, { prompts: ["Add a red shirt to my cart", "thanks"] });
    expect(result.status).toBe("ok");
    expect(result.responses).toEqual(["Added a shirt.", "Nothing to do."]);
    expect(result.calls.map((c) => c.name)).toEqual(["search_products", "add_to_cart"]);
    // Turn one goes as a prompt; turn two carries the conversation, including what the agent answered.
    expect(log[0].prompt).toBe("Add a red shirt to my cart");
    expect(log[1].messages).toEqual([
      { role: "user", content: "Add a red shirt to my cart" },
      { role: "assistant", content: "Added a shirt." },
      { role: "user", content: "thanks" },
    ]);

    expect(webmcp.calls().map((c) => c.via)).toEqual(["agent", "agent"]);
    expect(webmcp).toHaveCalledTool("add_to_cart", { quantity: { $gte: 1 } });
    await expect(webmcp).toHaveToolCoverage(0.5);
  });

  test("toPassEval takes the agent as an option on the webmcp fixture", async ({ page, webmcp }) => {
    await page.goto("/");
    const agent = scriptedGenerator(await toolsForAgent(webmcp), []);
    await expect(webmcp).toPassEval(evalCase, { agent });
    await expect(webmcp).not.toPassEval({ ...evalCase, expectedCall: [{ functionName: "add_to_cart" }] }, { agent });
    await expect(webmcp).toPassEval({ ...evalCase, expectedCall: [{ functionName: "add_to_cart" }] }, { agent, mode: "lenient" });
  });

  test("a plain async function is an agent too, called once per user turn with the tools", async ({ page, webmcp }) => {
    await page.goto("/");
    const seen: string[] = [];
    const agent = async (prompt: string, { tools, index, systemPrompt }: { tools: AgentTool[]; index: number; systemPrompt?: string }) => {
      seen.push(`${index}:${systemPrompt ?? ""}:${prompt}`);
      const search = tools.find((t) => t.name === "search_products")!;
      const found = (await search.execute({ query: "hat" })) as { products: Array<{ id: number }> };
      await tools.find((t) => t.name === "add_to_cart")!.execute({ productId: found.products[0].id });
      return `Done ${index}`;
    };
    const result = await runAgent(webmcp, agent, { prompts: ["Put a hat in my cart", "and another"], systemPrompt: "Be brief." });
    expect(result).toMatchObject({ status: "ok", responses: ["Done 0", "Done 1"], toolsOffered: expect.arrayContaining(["search_products"]) });
    expect(result.calls.map((c) => c.name)).toEqual(["search_products", "add_to_cart", "search_products", "add_to_cart"]);
    expect(seen).toEqual(["0:Be brief.:Put a hat in my cart", "1:Be brief.:and another"]);
    await expect(webmcp).toPassEval(evalCase, { agent });
  });

  test("errors, timeouts and tool failures are reported as statuses and recorded calls", async ({ page, webmcp }) => {
    await page.goto("/");
    const narrow = await toolsForAgent(webmcp, { toolNames: ["search_products"] });
    expect(narrow.map((t) => t.name)).toEqual(["search_products"]);

    const failing = { generate: async () => Promise.reject(new Error("model quota exceeded")) };
    expect(await runAgent(webmcp, failing, "x")).toMatchObject({ status: "error", reason: "model quota exceeded" });

    const slow = (_prompt: string, { signal }: { signal: AbortSignal }) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    expect((await runAgent(webmcp, slow, { prompts: ["x"], timeoutMs: 100 })).status).toBe("timeout");

    // A driver that ignores the signal cannot act on the page after the run returned: the tools it was
    // handed reject, so a late call neither mutates the page nor lands in the next run's calls.
    let late: AgentTool | undefined;
    const runaway = async (_prompt: string, { tools }: { tools: AgentTool[] }) => {
      late = tools.find((t) => t.name === "add_to_cart");
      await new Promise((resolve) => setTimeout(resolve, 300));
    };
    expect((await runAgent(webmcp, runaway, { prompts: ["x"], timeoutMs: 100 })).status).toBe("timeout");
    const callsBefore = webmcp.calls().length;
    await expect(late!.execute({ productId: 1 })).rejects.toThrow(/exceeded 100 ms/);
    expect(webmcp.calls().length).toBe(callsBefore);

    // Tool discovery failing is an error status, not a rejected run.
    const broken = { tools: async () => Promise.reject(new Error("getTools exploded")), calls: () => [] } as unknown as typeof webmcp;
    expect(await runAgent(broken, async () => {}, "x")).toMatchObject({ status: "error", reason: "getTools exploded" });

    // Discovery does not spend the agent's budget: a snapshot slower than timeoutMs leaves the agent all of it.
    const sluggish = { tools: () => new Promise((resolve) => setTimeout(() => resolve([]), 300)), calls: () => [] } as unknown as typeof webmcp;
    expect(await runAgent(sluggish, async () => "done", { prompts: ["x"], timeoutMs: 100 })).toMatchObject({ status: "ok", responses: ["done"] });
    // It has a deadline of its own instead, so a snapshot that never finishes still ends the run.
    const stuck = { tools: () => new Promise(() => {}), calls: () => [] } as unknown as typeof webmcp;
    expect(await runAgent(stuck, async () => "done", { prompts: ["x"], discoveryTimeoutMs: 100 })).toMatchObject({
      status: "timeout",
      reason: "Tool discovery did not finish within 100 ms",
      responses: [],
    });

    const tools = await toolsForAgent(webmcp, { toolNames: ["add_to_cart"] });
    await expect(tools[0].execute({ productId: 999 })).rejects.toThrow(/Unknown product 999/);
    expect(webmcp.calls().at(-1)).toMatchObject({ name: "add_to_cart", via: "agent", error: expect.stringMatching(/Unknown product/) });
  });

  test("toPassEval rejects receivers without an agent", async ({ webmcp }) => {
    await expect(async () => expect(webmcp).toPassEval({ messages: [], expectedCall: [] })).rejects.toThrow(/needs an agent/);
    await expect(async () => expect(webmcp).toPassEval({ messages: [], expectedCall: [] }, { agent: 42 as never })).rejects.toThrow(/needs an agent/);
  });
});
