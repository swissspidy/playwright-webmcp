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
});
