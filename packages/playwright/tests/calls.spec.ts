import "../src/webmcp-types.js";
import { test, expect } from "../src/index.js";
import { executeToolInPage } from "./helpers.js";

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
    await executeToolInPage(page, "search_products", { query: "hat" });
    const calls = webmcp.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "search_products", via: "api", args: { query: "hat" } });
    expect(calls[0].result).toEqual({ products: [{ id: 3, name: "Green hat", price: 12 }] });
  });

  test("call() tries both input shapes, and retries only when the shape was refused", async ({ page, webmcp }) => {
    await page.goto("/");
    // Stand in for a browser that takes only a JSON string, as Chrome 154 did.
    // The object goes first now, so this only works if the fallback fires.
    const attempts = await page.evaluate(() => {
      const mc = (document.modelContext ?? navigator.modelContext)!;
      const original = mc.executeTool.bind(mc);
      const seen: string[] = [];
      (globalThis as Record<string, unknown>).__attempts = seen;
      mc.executeTool = ((tool: never, args: unknown, options: never) => {
        seen.push(typeof args);
        if (typeof args !== "string") throw new TypeError("Failed to execute 'executeTool' on 'ModelContext': cannot parse input");
        return original(tool, args, options);
      }) as typeof mc.executeTool;
      return seen;
    });
    expect(await webmcp.call("search_products", { query: "hat" })).toEqual({ products: [{ id: 3, name: "Green hat", price: 12 }] });
    expect(await page.evaluate(() => (globalThis as Record<string, unknown>).__attempts as string[])).toEqual(["object", "string"]);
    expect(attempts).toEqual([]);

    // An error from the tool itself is not an input-shape complaint, so it is
    // rethrown rather than retried: a tool that writes must not run twice.
    await page.evaluate(() => {
      const mc = (document.modelContext ?? navigator.modelContext)!;
      const seen = (globalThis as Record<string, unknown>).__attempts as string[];
      seen.length = 0;
      mc.executeTool = ((_tool: never, args: unknown) => {
        seen.push(typeof args);
        throw new Error("the cart is closed");
      }) as typeof mc.executeTool;
    });
    await expect(webmcp.call("add_to_cart", { productId: 1 })).rejects.toThrow(/the cart is closed/);
    expect(await page.evaluate(() => (globalThis as Record<string, unknown>).__attempts as string[])).toEqual(["object"]);
  });

  test("failures are recorded and rethrown", async ({ page, webmcp }) => {
    await page.goto("/");
    await expect(webmcp.call("add_to_cart", { productId: 999 })).rejects.toThrow(/Unknown product 999/);
    expect(webmcp.calls()[0].error).toMatch(/Unknown product/);
  });
});
