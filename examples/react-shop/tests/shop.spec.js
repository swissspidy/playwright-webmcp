import { test, expect } from "playwright-webmcp";

test.describe("react shop", () => {
  test("exposes the tools the components register", async ({ page, webmcp }) => {
    await page.goto("/");
    await expect(page.getByText("Agent tools ready")).toBeVisible();

    await expect(webmcp).toHaveTool("search_products", { inputSchema: { required: ["query"] } });
    await expect(webmcp).toHaveTool("add_to_cart");
    await expect(webmcp).toHaveTool("subscribe_newsletter", { source: "declarative" });
    // The tool-scoped rules already ran in ESLint; the page-level ones need the live page.
    await expect(webmcp).toPassLint({ scope: "page", failOn: "warning" });
    await expect(webmcp).toPassLint({ failOn: "error" });
  });

  test("tools work and results follow the MCP content shape use-webmcp-tool produces", async ({ page, webmcp }) => {
    await page.goto("/");
    await expect(page.getByText("Agent tools ready")).toBeVisible();

    const found = await webmcp.call("search_products", { query: "shirt" });
    expect(found.content[0].type).toBe("text");
    const { products } = JSON.parse(found.content[0].text);
    expect(products.map((p) => p.name)).toEqual(["Red shirt", "Blue shirt"]);

    await webmcp.call("add_to_cart", { productId: products[0].id, quantity: 2 });
    await expect(page.locator("#cart")).toHaveText("Cart: 1 item(s)");
    expect(webmcp).toHaveCalledTool("add_to_cart", { quantity: { $gte: 2 } });
    expect(webmcp).toMatchCalls([{ functionName: "search_products" }, { functionName: "add_to_cart" }]);

    // Read-only tools are smoke tested from their schemas; results are judged, content shape included.
    await expect(webmcp).toPassSmoke({ tools: ["search_products"] });
    await expect(webmcp).toHaveToolCoverage(0.5);
  });

  test("the declarative form waits for the user and answers the agent through respondWith", async ({ page, webmcp }) => {
    await page.goto("/");
    await expect(page.getByText("Agent tools ready")).toBeVisible();
    // Without toolautosubmit the agent fills the form and the call stays open until a person submits it.
    const pending = webmcp.call("subscribe_newsletter", { email: "agent@example.com", frequency: "monthly" });
    await expect(page.locator("#email")).toHaveValue("agent@example.com");
    await expect(page.locator("#newsletter-status")).toHaveText("");
    await page.getByRole("button", { name: "Subscribe" }).click();
    expect(await pending).toEqual({ subscribed: "agent@example.com" });
    await expect(page.locator("#newsletter-status")).toHaveText("Subscribed agent@example.com");
    expect(webmcp).toHaveCalledTool("subscribe_newsletter", { frequency: "monthly" });
  });
});
