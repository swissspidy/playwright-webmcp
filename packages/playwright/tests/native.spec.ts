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

  test("a tools() call that never answers is bounded by the expect timeout", async () => {
    // Stands in for a page.webmcp whose page never answers: it gives up when the timeout it is handed runs out, as Playwright's does.
    const timeouts: (number | undefined)[] = [];
    const stalled = {
      tools: (options?: { timeout?: number }) => {
        timeouts.push(options?.timeout);
        return new Promise<never>((_resolve, reject) => {
          if (options?.timeout) setTimeout(() => reject(new Error(`Timeout ${options.timeout}ms exceeded.`)), options.timeout);
        });
      },
      callTool: async () => undefined,
    };
    const quick = expect.configure({ timeout: 500 });
    for (const assertion of [
      () => quick(stalled).toHaveTool("search_products"),
      () => quick(stalled).not.toHaveTool("checkout"),
      () => quick(stalled).toPassLint(),
    ]) {
      timeouts.length = 0;
      const startedAt = Date.now();
      await expect(assertion()).rejects.toThrow(/Timeout \d+ms exceeded/);
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]).toBeGreaterThan(0);
      expect(timeouts[0]).toBeLessThanOrEqual(500);
    }
  });

  test("matchers that need recorded calls or every frame say so", async ({ page }) => {
    await page.goto("/");
    expect(() => expect(page.webmcp).toHaveCalledTool("search_products")).toThrow(
      /toHaveCalledTool needs the webmcp fixture or a Page; Playwright's page\.webmcp supports only toHaveTool and toPassLint/,
    );
  });
});
