import { test, expect } from "../src/index.js";

test.describe("scenario export", () => {
  test("records a scenario as an evals case", async ({ page, webmcp }, testInfo) => {
    await page.goto("/");
    const evalCase = await webmcp.scenario({ name: "add two shirts", prompt: "Add two red shirts to my cart" }, async () => {
      const { products } = await webmcp.call<{ products: { id: number }[] }>("search_products", { query: "red" });
      await webmcp.call("add_to_cart", { productId: products[0].id, quantity: 2 });
    });
    expect(evalCase).toEqual({
      name: "add two shirts",
      messages: [{ role: "user", type: "message", content: "Add two red shirts to my cart" }],
      expectedCall: [
        { functionName: "search_products", arguments: { query: "red" } },
        { functionName: "add_to_cart", arguments: { productId: 1, quantity: 2 } },
      ],
    });
    const names = testInfo.attachments.map((a) => a.name);
    expect(names).toContain("webmcp-eval");
    expect(names).toContain("webmcp-tools");
  });

  test("argument modes and unordered groups", async ({ page, webmcp }) => {
    await page.goto("/");
    const typed = await webmcp.scenario({ prompt: "Find hats", argumentsMode: "types", unordered: true }, async () => {
      await webmcp.call("search_products", { query: "hat" });
      await webmcp.call("list_reviews", { productId: 3 });
    });
    expect(typed.expectedCall).toEqual([
      {
        unordered: [
          { functionName: "search_products", arguments: { query: { $type: "string" } } },
          { functionName: "list_reviews", arguments: { productId: { $type: "number" } } },
        ],
      },
    ]);
    const loose = await webmcp.scenario({ prompt: "Find hats", argumentsMode: "any" }, async () => {
      await webmcp.call("search_products", { query: "hat" });
    });
    expect(loose.expectedCall).toEqual([{ functionName: "search_products", arguments: null }]);
  });

  test("calls made by page scripts inside the body are included", async ({ page, webmcp }) => {
    await page.goto("/");
    const evalCase = await webmcp.scenario({ prompt: "Find hats from the page" }, async () => {
      await page.evaluate(async () => {
        const mc = (document.modelContext ?? navigator.modelContext)!;
        const tools = await mc.getTools();
        await mc.executeTool(
          tools.find((t) => t.name === "search_products")!,
          { query: "hat" },
        );
      });
    });
    expect(evalCase.expectedCall).toEqual([{ functionName: "search_products", arguments: { query: "hat" } }]);
  });

  test("an agent run inside the body exports the model's trajectory", async ({ page, webmcp }) => {
    await webmcp.promptApi.useFake({
      turns: [
        {
          calls: [
            { name: "search_products", args: { query: "red shirt" } },
            { name: "add_to_cart", args: { productId: 1, quantity: 2 } },
          ],
        },
      ],
    });
    await page.goto("/");
    const evalCase = await webmcp.scenario({ name: "add two shirts", prompt: "Add two red shirts to my cart", argumentsMode: "types" }, async () => {
      await webmcp.promptApi.run("Add two red shirts to my cart");
    });
    expect(evalCase.expectedCall).toEqual([
      { functionName: "search_products", arguments: { query: { $type: "string" } } },
      { functionName: "add_to_cart", arguments: { productId: { $type: "number" }, quantity: { $type: "number" } } },
    ]);
    expect(webmcp.calls().map((c) => c.via)).toEqual(["agent", "agent"]);
    // The exported case passes under the CLI's semantics against the same run.
    await expect(webmcp).toPassEval(evalCase);
  });
});
