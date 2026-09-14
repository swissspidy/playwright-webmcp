import { test, expect, defineAgent, toolsForAgent } from "../src/index.js";

/**
 * A stand-in for a Node-side agent (the Vercel AI SDK, an Anthropic or
 * OpenAI client, ...): it receives the page's tools as callables and drives
 * them from the test process. No model is involved here; the point is the
 * wiring: calls are recorded as agent calls and evals reconcile them.
 */
test.describe("bring your own agent", () => {
  test("defineAgent hands the page's tools to a driver and records what it calls", async ({ page, webmcp }) => {
    await page.goto("/");
    const seen: string[] = [];
    const agent = defineAgent(webmcp, async ({ tools, prompts, systemPrompt }) => {
      seen.push(systemPrompt ?? "", ...prompts);
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      expect(byName.search_products.readOnly).toBe(true);
      expect(byName.add_to_cart.readOnly).toBe(false);
      const found = (await byName.search_products.execute({ query: "shirt" })) as { products: Array<{ id: number }> };
      await byName.add_to_cart.execute({ productId: found.products[0].id, quantity: 2 });
      return `Added two shirts (${found.products.length} matched).`;
    });

    const result = await agent.run({ prompts: ["Add two red shirts to my cart"], systemPrompt: "You are a shop assistant." });
    expect(result.status).toBe("ok");
    expect(result.responses).toEqual(["Added two shirts (2 matched)."]);
    expect(result.toolsOffered.sort()).toEqual(["add_to_cart", "list_reviews", "search_products", "subscribe_newsletter"]);
    expect(result.calls.map((c) => c.name)).toEqual(["search_products", "add_to_cart"]);
    expect(seen).toEqual(["You are a shop assistant.", "Add two red shirts to my cart"]);

    expect(webmcp.calls().map((c) => c.via)).toEqual(["agent", "agent"]);
    expect(webmcp).toHaveCalledTool("add_to_cart", { quantity: { $gte: 2 } });
    await expect(webmcp).toHaveToolCoverage(0.5);
  });

  test("toPassEval reconciles an agent's calls with an evals case", async ({ page, webmcp }) => {
    await page.goto("/");
    const agent = defineAgent(webmcp, async ({ tools, prompts }) => {
      const query = prompts[0].includes("hat") ? "hat" : "shirt";
      const search = tools.find((t) => t.name === "search_products")!;
      const found = (await search.execute({ query })) as { products: Array<{ id: number }> };
      await tools.find((t) => t.name === "add_to_cart")!.execute({ productId: found.products[0].id, quantity: 1 });
    });
    const evalCase = {
      name: "buy a hat",
      messages: [{ role: "user" as const, type: "message" as const, content: "Put a hat in my cart" }],
      expectedCall: [
        { functionName: "search_products", arguments: { query: { $contains: "hat" } } },
        { functionName: "add_to_cart", arguments: { productId: 3 } },
      ],
    };
    await expect(agent).toPassEval(evalCase);
    await expect(agent).not.toPassEval({ ...evalCase, expectedCall: [{ functionName: "add_to_cart" }] });
    await expect(agent).toPassEval({ ...evalCase, expectedCall: [{ functionName: "add_to_cart" }] }, { mode: "lenient" });
  });

  test("toolNames narrows the offer, errors and timeouts are reported as statuses", async ({ page, webmcp }) => {
    await page.goto("/");
    const narrow = defineAgent(webmcp, async ({ tools }) => {
      expect(tools.map((t) => t.name)).toEqual(["search_products"]);
    });
    expect((await narrow.run({ prompts: ["x"], toolNames: ["search_products"] })).status).toBe("ok");

    const failing = defineAgent(webmcp, async () => {
      throw new Error("model quota exceeded");
    });
    expect(await failing.run("x")).toMatchObject({ status: "error", reason: "model quota exceeded" });

    const slow = defineAgent(webmcp, ({ signal }) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())));
    const timedOut = await slow.run({ prompts: ["x"], timeoutMs: 100 });
    expect(timedOut.status).toBe("timeout");

    const tools = await toolsForAgent(webmcp, { toolNames: ["add_to_cart"] });
    await expect(tools[0].execute({ productId: 999 })).rejects.toThrow(/Unknown product 999/);
    expect(webmcp.calls().at(-1)).toMatchObject({ name: "add_to_cart", via: "agent", error: expect.stringMatching(/Unknown product/) });
  });

  test("toPassEval rejects receivers that are not agents", async ({ webmcp }) => {
    await expect(async () => expect(webmcp).toPassEval({ messages: [], expectedCall: [] })).rejects.toThrow(/expects an agent/);
  });
});
