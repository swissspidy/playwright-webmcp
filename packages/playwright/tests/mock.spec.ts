import { test, expect } from "../src/index.js";
import { executeToolInPage } from "./helpers.js";

test.describe("mock and replay", () => {
  test("mock replaces a tool for the page and the fixture", async ({ page, webmcp }) => {
    await page.goto("/");
    await webmcp.mock("add_to_cart", ({ quantity }) => ({ items: 1, total: 999 * Number(quantity ?? 1) }));
    expect(await webmcp.call("add_to_cart", { productId: 1, quantity: 2 })).toEqual({ items: 1, total: 1998 });
    const fromPage = await executeToolInPage(page, "add_to_cart", { productId: 1 });
    expect(JSON.parse(fromPage as string)).toEqual({ items: 1, total: 999 });
    expect(webmcp.calls().map((c) => c.via)).toEqual(["fixture", "api"]);

    await webmcp.mock("search_products", { error: "search backend down" });
    await expect(webmcp.call("search_products", { query: "x" })).rejects.toThrow(/search backend down/);

    expect(await webmcp.unmock("add_to_cart")).toBe(true);
    expect(await webmcp.call<{ total: number }>("add_to_cart", { productId: 3 })).toMatchObject({ total: 12 });
    await expect(webmcp).toHaveTool("add_to_cart", { inputSchema: { required: ["productId"] } });
  });

  test("a rejected duplicate registration does not make the original mockable", async ({ page, webmcp }) => {
    await page.goto("/");
    await expect(webmcp).toHaveTool("subscribe_newsletter", { source: "declarative" });
    // The form tool has no execute() to wrap, so it cannot be mocked; a failed attempt to register an
    // imperative twin must not change that.
    const rejected = await page.evaluate(async () => {
      const mc = (document.modelContext ?? navigator.modelContext)!;
      try {
        await mc.registerTool({
          name: "subscribe_newsletter",
          description: "twin",
          inputSchema: { type: "object", properties: {} },
          execute: async () => ({}),
        });
        return false;
      } catch {
        return true;
      }
    });
    // Both the shim and Chrome reject a name that is already registered; without that, the rest proves nothing.
    expect(rejected).toBe(true);
    await expect(webmcp.mock("subscribe_newsletter", { result: {} })).rejects.toThrow(/cannot be mocked/);
  });

  test("replay serves recorded results to an agent run", async ({ page, webmcp }) => {
    await page.goto("/");
    await webmcp.call("search_products", { query: "shirt" });
    await webmcp.call("add_to_cart", { productId: 2, quantity: 3 });
    const recording = webmcp.calls();
    webmcp.clearCalls();

    await page.reload();
    await webmcp.replay(recording);
    // Same arguments hit the recording; the real add_to_cart would report a fresh cart total of 66 here too,
    // so mock the recorded total to prove the replay is answering.
    await webmcp.mock("add_to_cart", { result: { items: 1, total: 66, replayed: true } });
    expect(await webmcp.call("search_products", { query: "shirt" })).toEqual(recording[0].result);
    expect(await webmcp.call("add_to_cart", { productId: 2, quantity: 3 })).toEqual({ items: 1, total: 66, replayed: true });
    // Unknown arguments fall back to the first recording unless strict.
    expect(await webmcp.call("search_products", { query: "something else" })).toEqual(recording[0].result);
    await webmcp.replay(recording, { strict: true });
    await expect(webmcp.call("search_products", { query: "something else" })).rejects.toThrow(/No recording/);
  });
});
