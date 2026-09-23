import { test, expect } from "../src/index.js";

test.describe("registration timeline", () => {
  test("measures time to first tool, late registrations and churn", async ({ page, webmcp }) => {
    await page.goto("/late.html");
    await page.waitForTimeout(1600);
    const report = await webmcp.timeline({ lateMs: 500 });
    expect(report.timeToFirstTool).toBeLessThan(500);
    expect(report.events.filter((e) => e.type === "registered").map((e) => e.name)).toContain("late_tool");
    expect(report.afterLoad).toContain("late_tool");
    const ids = report.findings.map((f) => f.ruleId);
    expect(ids).toContain("tool-churn");
    expect(ids).toContain("tools-after-load");
    expect(ids).not.toContain("tools-register-late");
    await expect(webmcp).toRegisterToolsWithin(500);
    await expect(webmcp).not.toRegisterToolsWithin(0);
  });

  test("a registration the browser rejects is taken back", async ({ page, webmcp }) => {
    await page.goto("/");
    await expect(webmcp).toHaveTool("search_products");
    // Registrations are reported as the page makes them, before the browser answers. A duplicate
    // name is refused, and that must not leave a second registration in the timeline.
    const rejected = await page.evaluate(async () => {
      try {
        await document.modelContext!.registerTool({
          name: "search_products",
          description: "A second tool under a name that is already registered.",
          inputSchema: { type: "object", properties: {} },
          execute: async () => ({}),
        });
        return false;
      } catch {
        return true;
      }
    });
    // The API rejects a name that is already registered; without that, the rest proves nothing.
    expect(rejected).toBe(true);
    const report = await webmcp.timeline();
    expect(report.events.filter((e) => e.name === "search_products")).toHaveLength(1);
  });

  test("timeline resets on navigation", async ({ page, webmcp }) => {
    await page.goto("/late.html");
    await page.goto("/");
    const report = await webmcp.timeline();
    expect(report.events.map((e) => e.name).sort()).toEqual(["add_to_cart", "list_reviews", "search_products"]);
  });
});
