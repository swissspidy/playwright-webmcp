import "../src/webmcp-types.js";
import { test, expect } from "../src/index.js";

test.describe("calling and recording", () => {
  test("call() executes tools in any frame and records them", async ({ page, webmcp }) => {
    await page.goto("/");
    const search = await webmcp.call<{ products: { id: number }[] }>("search_products", { query: "shirt" });
    expect(search.products).toHaveLength(2);
    const cart = await webmcp.call<{ total: number }>("add_to_cart", { productId: search.products[0].id, quantity: 2 });
    expect(cart.total).toBe(40);
    const reviews = await webmcp.call<{ reviews: unknown[] }>("list_reviews", { productId: 1 });
    expect(reviews.reviews).toHaveLength(1);

    expect(webmcp).toHaveCalledTool("search_products", { query: { $contains: "shirt" } });
    expect(webmcp).toHaveCalledTool("add_to_cart", { quantity: { $gte: 2 } });
    expect(webmcp).not.toHaveCalledTool("add_to_cart", { quantity: { $gt: 2 } });
    expect(webmcp.calls()).toMatchCalls([
      { functionName: "search_products" },
      { unordered: [{ functionName: "list_reviews" }, { functionName: "add_to_cart", arguments: { productId: 1 } }] },
    ]);
    expect(webmcp).not.toMatchCalls([{ functionName: "add_to_cart" }, { functionName: "search_products" }]);
    expect(webmcp.calls().every((c) => c.via === "fixture")).toBe(true);
  });

  test("declarative tools fill and submit forms with respondWith", async ({ page, webmcp }) => {
    await page.goto("/");
    const result = await webmcp.call<{ subscribed: string; agent: boolean }>("subscribe_newsletter", {
      email: "a@example.com",
      frequency: "monthly",
    });
    expect(result).toEqual({ subscribed: "a@example.com", agent: true });
    await expect(page.locator("#newsletter-status")).toHaveText("Subscribed a@example.com");
    await expect(page.locator("select[name=frequency]")).toHaveValue("monthly");
  });

  test("calls made by page scripts are recorded as api calls", async ({ page, webmcp }) => {
    await page.goto("/");
    await page.evaluate(async () => {
      const mc = (document.modelContext ?? navigator.modelContext)!;
      const tools = await mc.getTools();
      await mc.executeTool(
        tools.find((t) => t.name === "search_products")!,
        JSON.stringify({ query: "hat" }),
      );
    });
    const calls = webmcp.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "search_products", via: "api", args: { query: "hat" } });
    expect(calls[0].result).toEqual({ products: [{ id: 3, name: "Green hat", price: 12 }] });
  });

  test("failures are recorded and rethrown", async ({ page, webmcp }) => {
    await page.goto("/");
    await expect(webmcp.call("add_to_cart", { productId: 999 })).rejects.toThrow(/Unknown product 999/);
    expect(webmcp.calls()[0].error).toMatch(/Unknown product/);
  });
});
