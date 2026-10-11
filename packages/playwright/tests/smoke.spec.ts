import { test, expect, type SmokeOptions } from "../src/index.js";

test.describe("smoke", () => {
  test("only read-only tools run by default", async ({ page, webmcp }) => {
    await page.goto("/");
    await expect(webmcp).toHaveTool("list_reviews");
    const report = await webmcp.smoke();
    expect([...new Set(report.runs.map((r) => r.tool))].sort()).toEqual(["list_reviews", "search_products"]);
    expect(report.skipped.sort()).toEqual(["add_to_cart", "subscribe_newsletter"]);
    expect(report.findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  test("schema-driven runs judge results", async ({ page, webmcp }) => {
    await page.goto("/");
    await page.evaluate(async () => {
      const mc = document.modelContext!;
      await mc.registerTool({
        name: "lookup",
        description: "Look up a product by id and return a record that contains a null field.",
        inputSchema: { type: "object", properties: { id: { type: "number", minimum: 1, maximum: 3 } }, required: ["id"] },
        execute: async ({ id }: { id: number }) => ({ id, name: "Thing", discount: null }),
      });
    });
    const report = await webmcp.smoke({ tools: ["search_products", "lookup"] });
    const runsFor = (tool: string) => report.runs.filter((r) => r.tool === tool);
    expect(runsFor("search_products").map((r) => r.label)).toEqual([
      "required parameters only",
      "query empty string",
      "missing required query",
      "query has wrong type",
    ]);
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
      const mc = document.modelContext!;
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

  test("a call that changes the URL is reported against its hints", async ({ page, webmcp }) => {
    await page.goto("/");
    await page.evaluate(async () => {
      const mc = document.modelContext!;
      await mc.registerTool({
        name: "show_results",
        description: "Shows the results view. Use after a search to display matches.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        execute: async () => {
          history.pushState({}, "", `/results?n=${Math.random()}`);
          return { shown: true };
        },
      });
    });
    const report = await webmcp.smoke({ tools: ["show_results"] });
    const run = report.runs.find((r) => r.tool === "show_results");
    expect(run?.navigatedTo).toMatch(/\/results\?n=/);
    const navigates = report.findings.filter((f) => f.ruleId === "result-navigates");
    expect(navigates.length).toBeGreaterThan(0);
    expect(navigates[0].message).toContain("declares readOnlyHint");
  });

  test("a read-only call that sends a writing request is reported", async ({ page, webmcp }) => {
    await page.goto("/");
    await page.route("**/api/**", (route) => route.fulfill({ status: 204 }));
    await page.evaluate(async () => {
      const mc = document.modelContext!;
      await mc.registerTool({
        name: "view_cart",
        description: "Shows the cart contents. Also, quietly, saves them; nothing awaits the save.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        execute: async () => {
          void fetch("/api/cart", { method: "POST", body: "{}" });
          return { items: 0 };
        },
      });
      await mc.registerTool({
        name: "read_cart",
        description: "Reads the cart contents from the server and returns them.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        execute: async () => {
          await fetch("/api/cart");
          return { items: 0 };
        },
      });
    });
    const report = await webmcp.smoke({ tools: ["view_cart", "read_cart"] });
    expect(report.runs.find((r) => r.tool === "view_cart")?.writes).toEqual([{ method: "POST", url: expect.stringMatching(/\/api\/cart$/) }]);
    expect(report.runs.find((r) => r.tool === "read_cart")?.writes).toBeUndefined();
    const writes = report.findings.filter((f) => f.ruleId === "result-writes");
    expect(writes.map((f) => f.tool)).toEqual(["view_cart"]);
    await expect(webmcp).not.toPassSmoke({ tools: ["view_cart"] });
  });

  test("requests the page sends on its own can be ignored", async ({ page, webmcp }) => {
    await page.goto("/");
    await page.route("**/api/**", (route) => route.fulfill({ status: 204 }));
    await page.evaluate(async () => {
      const mc = document.modelContext!;
      await mc.registerTool({
        name: "list_items",
        description: "Lists the items in the cart. Analytics on the page records the call.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        execute: async () => {
          navigator.sendBeacon("/api/track/list", "{}");
          return { items: 0 };
        },
      });
    });
    const writes = async (ignoreRequests?: SmokeOptions["ignoreRequests"]) =>
      (await webmcp.smoke({ tools: ["list_items"], ignoreRequests })).findings.filter((f) => f.ruleId === "result-writes").length;
    expect(await writes()).toBeGreaterThan(0);
    expect(await writes(["**/api/track/**"])).toBe(0);
    expect(await writes([/\/api\/track\//])).toBe(0);
    expect(await writes((r) => r.url.includes("/track/"))).toBe(0);
    expect(await writes(["**/api/*"])).toBeGreaterThan(0);
  });

  test("a write to another origin is a warning unless that origin is first party", async ({ page, webmcp }) => {
    await page.goto("/");
    // The page is on localhost; 127.0.0.1 is the same server under another origin.
    await page.context().route("**/api/**", (route) => route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } }));
    await page.evaluate(async () => {
      const mc = document.modelContext!;
      await mc.registerTool({
        name: "show_wishlist",
        description: "Shows the wishlist. Also, quietly, saves it to the API host.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        execute: async () => {
          void fetch("http://127.0.0.1:4173/api/wishlist", { method: "POST", body: "{}" });
          return { items: 0 };
        },
      });
    });
    const severities = async (options: SmokeOptions = {}) => [
      ...new Set(
        (await webmcp.smoke({ tools: ["show_wishlist"], ...options })).findings
          .filter((f) => f.ruleId.startsWith("result-writes"))
          .map((f) => `${f.ruleId}:${f.severity}`),
      ),
    ];
    expect(await severities()).toEqual(["result-writes-cross-origin:warning"]);
    expect(await severities({ firstPartyOrigins: ["http://127.0.0.1:4173"] })).toEqual(["result-writes:error"]);
    await expect(webmcp.smoke({ tools: ["show_wishlist"], firstPartyOrigins: ["127.0.0.1"] })).rejects.toThrow(/firstPartyOrigins expects origins/);
  });

  test("an ignoreRequests predicate sees the body, so GraphQL queries can pass and mutations still fail", async ({ page, webmcp }) => {
    await page.goto("/");
    await page.route("**/graphql", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"data":{}}' }));
    await page.evaluate(async () => {
      const mc = document.modelContext!;
      const gql = (query: string) => fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
      await mc.registerTool({
        name: "find_orders",
        description: "Finds the user's orders through the GraphQL API.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        execute: async () => {
          await gql("query Orders { orders { id } }");
          return { orders: [] };
        },
      });
      await mc.registerTool({
        name: "view_order",
        description: "Shows an order. Mislabeled: it also marks the order as seen.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        execute: async () => {
          await gql("mutation Seen { markSeen(id: 1) }");
          return { order: {} };
        },
      });
    });
    const isGraphQLQuery = ({ url, body }: { url: string; body?: string }) => {
      if (!url.endsWith("/graphql") || !body) return false;
      try {
        return !/^\s*mutation\b/.test(JSON.parse(body).query);
      } catch {
        return false;
      }
    };
    const report = await webmcp.smoke({ tools: ["find_orders", "view_order"], ignoreRequests: isGraphQLQuery });
    expect([...new Set(report.findings.filter((f) => f.ruleId === "result-writes").map((f) => f.tool))]).toEqual(["view_order"]);
    // The body is for the predicate; it is not kept on the run.
    expect(report.runs.find((r) => r.tool === "view_order")?.writes?.[0]).toEqual({ method: "POST", url: expect.stringMatching(/\/graphql$/) });
  });
});
