import { test, expect } from "../src/index.js";

test.describe("smoke", () => {
  test("only read-only tools run by default", async ({ page, webmcp }) => {
    await page.goto("/");
    const report = await webmcp.smoke();
    expect(report.runs).toHaveLength(0);
    expect(report.skipped.sort()).toEqual(["add_to_cart", "list_reviews", "search_products", "subscribe_newsletter"]);
  });

  test("schema-driven runs judge results", async ({ page, webmcp }) => {
    await page.goto("/");
    await page.evaluate(async () => {
      const mc = (document.modelContext ?? navigator.modelContext)!;
      await mc.registerTool({
        name: "lookup",
        description: "Look up a product by id and return a record that contains a null field.",
        inputSchema: { type: "object", properties: { id: { type: "number", minimum: 1, maximum: 3 } }, required: ["id"] },
        execute: async ({ id }: { id: number }) => ({ id, name: "Thing", discount: null }),
      });
    });
    const report = await webmcp.smoke({ tools: ["search_products", "lookup"] });
    const runsFor = (tool: string) => report.runs.filter((r) => r.tool === tool);
    expect(runsFor("search_products").map((r) => r.label)).toEqual(["required parameters only", "query empty string", "missing required query", "query has wrong type"]);
    expect(runsFor("lookup").map((r) => r.kind)).toEqual(["valid-minimal", "boundary", "boundary", "invalid", "invalid", "invalid", "invalid"]);

    const ids = report.findings.map((f) => f.ruleId);
    expect(ids).toContain("result-contains-null");
    expect(ids).toContain("result-accepts-invalid-input");
    expect(report.findings.filter((f) => f.ruleId === "result-error-on-valid-input")).toHaveLength(0);
    expect(webmcp.calls().filter((c) => c.name === "lookup").length).toBe(7);
  });

  test("toPassSmoke fails on runtime errors", async ({ page, webmcp }) => {
    await page.goto("/");
    await expect(webmcp).toPassSmoke({ tools: ["search_products"] });
    await expect(webmcp).not.toPassSmoke({ tools: ["search_products"], failOn: "warning" });
    await page.evaluate(async () => {
      const mc = (document.modelContext ?? navigator.modelContext)!;
      await mc.registerTool({
        name: "flaky",
        description: "Always fails, to show that runtime errors on valid input are reported.",
        inputSchema: { type: "object", properties: {} },
        execute: async () => {
          throw new Error("backend unavailable");
        },
      });
    });
    await expect(webmcp).not.toPassSmoke({ tools: ["flaky"] });
  });
});
