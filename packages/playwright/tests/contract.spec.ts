import { readFileSync } from "node:fs";
import { formatChanges } from "webmcp-lint";
import { test, expect } from "../src/index.js";

test.describe("tool contract", () => {
  test("matches the stored contract for the demo shop", async ({ page, webmcp }) => {
    await page.goto("/");
    await expect(webmcp).toMatchToolContract();
  });

  test("reports what changed", async ({ page, webmcp }, testInfo) => {
    const mode = testInfo.config.updateSnapshots;
    test.skip(mode === "all" || mode === "changed", "this test mutates the page; updating snapshots here would store the mutated contract");
    await page.goto("/");
    // Establish the baseline from the shop page (written on first run, compared afterwards).
    const baseline = await webmcp.matchToolContract("demo-shop.json");
    expect(baseline.pass, formatChanges(baseline.changes)).toBe(true);
    // late.html registers search_products with a different description and schema, plus other tools.
    await page.goto("/late.html");
    await page.waitForTimeout(1500);
    let message = "";
    try {
      await expect(webmcp).toMatchToolContract("demo-shop.json");
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toMatch(/tool-added\s+early_tool: new imperative tool/);
    expect(message).toMatch(/tool-removed\s+add_to_cart/);
    expect(message).toMatch(/description-changed\s+search_products/);
    expect(message).toContain('parameter "category" added');
    // The stored contract was not rewritten by the failed comparison.
    const stored = JSON.parse(readFileSync(testInfo.snapshotPath("demo-shop.json"), "utf8"));
    expect(stored.tools.map((t: { name: string }) => t.name)).not.toContain("early_tool");
  });
});
