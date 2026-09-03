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

  test("timeline resets on navigation", async ({ page, webmcp }) => {
    await page.goto("/late.html");
    await page.goto("/");
    const report = await webmcp.timeline();
    expect(report.events.map((e) => e.name).sort()).toEqual(["add_to_cart", "list_reviews", "search_products"]);
  });
});
