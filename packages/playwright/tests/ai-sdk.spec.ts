import { ToolLoopAgent, jsonSchema, stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { test, expect, toolsForAgent } from "../src/index.js";

/**
 * The README's Vercel AI SDK example, run against a scripted model so it
 * needs no API key: the page's tools become AI SDK tools, a ToolLoopAgent
 * drives them, and toPassEval judges the calls the fixture recorded.
 */
test("an AI SDK ToolLoopAgent drives the page's tools and passes an eval", async ({ page, webmcp }) => {
  await page.goto("/");

  // What a real model would decide, step by step: search, then add what it found, then answer.
  let step = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      step++;
      const usage = {
        inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      };
      const call = (toolName: string, input: Record<string, unknown>) => ({
        content: [{ type: "tool-call" as const, toolCallId: `call-${step}`, toolName, input: JSON.stringify(input) }],
        finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
        usage,
        warnings: [],
      });
      if (step === 1) return call("search_products", { query: "hat" });
      if (step === 2) return call("add_to_cart", { productId: 3, quantity: 1 });
      return {
        content: [{ type: "text" as const, text: "A green hat is in your cart." }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: [],
      };
    },
  });

  // The mapping the README shows: one AI SDK tool per page tool, execute() runs it in the page.
  const tools = Object.fromEntries(
    (await toolsForAgent(webmcp)).map((t) => [
      t.name,
      tool({ description: t.description, inputSchema: jsonSchema<Record<string, unknown>>(t.inputSchema as never), execute: (input) => t.execute(input) }),
    ]),
  );
  const agent = new ToolLoopAgent({ model, instructions: "You are a shop assistant.", tools, stopWhen: stepCountIs(5) });

  const evalCase = {
    name: "buy a hat",
    messages: [{ role: "user" as const, type: "message" as const, content: "Put a hat in my cart" }],
    expectedCall: [
      { functionName: "search_products", arguments: { query: { $contains: "hat" } } },
      { functionName: "add_to_cart", arguments: { productId: 3 } },
    ],
  };
  await expect(webmcp).toPassEval(evalCase, { agent });
  expect(webmcp.calls().map((c) => [c.name, c.via])).toEqual([
    ["search_products", "agent"],
    ["add_to_cart", "agent"],
  ]);
  // The tool result the model saw is the page's real answer.
  expect(webmcp.calls()[0].result).toMatchObject({ products: [{ id: 3, name: "Green hat" }] });
  expect(webmcp).toMatchCalls([{ functionName: "search_products" }, { functionName: "add_to_cart", arguments: { quantity: 1 } }]);
});
