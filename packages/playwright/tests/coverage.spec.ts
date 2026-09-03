import { test, expect } from "../src/index.js";

test.describe("coverage, score, codegen, docs", () => {
  test("coverage tracks called tools and parameters", async ({ page, webmcp }) => {
    await page.goto("/");
    expect((await webmcp.coverage()).ratio).toBe(0);
    await expect(webmcp).not.toHaveToolCoverage(0.25);
    await webmcp.call("search_products", { query: "shirt" });
    await webmcp.call("add_to_cart", { productId: 1 });
    const coverage = await webmcp.coverage();
    expect(coverage.called).toBe(2);
    expect(coverage.uncalled.sort()).toEqual(["list_reviews", "subscribe_newsletter"]);
    expect(coverage.tools.find((t) => t.name === "add_to_cart")?.parametersNeverSet).toEqual(["quantity"]);
    await expect(webmcp).toHaveToolCoverage(50);
  });

  test("score explains itself", async ({ page, webmcp }) => {
    await page.goto("/");
    const score = await webmcp.score();
    expect(score.categories.map((c) => c.name)).toEqual(["declarations", "safety", "coverage"]);
    expect(score.categories.find((c) => c.name === "coverage")?.points).toBe(0);
    await webmcp.call("search_products", { query: "hat" });
    const withSmoke = await webmcp.score({ smoke: await webmcp.smoke({ tools: ["search_products", "list_reviews"] }) });
    expect(withSmoke.categories.map((c) => c.name)).toEqual(["declarations", "runtime", "safety", "coverage"]);
    expect(withSmoke.score).toBeGreaterThan(50);
    await expect(webmcp).toHaveAgentReadinessScore(50);
    await expect(page).not.toHaveAgentReadinessScore(101);
  });

  test("codegen and docs reflect the recording", async ({ page, webmcp }) => {
    await page.goto("/");
    await webmcp.call("search_products", { query: "red" });
    await webmcp.call("add_to_cart", { productId: 1, quantity: 2 });
    const source = webmcp.codegen({ name: "buy red shirts" });
    expect(source).toContain('test("buy red shirts", async ({ page, webmcp }) => {');
    expect(source).toContain('await page.goto("/");');
    expect(source).toContain('await webmcp.call("add_to_cart", {');
    expect(source).toContain("expect(webmcp).toMatchCalls([");
    const docs = await webmcp.docs({ title: "Shop tools" });
    expect(docs).toContain("# Shop tools");
    expect(docs).toContain("## `add_to_cart`");
    expect(docs).toContain("| `quantity` | number | no | How many to add; defaults to 1 |");
    expect(docs).toContain('"productId": 1');
  });
});
