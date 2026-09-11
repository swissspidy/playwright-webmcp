import { readFileSync } from "node:fs";
import { formatChanges } from "webmcp-lint";
import { test, expect } from "../src/index.js";

test.describe("tool contract", () => {
  test("matches the stored contract for the demo shop", async ({ page, webmcp }) => {
    await page.goto("/");
    await expect(webmcp).toMatchToolContract();
  });

  test("reports what changed", async ({ page, webmcp }, testInfo) => {
    await page.goto("/");
    // Establish the baseline from the unmodified page (written on first run, compared afterwards).
    const baseline = await webmcp.matchToolContract("demo-shop.json");
    expect(baseline.pass, formatChanges(baseline.changes)).toBe(true);
    await page.evaluate(async () => {
      const mc = (document.modelContext ?? navigator.modelContext)!;
      await mc.registerTool({
        name: "search_products",
        description: "Search the catalogue by keyword and category.",
        inputSchema: { type: "object", properties: { query: { type: "string", description: "Keyword" }, category: { type: "string" } }, required: ["query"] },
        execute: async () => ({}),
      });
      await mc.registerTool({
        name: "checkout",
        description: "Start the checkout flow for the current cart.",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({}),
      });
    });
    let message = "";
    try {
      await expect(webmcp).toMatchToolContract("demo-shop.json");
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toMatch(/tool-added\s+checkout: new imperative tool/);
    expect(message).toMatch(/description-changed\s+search_products/);
    expect(message).toContain('parameter "category" added');
    // The stored contract was not rewritten by the failed comparison.
    const stored = JSON.parse(readFileSync(testInfo.snapshotPath("demo-shop.json"), "utf8"));
    expect(stored.tools.map((t: { name: string }) => t.name)).not.toContain("checkout");
  });
});
