// Code mode against a real React app: the model's script composes the tools use-webmcp-tool
// registers, in one step, inside a QuickJS sandbox. use-webmcp-tool answers with MCP text content
// ({ content: [{ type: "text", text: "<json>" }] }); code mode hands the script the parsed JSON.
import { test, expect } from "@playwright/test";
import { CodeMode } from "@swissspidy/webmcp-codemode";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Agent tools ready")).toBeVisible();
});

test("one script searches and fills the cart", async ({ page }) => {
  const codeMode = await CodeMode.create(page);

  // What a model would read first (webmcp_api over MCP).
  const api = codeMode.declarations();
  expect(api).toContain("search_products(args: {");
  expect(api).toContain("add_to_cart(args: {");
  expect(api).toContain("(consequential: may need approval)");

  // What a model would write (webmcp_execute over MCP).
  const result = await codeMode.execute(`
    const { products } = await tools.search_products({ query: "shirt" });
    let cart;
    for (const product of products) cart = await tools.add_to_cart({ productId: product.id, quantity: 2 });
    return { added: products.map((p) => p.name), cart };
  `);

  expect(result.error).toBeUndefined();
  expect(result.result).toEqual({ added: ["Red shirt", "Blue shirt"], cart: { items: 2, total: 84 } });
  expect(result.calls.map((c) => c.name)).toEqual(["search_products", "add_to_cart", "add_to_cart"]);
  await expect(page.locator("#cart")).toHaveText("Cart: 2 item(s)");
});

test("consequential tools can require approval", async ({ page }) => {
  const codeMode = await CodeMode.create(page, {
    // add_to_cart is marked consequential by the app's defineShopTool() wrapper.
    onToolCall: ({ tool }) => (tool.annotations?.consequential ? "the user has not approved purchases" : true),
  });
  const result = await codeMode.execute(`
    const { products } = await tools.search_products({ query: "hat" });
    try {
      await tools.add_to_cart({ productId: products[0].id });
    } catch (error) {
      return { found: products[0].name, error: error.name };
    }
  `);
  expect(result.result).toEqual({ found: "Green hat", error: "ToolDeniedError" });
  await expect(page.locator("#cart")).toHaveText("Cart: 0 item(s)");
});
