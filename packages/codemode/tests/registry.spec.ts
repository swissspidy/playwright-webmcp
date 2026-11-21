import { test, expect } from "@playwright/test";
import { ToolRegistry, ToolTimeoutError, WebMcpUnsupportedError } from "../src/index.js";
import { FakeSession, tick } from "./fake-session.js";

async function setup(options?: ConstructorParameters<typeof ToolRegistry>[1]) {
  const s = new FakeSession();
  const r = new ToolRegistry(s, options);
  await r.start();
  return { s, r };
}

test("start() throws WebMcpUnsupportedError without the WebMCP domain, and is idempotent otherwise", async () => {
  const s = new FakeSession();
  s.webmcp = false;
  await expect(new ToolRegistry(s).start()).rejects.toBeInstanceOf(WebMcpUnsupportedError);
  const { s: ok, r } = await setup();
  await r.start();
  expect(ok.sent.filter((m) => m.method === "WebMCP.enable")).toHaveLength(1);
});

test("a timed-out call is canceled through the browser", async () => {
  const { s, r } = await setup();
  s.addTools({ name: "slow" });
  await expect(r.invoke(r.get("slow")!, {}, 30)).rejects.toBeInstanceOf(ToolTimeoutError);
  expect(s.sent.at(-1)).toEqual({ method: "WebMCP.cancelInvocation", params: { invocationId: "inv-1" } });
});

test("maps error and canceled responses", async () => {
  const { s, r } = await setup();
  s.addTools({ name: "t" });
  s.answer(() => ({ status: "Error", exception: { description: "TypeError: boom" } }));
  expect(await r.invoke(r.get("t")!, {}, 1000)).toEqual({ status: "error", error: "TypeError: boom" });
  s.answer(() => ({ status: "Error", errorText: "bad input" }));
  expect(await r.invoke(r.get("t")!, {}, 1000)).toEqual({ status: "error", error: "bad input" });
  s.answer(() => ({ status: "Canceled" }));
  expect(await r.invoke(r.get("t")!, {}, 1000)).toEqual({ status: "canceled" });
});

test("a refused invocation is reported as stale", async () => {
  const { s, r } = await setup();
  s.addTools({ name: "t", toolId: "old" });
  s.commands["WebMCP.invokeTool"] = () => new Error("Invalid toolId");
  expect(await r.invoke(r.get("t")!, {}, 1000)).toEqual({ status: "error", error: "Invalid toolId", stale: true });
});

test("keeps a real answer that arrives after the page moved on, and reports cancellation by navigation as navigated", async () => {
  const { s, r } = await setup();
  s.addTools({ name: "t" });
  const answered = r.invoke(r.get("t")!, {}, 1000);
  await tick();
  s.emit("Page.frameNavigated", { frame: { id: "main", url: "http://shop/next" } });
  s.emit("WebMCP.toolResponded", { invocationId: "inv-1", status: "Completed", output: { done: true } });
  expect(await answered).toEqual({ status: "navigated", url: "http://shop/next", output: { done: true } });
  s.addTools({ name: "t" });
  const canceled = r.invoke(r.get("t")!, {}, 1000);
  await tick();
  s.emit("Page.frameNavigated", { frame: { id: "main", url: "http://shop/again" } });
  s.emit("WebMCP.toolResponded", { invocationId: "inv-2", status: "Canceled" });
  expect(await canceled).toEqual({ status: "navigated", url: "http://shop/again" });
});

test("a detached frame takes its tools and pending calls with it", async () => {
  const { s, r } = await setup({ navigationGraceMs: 20 });
  s.addTools({ name: "ad", frameId: "child" }, { name: "page" });
  const call = r.invoke(r.get("ad")!, {}, 1000);
  await tick();
  s.emit("Page.frameDetached", { frameId: "child" });
  s.emit("Page.frameDetached", { frameId: "child" });
  expect(r.list().map((t) => t.name)).toEqual(["page"]);
  expect(await call).toEqual({ status: "navigated", url: "" });
});

test("a navigation that lands between the command and its reply still counts", async () => {
  const { s, r } = await setup({ navigationGraceMs: 20 });
  s.addTools({ name: "t" });
  s.commands["WebMCP.invokeTool"] = () => {
    s.emit("Page.frameNavigated", { frame: { id: "main", url: "http://shop/x", urlFragment: "#top" } });
    return { invocationId: "inv-9" };
  };
  expect(await r.invoke(r.get("t")!, {}, 1000)).toEqual({ status: "navigated", url: "http://shop/x#top" });
});

test("navigate() waits for the load event and reports failures", async () => {
  const { s, r } = await setup();
  s.commands["Page.navigate"] = () => {
    setTimeout(() => s.emit("Page.loadEventFired", {}), 10);
    return { frameId: "main", loaderId: "L1" };
  };
  await r.navigate("http://shop/a");
  s.commands["Page.navigate"] = () => ({ frameId: "main" }); // same-document: no loader, no load event
  await r.navigate("http://shop/a#b");
  s.commands["Page.navigate"] = () => ({ frameId: "main", errorText: "net::ERR_NAME_NOT_RESOLVED" });
  await expect(r.navigate("http://nowhere/")).rejects.toThrow("net::ERR_NAME_NOT_RESOLVED");
  s.commands["Page.navigate"] = () => ({ frameId: "main", loaderId: "L2" });
  await expect(r.navigate("http://shop/slow", 30)).rejects.toThrow("did not finish loading within 30 ms");
});

test("back() and reload()", async () => {
  const { s, r } = await setup();
  expect(await r.back()).toBe(false);
  s.history = {
    currentIndex: 1,
    entries: [
      { id: 7, url: "http://shop/" },
      { id: 8, url: "http://shop/b" },
    ],
  };
  s.commands["Page.navigateToHistoryEntry"] = () => {
    setTimeout(() => s.emit("Page.loadEventFired", {}), 5);
    return {};
  };
  expect(await r.back()).toBe(true);
  expect(s.sent.find((m) => m.method === "Page.navigateToHistoryEntry")?.params).toEqual({ entryId: 7 });
  s.commands["Page.reload"] = () => {
    setTimeout(() => s.emit("Page.loadEventFired", {}), 5);
    return {};
  };
  await r.reload();
  expect(s.sent.some((m) => m.method === "Page.reload")).toBe(true);
});

test("settle() waits while a frame is loading", async () => {
  const { s, r } = await setup();
  s.emit("Page.frameStartedLoading", { frameId: "main" });
  const started = Date.now();
  setTimeout(() => s.emit("Page.frameStoppedLoading", { frameId: "main" }), 100);
  await r.settle(20, 2000);
  expect(Date.now() - started).toBeGreaterThanOrEqual(100);
});

test("waitForTool stops when its signal aborts, and onChange can unsubscribe", async () => {
  const { s, r } = await setup();
  const controller = new AbortController();
  const waiting = r.waitForTool("never", 5000, controller.signal);
  controller.abort();
  expect(await waiting).toBeUndefined();
  let changes = 0;
  const off = r.onChange(() => changes++);
  s.addTools({ name: "a" });
  off();
  s.addTools({ name: "b" });
  expect(changes).toBe(1);
});

test.describe("review fixes", () => {
  test("same-document navigations update the URL and keep the tools", async () => {
    const { s, r } = await setup();
    s.addTools({ name: "t" });
    s.emit("Page.navigatedWithinDocument", { frameId: "main", url: "http://shop/checkout/" });
    s.emit("Page.navigatedWithinDocument", { frameId: "gone", url: "http://elsewhere/" });
    expect(r.url()).toBe("http://shop/checkout/");
    expect(r.get("t")).toBeDefined();
  });

  test("the deadline also covers a command reply that stalls; the late invocation is canceled", async () => {
    const { s, r } = await setup();
    s.addTools({ name: "t" });
    let reply!: (v: unknown) => void;
    s.commands["WebMCP.invokeTool"] = () => new Promise((resolve) => (reply = resolve));
    const started = Date.now();
    await expect(r.invoke(r.get("t")!, {}, 50)).rejects.toBeInstanceOf(ToolTimeoutError);
    expect(Date.now() - started).toBeLessThan(1000);
    reply({ invocationId: "late-1" });
    await tick(10);
    expect(s.sent.at(-1)).toEqual({ method: "WebMCP.cancelInvocation", params: { invocationId: "late-1" } });
  });

  test("a frame that detaches before the command reply resolves the call as navigated", async () => {
    const { s, r } = await setup({ navigationGraceMs: 20 });
    s.addTools({ name: "ad", frameId: "child" });
    s.commands["WebMCP.invokeTool"] = () => {
      s.emit("Page.frameDetached", { frameId: "child" });
      return { invocationId: "inv-ad" };
    };
    expect(await r.invoke(r.get("ad")!, {}, 5000)).toEqual({ status: "navigated", url: "" });
  });

  test("a failed navigation command leaves no load wait behind", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { s, r } = await setup();
      for (const method of ["Page.navigate", "Page.reload", "Page.navigateToHistoryEntry"]) s.commands[method] = () => new Error(`${method} failed`);
      s.history = {
        currentIndex: 1,
        entries: [
          { id: 1, url: "http://shop/" },
          { id: 2, url: "http://shop/b" },
        ],
      };
      await expect(r.navigate("http://shop/x", 20)).rejects.toThrow("Page.navigate failed");
      await expect(r.reload(20)).rejects.toThrow("Page.reload failed");
      await expect(r.back(20)).rejects.toThrow("Page.navigateToHistoryEntry failed");
      await tick(60);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
