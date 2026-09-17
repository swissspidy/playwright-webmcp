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

  // The input shape only matters on the page-side path. With the CDP domain
  // enabled -- which is what happens on native Chrome -- call() invokes through
  // it and never touches the page's executeTool at all.
  test.describe("page-side input shapes", () => {
    test.use({ webmcpOptions: { cdp: "never" } });

    test("call() tries both, and retries only when the shape was refused", async ({ page, webmcp }) => {
      await page.goto("/");
      // Stand in for a browser that takes only a JSON string, as Chrome 154 did.
      // The object goes first now, so this only passes if the fallback fires.
      // The stub answers on its own rather than delegating, so it does not
      // depend on what the browser underneath would have accepted.
      await page.evaluate(() => {
        const mc = (document.modelContext ?? navigator.modelContext)!;
        const seen: string[] = [];
        (globalThis as Record<string, unknown>).__attempts = seen;
        mc.executeTool = (async (_tool: never, args: unknown) => {
          seen.push(typeof args);
          if (typeof args !== "string") throw new TypeError("Failed to execute 'executeTool' on 'ModelContext': cannot parse input");
          return JSON.stringify({ echoed: JSON.parse(args) });
        }) as typeof mc.executeTool;
      });
      expect(await webmcp.call("search_products", { query: "hat" })).toEqual({ echoed: { query: "hat" } });
      expect(await page.evaluate(() => (globalThis as Record<string, unknown>).__attempts as string[])).toEqual(["object", "string"]);

      // An error from the tool itself is not an input-shape complaint, so it is
      // rethrown rather than retried: a tool that writes must not run twice.
      await page.evaluate(() => {
        const mc = (document.modelContext ?? navigator.modelContext)!;
        const seen = (globalThis as Record<string, unknown>).__attempts as string[];
        seen.length = 0;
        mc.executeTool = (async (_tool: never, args: unknown) => {
          seen.push(typeof args);
          throw new Error("the cart is closed");
        }) as typeof mc.executeTool;
      });
      await expect(webmcp.call("add_to_cart", { productId: 1 })).rejects.toThrow(/the cart is closed/);
      expect(await page.evaluate(() => (globalThis as Record<string, unknown>).__attempts as string[])).toEqual(["object"]);
    });
  });

  test("failures are recorded and rethrown", async ({ page, webmcp }) => {
    await page.goto("/");
    await expect(webmcp.call("add_to_cart", { productId: 999 })).rejects.toThrow(/Unknown product 999/);
    expect(webmcp.calls()[0].error).toMatch(/Unknown product/);
  });
});
