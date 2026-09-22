import { test, expect } from "../src/index.js";

test.describe("tool discovery", () => {
  test("finds imperative, declarative and iframe tools", async ({ page, webmcp }) => {
    await page.goto("/");
    // Registration is asynchronous (natively in particular); wait for the iframe's tool before a one-shot snapshot.
    await expect(webmcp).toHaveTool("list_reviews");
    const snapshot = await webmcp.snapshot();
    expect(snapshot.frames).toHaveLength(2);
    expect(snapshot.frames[0].api).toBe("native");
    const names = snapshot.tools.map((t) => t.name).sort();
    expect(names).toEqual(["add_to_cart", "list_reviews", "search_products", "subscribe_newsletter"]);
    expect(snapshot.tools.find((t) => t.name === "list_reviews")?.frame).toBe(1);
  });

  test("toHaveTool with partial schema and source", async ({ page, webmcp }) => {
    await page.goto("/");
    await expect(webmcp).toHaveTool("search_products", {
      description: /catalogue/,
      inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
      source: "imperative",
    });
    await expect(webmcp).toHaveTool("subscribe_newsletter", {
      source: "declarative",
      inputSchema: { properties: { email: { type: "string" }, frequency: { enum: ["weekly", "monthly"] } }, required: ["email"] },
    });
    await expect(page).toHaveTool("list_reviews");
    expect((await webmcp.tool("search_products"))?.title).toBe("Search products");
    await expect(webmcp).not.toHaveTool("checkout");
  });

  test("toHaveTool reports schema mismatches", async ({ page, webmcp }) => {
    await page.goto("/");
    await expect(async () => {
      await expect(webmcp).toHaveTool("add_to_cart", { inputSchema: { properties: { quantity: { type: "string" } } } });
    }).rejects.toThrow(/inputSchema\.properties\.quantity\.type/);
  });
});
