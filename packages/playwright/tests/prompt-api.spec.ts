import { test, expect } from "../src/index.js";

test.describe("prompt api harness", () => {
  test("reports unavailable when LanguageModel is missing", async ({ page, webmcp }) => {
    await page.goto("/");
    test.skip(await webmcp.promptApi.exists(), "this browser has a LanguageModel; the unavailable path cannot be tested here");
    expect(await webmcp.promptApi.availability()).toBe("unavailable");
    const result = await webmcp.promptApi.run("Find shirts");
    expect(result.status).toBe("unavailable");
    expect(result.reason).toMatch(/LanguageModel is not defined/);
    expect(webmcp.calls()).toHaveLength(0);
  });

  test("offers the page's tools to the model and records agent calls", async ({ page, webmcp }) => {
    await webmcp.promptApi.useFake({
      turns: [
        {
          match: "shirt",
          calls: [
            { name: "search_products", args: { query: "shirt" } },
            { name: "add_to_cart", args: { productId: 1, quantity: 2 } },
          ],
          response: "Added two red shirts. Cart: {{result:1}}",
        },
      ],
    });
    await page.goto("/");
    expect(await webmcp.promptApi.availability()).toBe("available");

    const result = await webmcp.promptApi.run({ prompts: ["Add two red shirts to my cart"], systemPrompt: "You are a shop assistant." });
    expect(result.status).toBe("ok");
    expect(result.toolsOffered.sort()).toEqual(["add_to_cart", "list_reviews", "search_products", "subscribe_newsletter"]);
    expect(result.responses[0]).toBe('Added two red shirts. Cart: {"items":1,"total":40}');
    expect(result.usage?.inputQuota).toBe(6144);

    const calls = webmcp.calls();
    expect(calls.map((c) => [c.name, c.via])).toEqual([
      ["search_products", "agent"],
      ["add_to_cart", "agent"],
    ]);
    expect(calls[0].result).toEqual({
      products: [
        { id: 1, name: "Red shirt", price: 20 },
        { id: 2, name: "Blue shirt", price: 22 },
      ],
    });
    expect(webmcp).toHaveCalledTool("add_to_cart", { quantity: { $gte: 2 } });
  });

  test("evaluate() reconciles the model's calls against an evals case", async ({ page, webmcp }) => {
    await webmcp.promptApi.useFake({
      turns: [
        { match: "hat", calls: [{ name: "search_products", args: { query: "hat" } }], response: "Found a hat." },
        { match: "reviews", calls: [{ name: "list_reviews", args: { productId: 3 } }], response: "One review." },
      ],
    });
    await page.goto("/");
    const evalCase = {
      name: "hat reviews",
      messages: [
        { role: "user" as const, type: "message" as const, content: "Find me a hat" },
        { role: "user" as const, type: "message" as const, content: "Show its reviews" },
      ],
      expectedCall: [
        { functionName: "search_products", arguments: { query: { $pattern: "(?i)hat" } } },
        { functionName: "list_reviews", arguments: { productId: { $type: "number" as const } } },
      ],
    };
    const result = await webmcp.promptApi.evaluate(evalCase);
    expect(result.pass, result.problems.join("; ")).toBe(true);
    expect(result.responses).toEqual(["Found a hat.", "One review."]);
    await expect(webmcp).toPassEval(evalCase);
    await expect(webmcp).not.toPassEval({ ...evalCase, expectedCall: [{ functionName: "add_to_cart" }] });
  });

  test("tool results returned to the model have nulls stripped", async ({ page, webmcp }) => {
    await webmcp.promptApi.useFake({ turns: [{ calls: [{ name: "nullable", args: {} }], response: "{{result:0}}" }] });
    await page.goto("/");
    await page.evaluate(async () => {
      const mc = (document.modelContext ?? navigator.modelContext)!;
      await mc.registerTool({
        name: "nullable",
        description: "Returns a value containing nulls so the harness can scrub them.",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({ a: 1, b: null, c: [null, 2], d: { e: null } }),
      });
    });
    const result = await webmcp.promptApi.run("anything");
    expect(result.responses[0]).toBe('{"a":1,"c":[2],"d":{}}');
  });

  test("a build without tool use is reported as unavailable", async ({ page, webmcp }) => {
    await webmcp.promptApi.useFake({ rejectTools: true, turns: [] });
    await page.goto("/");
    const result = await webmcp.promptApi.run("hello");
    expect(result.status).toBe("unavailable");
    expect(result.reason).toMatch(/prompt-api-tool-use/);
  });

  test("real on-device model, when present", async ({ page, webmcp }) => {
    await page.goto("/");
    const availability = await webmcp.promptApi.availability();
    test.skip(availability === "unavailable", `Prompt API with tool use is ${availability}. Run against Chrome Canary via WEBMCP_CDP to exercise this.`);
    const result = await webmcp.promptApi.run({
      prompts: ["Search the shop for shirts and add the first result to my cart."],
      systemPrompt: "You are a shopping assistant. Use the tools to act on the user's request.",
      timeoutMs: 180_000,
    });
    expect(result.status, result.reason).toBe("ok");
    expect(webmcp).toHaveCalledTool("search_products");
  });
});
