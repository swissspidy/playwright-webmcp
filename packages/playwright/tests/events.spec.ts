import { test, expect, ToolCanceledError } from "../src/index.js";
import type { Page } from "@playwright/test";

/**
 * Registers `place_order`, which shows a busy indicator while an agent is
 * working and clears it when the call is canceled. With `honorSignal` it stops
 * on cancel; without, it places the order anyway.
 */
async function registerOrderTool(page: Page, honorSignal: boolean) {
  await page.route("**/api/orders", (route) => route.fulfill({ status: 201, contentType: "application/json", body: "{}" }));
  await page.evaluate(async (honor) => {
    const mc = document.modelContext!;
    const busy = document.createElement("p");
    busy.id = "agent-busy";
    busy.textContent = "Agent is working";
    busy.hidden = true;
    document.body.append(busy);
    mc.addEventListener("toolactivated", () => (busy.hidden = false));
    mc.addEventListener("toolcancel", () => (busy.hidden = true));
    await mc.registerTool({
      name: "place_order",
      description: "Places the order in the cart. Takes a moment to confirm stock first.",
      inputSchema: { type: "object", properties: {} },
      annotations: { consequentialHint: true },
      execute: async (_args: unknown, client?: { signal?: AbortSignal }) => {
        // Also shown here, for browsers that do not fire toolactivated.
        busy.hidden = false;
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (honor) client?.signal?.throwIfAborted();
        await fetch("/api/orders", { method: "POST", body: "{}" });
        busy.hidden = true;
        return { placed: true };
      },
    });
  }, honorSignal);
}

const orders = (page: Page) => {
  const sent: string[] = [];
  page.on("request", (r) => r.url().endsWith("/api/orders") && sent.push(r.method()));
  return sent;
};

for (const cdp of ["auto", "never"] as const) {
  test.describe(`tool events (cdp: ${cdp})`, () => {
    test.use({ webmcpOptions: { cdp } });

    test.beforeEach(async ({ page, webmcp }) => {
      await page.goto("/");
      test.skip(cdp === "auto" && !webmcp.cdp?.enabled, "this browser has no CDP WebMCP domain");
    });

    test("a call fires toolactivated and is recorded with the events", async ({ page, webmcp }) => {
      test.skip(!(await webmcp.supportsToolEvents()), "this browser does not fire toolactivated");
      await registerOrderTool(page, true);
      const activated = webmcp.waitForEvent("toolactivated", { tool: "place_order" });
      await webmcp.call("place_order");
      expect((await activated).name).toBe("place_order");
      expect(webmcp.events().map((e) => `${e.type}:${e.name}`)).toContain("activated:place_order");
      expect((await webmcp.timeline()).toolEvents?.some((e) => e.type === "activated" && e.name === "place_order")).toBe(true);
      await page.reload();
      expect(webmcp.events()).toEqual([]);
    });

    test("cancelAfter activated cancels the call, and the page's own reaction can be checked", async ({ page, webmcp }) => {
      test.skip(!(await webmcp.supportsToolEvents()), "this browser does not fire toolactivated");
      await registerOrderTool(page, true);
      const sent = orders(page);
      const canceled = webmcp.waitForEvent("toolcancel", { tool: "place_order" });
      const call = webmcp.call("place_order", {}, { cancelAfter: "activated" });
      await expect(call).rejects.toBeInstanceOf(ToolCanceledError);
      await canceled;
      await expect(page.locator("#agent-busy")).toBeHidden();
      await page.waitForTimeout(600);
      expect(sent).toEqual([]);
      const [recorded] = webmcp.calls().filter((c) => c.name === "place_order");
      expect(recorded).toMatchObject({ canceled: true, via: "fixture" });
    });

    test("a tool that ignores its signal still places the order after the cancel", async ({ page, webmcp }) => {
      await registerOrderTool(page, false);
      const sent = orders(page);
      const call = webmcp.call("place_order");
      // Cancel once execute is running, as a timer could land before it starts.
      await expect(page.locator("#agent-busy")).toBeVisible();
      await webmcp.cancel("place_order");
      await expect(call).rejects.toThrow(/was canceled/);
      await expect.poll(() => sent).toEqual(["POST"]);
    });

    test("cancel() reaches a call made through call(), and says so when there is none", async ({ page, webmcp }) => {
      await registerOrderTool(page, true);
      const busy = page.locator("#agent-busy");
      const call = webmcp.call("place_order");
      await expect(busy).toBeVisible();
      expect(await webmcp.cancel("place_order")).toBe(1);
      await expect(call).rejects.toBeInstanceOf(ToolCanceledError);
      await expect(webmcp.cancel("place_order", { timeoutMs: 200 })).rejects.toThrow(/No pending call of "place_order"/);
    });

    test("an aborted signal cancels the call", async ({ page, webmcp }) => {
      await registerOrderTool(page, true);
      const controller = new AbortController();
      const call = webmcp.call("place_order", {}, { signal: controller.signal });
      await expect(page.locator("#agent-busy")).toBeVisible();
      controller.abort();
      await expect(call).rejects.toBeInstanceOf(ToolCanceledError);
      await expect(webmcp.call("place_order", {}, { signal: controller.signal })).rejects.toThrow(/canceled before it started/);
    });
  });
}

test("with CDP, cancel() reaches a call the page made itself, as it would an agent's", async ({ page, webmcp }) => {
  await page.goto("/");
  test.skip(!webmcp.cdp?.enabled, "this browser has no CDP WebMCP domain");
  await registerOrderTool(page, true);
  const outcome = page.evaluate(async (shape) => {
    const mc = document.modelContext!;
    const tool = (await mc.getTools()).find((t) => t.name === "place_order")!;
    return mc.executeTool(tool, (shape === "string" ? "{}" : {}) as never).then(
      () => "resolved",
      () => "rejected",
    );
  }, webmcp.inputShape());
  expect(await webmcp.cancel("place_order")).toBe(1);
  // Chrome rejects the page's promise (with an UnknownError, not an AbortError).
  expect(await outcome).toBe("rejected");
  await expect.poll(() => webmcp.calls().find((c) => c.name === "place_order")?.canceled).toBe(true);
});

test("waitForEvent times out with a clear message, or says the browser has no such events", async ({ page, webmcp }) => {
  await page.goto("/");
  if (!(await webmcp.supportsToolEvents())) {
    await expect(webmcp.waitForEvent("toolcancel")).rejects.toThrow(/waitForEvent\(\) needs a browser that fires toolactivated and toolcancel/);
    await expect(webmcp.call("anything", {}, { cancelAfter: "activated" })).rejects.toThrow(/cancelAfter: "activated" needs a browser/);
    return;
  }
  await expect(webmcp.waitForEvent("toolcancel", { tool: "nope", timeoutMs: 100 })).rejects.toThrow('No toolcancel event for "nope" within 100 ms');
});
