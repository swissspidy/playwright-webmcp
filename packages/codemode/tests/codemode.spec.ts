import { test as base, expect } from "@playwright/test";
import { CodeMode, formatResult, QuickJSExecutor, type CodeModeOptions, type Executor, type ResolvedProvider } from "../src/index.js";

const test = base.extend<{ codeMode: (options?: CodeModeOptions) => Promise<CodeMode> }>({
  codeMode: async ({ page }, use) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await use((options) => CodeMode.create(page, options));
  },
});

test("chains tool calls across navigations and late registrations", async ({ codeMode }) => {
  const cm = await codeMode();
  const r = await cm.execute(`
    const [grinder] = await tools.search_products({ query: "grinder" });
    const opened = await tools.open_product({ id: grinder.id });
    // get_product is registered 300 ms after the product page loads.
    const product = await tools.get_product();
    await tools.add_to_cart({ quantity: 2 });
    await tools.back_to_search();
    await tools.go_to_cart();
    const cart = await tools.get_cart();
    return { opened, product, cart };
  `);
  expect(r.error).toBeUndefined();
  expect(r.ok).toBe(true);
  expect(r.result).toEqual({
    opened: { navigated: true, url: expect.stringContaining("/product?id=2") },
    product: { id: 2, name: "Burr grinder", category: "kitchen", price: 129 },
    cart: { lines: [{ name: "Burr grinder", quantity: 2, total: 258 }], total: 258 },
  });
  expect(r.calls.map((c) => [c.name, c.outcome])).toEqual([
    ["search_products", "completed"],
    ["open_product", "navigated"],
    ["get_product", "completed"],
    ["add_to_cart", "completed"],
    ["back_to_search", "navigated"],
    ["go_to_cart", "completed"],
    ["get_cart", "completed"],
  ]);
  expect(r.url.after).toMatch(/\/cart$/);
  expect(r.tools.added).toContain("get_cart");
  expect(r.tools.removed).toContain("search_products");
});

test("browser.goto navigates and the next page's tools become callable", async ({ codeMode }) => {
  const cm = await codeMode();
  const r = await cm.execute(`
    await browser.goto("/product?id=3");
    const p = await tools.get_product();
    const url = await browser.url();
    await browser.back();
    return { name: p.name, url, back: await browser.url(), hasSearch: (await browser.tools()).some(t => t.name === "search_products") };
  `);
  expect(r.result).toEqual({ name: "Desk lamp", url: expect.stringContaining("/product?id=3"), back: expect.stringMatching(/\/$/), hasSearch: true });
});

test("runs independent calls concurrently", async ({ codeMode }) => {
  const cm = await codeMode();
  const r = await cm.execute(`
    const queries = ["espresso", "grinder", "lamp", "frother"];
    const results = await Promise.all(queries.map((query) => tools.search_products({ query })));
    return results.map((r) => r[0].name);
  `);
  expect(r.result).toEqual(["Espresso machine", "Burr grinder", "Desk lamp", "Milk frother"]);
  const [first, ...rest] = r.calls;
  // All four were started before the first one finished.
  for (const c of rest) expect(c.startedAt).toBeLessThanOrEqual(first.startedAt + first.durationMs);
});

test("an unknown tool throws ToolUnavailableError listing what is available", async ({ codeMode }) => {
  const cm = await codeMode({ toolWaitMs: 300 });
  const r = await cm.execute(`
    try {
      await tools.get_cart();
    } catch (e) {
      return { name: e.name, available: e.available, message: e.message };
    }
  `);
  expect(r.result).toMatchObject({ name: "ToolUnavailableError", available: expect.arrayContaining(["search_products", "open_product"]) });
  expect(r.calls[0].outcome).toBe("unavailable");
});

test("tool errors reach the script as ToolError and uncaught errors fail the run", async ({ codeMode }) => {
  const cm = await codeMode();
  const caught = await cm.execute(`try { await tools.fail(); } catch (e) { return [e.name, e.message, e.tool]; }`);
  expect(caught.result).toEqual(["ToolError", expect.stringContaining("out of stock"), "fail"]);
  const uncaught = await cm.execute(`await tools.fail();`);
  expect(uncaught.ok).toBe(false);
  expect(uncaught.error).toMatchObject({ name: "ToolError" });
  expect(formatResult(uncaught)).toContain("Error: ToolError");
});

test("a re-registered tool is called through its current registration", async ({ codeMode, page }) => {
  await page.goto("/cart");
  const cm = await codeMode();
  await page.goto("/cart");
  const first = await cm.execute(`return await tools.cart_version();`);
  expect(first.result).toBe(1);
  const before = cm.registry.get("cart_version");
  await page.evaluate(() => (window as any).reRegister());
  await expect.poll(() => cm.registry.get("cart_version")).not.toBe(before);
  const second = await cm.execute(`return await tools.cart_version();`);
  expect(second.result).toBe(2);
});

test("a stale registration is retried against the current one", async ({ codeMode, page }) => {
  const cm = await codeMode();
  await page.goto("/cart");
  await cm.registry.settle();
  const stale = cm.registry.get("cart_version")!;
  test.skip(!stale.toolId, "This browser's WebMCP domain does not report tool ids yet");
  await page.evaluate(() => (window as any).reRegister());
  // CDP events arrive on our own session, unordered with respect to Playwright's evaluate().
  await expect.poll(() => cm.registry.get("cart_version")?.toolId).not.toBe(stale.toolId);
  // Calling the old registration directly fails in the browser, without running anything.
  const outcome = await cm.registry.invoke(stale, {}, 5000);
  expect(outcome).toMatchObject({ status: "error", stale: true });
});

test("the call policy can deny consequential tools", async ({ codeMode }) => {
  const cm = await codeMode({
    onToolCall: ({ tool }) => (tool.annotations?.consequential ? "needs user approval" : true),
  });
  const r = await cm.execute(`
    await tools.open_product({ id: 1 });
    try { await tools.add_to_cart({}); } catch (e) { return [e.name, e.message]; }
  `);
  expect(r.result).toEqual(["ToolDeniedError", expect.stringContaining("needs user approval")]);
  expect(r.calls.at(-1)).toMatchObject({ name: "add_to_cart", outcome: "denied" });
});

test("browser.goto respects canNavigate", async ({ codeMode }) => {
  const cm = await codeMode({ canNavigate: (u) => u.pathname !== "/cart" });
  const r = await cm.execute(`try { await browser.goto("/cart"); } catch (e) { return e.name; }`);
  expect(r.result).toBe("NavigationDeniedError");
  const file = await cm.execute(`try { await browser.goto("file:///etc/passwd"); } catch (e) { return e.name; }`);
  expect(file.result).toBe("NavigationDeniedError");
});

test("limits: call budget, busy loops and wall-clock timeout", async ({ codeMode }) => {
  const cm = await codeMode({ maxCalls: 3, cpuSliceMs: 200, timeoutMs: 2000 });
  const budget = await cm.execute(`for (let i = 0; i < 5; i++) await tools.cart_size();`);
  expect(budget.error).toMatchObject({ name: "CallLimitError" });
  const busy = await cm.execute(`while (true) {}`);
  expect(busy.error).toMatchObject({ name: "TimeoutError", message: expect.stringContaining("without yielding") });
  const slow = await cm.execute(`await browser.sleep(5000);`);
  expect(slow.error).toMatchObject({ name: "TimeoutError" });
  // The page and the code mode instance still work afterwards.
  const after = await cm.execute(`return await tools.cart_size();`);
  expect(after.result).toBe(0);
});

test("the sandbox has no DOM, network or host access", async ({ codeMode }) => {
  const cm = await codeMode();
  const r = await cm.execute(`
    return ["document", "window", "fetch", "XMLHttpRequest", "process", "require", "__host", "__rpc", "setTimeout"]
      .filter((name) => typeof globalThis[name] !== "undefined");
  `);
  expect(r.result).toEqual([]);
});

test("declarations describe the current page and follow navigation", async ({ codeMode }) => {
  const cm = await codeMode();
  const home = cm.declarations();
  expect(home).toContain("search_products(args: {");
  expect(home).toContain('category?: "kitchen" | "office";');
  expect(home).toContain("(read-only)");
  // Browsers that report outputSchema (Chrome 159+) get typed results.
  if (cm.registry.get("search_products")?.outputSchema) expect(home).toContain("}): Promise<{\n");
  const r = await cm.execute(`await tools.go_to_cart();`);
  expect(r.tools.added).toEqual(expect.arrayContaining(["get_cart", "clear_cart"]));
  const cart = cm.declarations();
  expect(cart).toContain("get_cart(args?: {}): Promise<unknown>;");
  // The home page's tools are only listed under KnownPages now.
  expect(cart.slice(0, cart.indexOf("type KnownPages"))).not.toContain("search_products");
  expect(formatResult(r, { declarations: cart })).toContain("Updated API:");
});

test("remembers pages it has seen and lists them in the declarations", async ({ codeMode }) => {
  const cm = await codeMode();
  expect(cm.declarations()).not.toContain("KnownPages");
  await cm.execute(`await tools.open_product({ id: 2 }); await tools.get_product();`);
  // Back on the search page, the product page is listed with its tools and the call that led there.
  await cm.execute(`await tools.back_to_search();`);
  const home = cm.declarations();
  expect(home).toContain("type KnownPages = {");
  expect(home).toMatch(/"http:\/\/[^"]+\/product": \{/);
  expect(home).toContain("Reached by tools.open_product() on http://");
  expect(home).toContain("add_to_cart(args");
  // The current page is not listed among the others, and compact declarations leave them out.
  expect(home.slice(home.indexOf("type KnownPages"))).not.toContain("search_products(args");
  expect(cm.declarations({ compact: true })).not.toContain("KnownPages");

  const pages = cm.knownPages();
  // Least recently seen first: the search page was seen again last.
  expect(pages.map((p) => new URL(p.page).pathname)).toEqual(["/product", "/"]);
  expect(pages[0].via).toEqual([{ tool: "open_product", from: pages[1].page }]);
  expect(pages[0].tools.map((t) => t.name)).toEqual(expect.arrayContaining(["get_product", "add_to_cart"]));
});

test("a known page keeps the tools seen there before", async ({ codeMode, page }) => {
  const cm = await codeMode();
  await cm.execute(`await tools.go_to_cart();`);
  // A tool the page registers for a while, then removes: it stays known, as the page may register it again.
  await page.evaluate(() => {
    const controller = new AbortController();
    ((document as any).modelContext ?? (navigator as any).modelContext).registerTool(
      { name: "temporary", description: "Here for a moment.", inputSchema: { type: "object", properties: {} }, execute: async () => "ok" },
      { signal: controller.signal },
    );
    (window as any).dropTemporary = () => controller.abort();
  });
  expect((await cm.execute(`return await tools.temporary();`)).result).toBe("ok");
  await page.evaluate(() => (window as any).dropTemporary());
  await expect.poll(() => cm.registry.get("temporary")).toBeUndefined();
  await cm.execute(`return null;`);
  const cart = cm.knownPages().find((p) => p.page.endsWith("/cart"));
  expect(cart?.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["get_cart", "temporary"]));
});

test("knownPages carries seen pages into a new session", async ({ codeMode, page }) => {
  const first = await codeMode();
  await first.execute(`await tools.go_to_cart();`);
  const saved = first.knownPages();
  await page.goto("/");
  const second = await CodeMode.create(page, { knownPages: saved });
  expect(second.declarations()).toContain("get_cart(args?: {}): Promise<unknown>;");
  expect((await CodeMode.create(page, { knownPages: saved, maxKnownPages: 0 })).declarations()).not.toContain("KnownPages");
});

test.describe("known pages, review fixes", () => {
  test("a page inspected with browser.tools() is remembered", async ({ codeMode }) => {
    const cm = await codeMode();
    await cm.execute(`await tools.open_product({ id: 1 }); await browser.tools(); await browser.goto("/cart");`);
    expect(cm.knownPages().map((p) => new URL(p.page).pathname)).toEqual(expect.arrayContaining(["/", "/product", "/cart"]));
  });

  test("a navigation within one page key leaves no route for a later page", async ({ codeMode, page }) => {
    const cm = await codeMode();
    await cm.execute(`await tools.open_product({ id: 1 });`);
    await page.evaluate(() =>
      ((document as any).modelContext ?? (navigator as any).modelContext).registerTool({
        name: "next_product",
        description: "Open the next product.",
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          location.href = "/product?id=2";
          return new Promise(() => {});
        },
      }),
    );
    expect((await cm.execute(`return await tools.next_product();`)).calls[0].outcome).toBe("navigated");
    await cm.execute(`await browser.goto("/cart");`);
    const cart = cm.knownPages().find((p) => p.page.endsWith("/cart"));
    expect(cart?.via).toEqual([]);
  });

  test("a route starts at the page the tool ran on", async ({ codeMode }) => {
    const cm = await codeMode();
    // back_to_search is not on the search page: the call waits for the product page and runs there.
    await cm.execute(`await Promise.all([tools.open_product({ id: 1 }), tools.back_to_search()]);`);
    const pages = cm.knownPages();
    const product = pages.find((p) => p.page.endsWith("/product"))!;
    const home = pages.find((p) => new URL(p.page).pathname === "/")!;
    expect(home.via).toEqual([{ tool: "back_to_search", from: product.page }]);
  });

  test("browser.goto() remembers the page it leaves", async ({ codeMode }) => {
    const cm = await codeMode();
    await cm.execute(`await tools.open_product({ id: 1 }); await browser.goto("/cart");`);
    const product = cm.knownPages().find((p) => p.page.endsWith("/product"));
    expect(product?.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["get_product", "add_to_cart"]));
  });

  test("calls are numbered in the order the page received them", async ({ codeMode }) => {
    const cm = await codeMode();
    // get_product is requested first but waits for the product page, which open_product opens.
    const r = await cm.execute(`await Promise.all([tools.get_product(), tools.open_product({ id: 1 })]);`);
    expect(r.calls.map((c) => c.name)).toEqual(["get_product", "open_product"]);
    const byName = Object.fromEntries(r.calls.map((c) => [c.name, c]));
    expect(byName.open_product.dispatch).toBeLessThan(byName.get_product.dispatch!);
  });

  test("calls say whether they reached the page", async ({ codeMode }) => {
    const cm = await codeMode({ toolWaitMs: 2000 });
    const r = await cm.execute(`tools.get_product(); return await tools.cart_size();`);
    const byName = Object.fromEntries(r.calls.map((c) => [c.name, c]));
    expect(byName.cart_size).toMatchObject({ outcome: "completed", invoked: true });
    expect(byName.get_product).toMatchObject({ outcome: "pending" });
    expect(byName.get_product.invoked).toBeUndefined();
  });
});

test("console output is captured", async ({ codeMode }) => {
  const cm = await codeMode();
  const r = await cm.execute(`async () => { console.log("hi", { a: 1 }); console.warn("careful"); return 42; }`);
  expect(r.result).toBe(42);
  expect(r.logs).toEqual([
    { level: "log", text: 'hi {\n  "a": 1\n}' },
    { level: "warn", text: "careful" },
  ]);
});

test("codemode is an alias of tools", async ({ codeMode }) => {
  const cm = await codeMode();
  const r = await cm.execute(`async () => (await codemode.search_products({ query: "lamp" }))[0].name`);
  expect(r.result).toBe("Desk lamp");
  expect(cm.declarations()).toContain("declare const codemode: typeof tools;");
});

test("runs on another codemode-compatible executor", async ({ codeMode }) => {
  // Any object with Cloudflare's execute(code, providers) contract; here the QuickJS one behind a wrapper,
  // so CodeMode takes the generic path.
  const inner = new QuickJSExecutor();
  const seen: string[][] = [];
  const executor: Executor = {
    execute: (code, providers) => {
      seen.push((providers as ResolvedProvider[]).map((p) => p.name));
      return inner.execute(code, providers);
    },
  };
  const cm = await codeMode({ executor });
  const r = await cm.execute(`
    console.warn("via executor");
    await tools.open_product({ id: 1 });
    return (await codemode.get_product()).name;
  `);
  expect(seen).toEqual([["tools", "codemode", "browser"]]);
  expect(r).toMatchObject({ ok: true, result: "Espresso machine", logs: [{ level: "warn", text: "via executor" }] });
  expect(r.calls.map((c) => c.outcome)).toEqual(["navigated", "completed"]);
  // Errors cross such executors as plain messages: the name ToolUnavailableError is lost.
  const failed = await cm.execute(`await tools.fail();`);
  expect(failed.error).toEqual({ name: "Error", message: expect.stringContaining('Tool "fail" is not registered') });
});

test("browser.tools() and the result include tools the next page registers late", async ({ codeMode }) => {
  const cm = await codeMode();
  // The product page registers its tools 300 ms after it loads.
  const r = await cm.execute(`
    await tools.open_product({ id: 2 });
    return (await browser.tools()).map((t) => t.name);
  `);
  expect(r.error).toBeUndefined();
  expect(r.result).toEqual(["get_product", "add_to_cart", "back_to_search"]);
  expect(r.tools.after).toEqual(["get_product", "add_to_cart", "back_to_search"]);
  expect(cm.declarations({ compact: true })).toContain("add_to_cart(args?: {");
});

test("the tool list after a script waits for a late page, even when the script did not ask", async ({ codeMode }) => {
  const cm = await codeMode();
  const r = await cm.execute(`await tools.open_product({ id: 1 }); return "opened";`);
  expect(r.tools.added).toEqual(["get_product", "add_to_cart", "back_to_search"]);
  expect(formatResult(r, { declarations: cm.declarations({ compact: true }) })).toContain("get_product(args?: {");
});
