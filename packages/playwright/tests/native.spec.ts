/**
 * Playwright 1.64 ships its own `page.webmcp` / `frame.webmcp`. `toHaveTool`
 * and `toPassLint` accept it, so a test written against the native API can
 * use the matchers before it moves to the fixture.
 */
import { test, expect } from "../src/index.js";

test.describe("Playwright's page.webmcp", () => {
  test("toHaveTool checks the frame's tools", async ({ page }) => {
    await page.goto("/");
    await expect(page.webmcp).toHaveTool("search_products", {
      description: /catalogue/,
      inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
    });
    // page.webmcp is the main frame only; the iframe's tool is on that frame's own webmcp.
    await expect(page.webmcp).not.toHaveTool("list_reviews");
    const reviews = page.frames().find((f) => f !== page.mainFrame())!;
    await expect(reviews.webmcp).toHaveTool("list_reviews");
  });

  test("toHaveTool explains what does not match", async ({ page }) => {
    await page.goto("/");
    await expect(async () => {
      await expect(page.webmcp).toHaveTool("add_to_cart", { inputSchema: { properties: { quantity: { type: "string" } } } });
    }).rejects.toThrow(/inputSchema\.properties\.quantity\.type/);
    await expect(async () => {
      await expect.configure({ timeout: 500 })(page.webmcp).toHaveTool("search_products", { source: "imperative" });
    }).rejects.toThrow(/source is not reported by page\.webmcp/);
  });

  test("toPassLint runs the rules on the frame's tools", async ({ page }) => {
    await page.goto("/");
    await expect(page.webmcp).toPassLint();
    await page.goto("/bad.html");
    await expect(page.webmcp).not.toPassLint();
  });

  test("toPassLint reads the hints under the page's spelling", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      document.modelContext!.registerTool({
        name: "get_account",
        description: "Return the signed-in account's name and email address.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        execute: async () => ({ name: "Ada", email: "ada@example.com" }),
      } as never);
    });
    await expect(page.webmcp).toHaveTool("get_account");
    // Playwright reports the hints as readOnly/consequential; the rule looks for readOnlyHint/consequentialHint.
    const message = await expect(page.webmcp)
      .toPassLint({ failOn: "warning", rules: { "annotations-explicit": "warning" } })
      .then(
        () => "",
        (err: Error) => err.message,
      );
    // Chromium reports only the hints declared true, so readOnlyHint is the one to check.
    expect(message).toContain('Tool "add_to_cart" does not declare "readOnlyHint"');
    expect(message).not.toContain('Tool "get_account" does not declare "readOnlyHint"');
  });

  test("matchers that need recorded calls or every frame say so", async ({ page }) => {
    await page.goto("/");
    expect(() => expect(page.webmcp).toHaveCalledTool("search_products")).toThrow(
      /toHaveCalledTool needs the webmcp fixture or a Page; Playwright's page\.webmcp supports only toHaveTool and toPassLint/,
    );
  });
});
