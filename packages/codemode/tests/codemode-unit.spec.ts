import { test, expect } from "@playwright/test";
import { CodeMode, formatResult, sessionFor, type CodeModeOptions } from "../src/index.js";
import { FakeSession, tick } from "./fake-session.js";

async function setup(options: CodeModeOptions = {}) {
  const s = new FakeSession();
  const cm = await CodeMode.create(s, { toolWaitMs: 50, ...options });
  return { s, cm };
}

test("a tool that never answers fails with ToolError after toolTimeoutMs", async () => {
  const { s, cm } = await setup({ toolTimeoutMs: 50 });
  s.addTools({ name: "hang" });
  const r = await cm.execute(`try { await tools.hang(); } catch (e) { return [e.name, e.message]; }`);
  expect(r.result).toEqual(["ToolError", expect.stringContaining("did not respond within 50 ms")]);
  expect(s.sent.some((m) => m.method === "WebMCP.cancelInvocation")).toBe(true);
});

test("a canceled call throws ToolCanceledError", async () => {
  const { s, cm } = await setup();
  s.addTools({ name: "t" });
  s.answer(() => ({ status: "Canceled" }));
  const r = await cm.execute(`try { await tools.t(); } catch (e) { return [e.name, e.tool]; }`);
  expect(r.result).toEqual(["ToolCanceledError", "t"]);
  expect(r.calls[0].outcome).toBe("canceled");
});

test("a stale registration is retried against the current one", async () => {
  const { s, cm } = await setup();
  s.addTools({ name: "t", toolId: "old" });
  s.commands["WebMCP.invokeTool"] = (params) => {
    if (params?.toolId === "old") {
      // The page re-registered the tool just before the call arrived.
      s.addTools({ name: "t", toolId: "new" });
      return new Error("Invalid toolId");
    }
    setTimeout(() => s.emit("WebMCP.toolResponded", { invocationId: "inv-new", status: "Completed", output: "fresh" }), 0);
    return { invocationId: "inv-new" };
  };
  const r = await cm.execute(`return await tools.t();`);
  expect(r.result).toBe("fresh");
  expect(s.sent.filter((m) => m.method === "WebMCP.invokeTool").map((m) => m.params?.toolId)).toEqual(["old", "new"]);
});

test("gives up after repeated refusals", async () => {
  const { s, cm } = await setup();
  s.addTools({ name: "t" });
  s.commands["WebMCP.invokeTool"] = () => new Error("Tool not found");
  const r = await cm.execute(`await tools.t();`);
  expect(r.error).toMatchObject({ name: "ToolError", message: expect.stringContaining("Tool not found") });
  expect(s.sent.filter((m) => m.method === "WebMCP.invokeTool")).toHaveLength(3);
});

test("the policy is asked once per call, with the tool and the page", async () => {
  const seen: unknown[] = [];
  const { s, cm } = await setup({
    onToolCall: (req) => {
      seen.push([req.name, req.args, req.url, req.tool.annotations]);
      return false;
    },
  });
  s.addTools({ name: "buy", annotations: { consequential: true } });
  const r = await cm.execute(`try { await tools.buy({ n: 1 }); } catch (e) { return e.message; }`);
  expect(r.result).toContain("denied by policy");
  expect(seen).toEqual([["buy", { n: 1 }, "http://shop/", { consequential: true }]]);
});

test("rejects non-object arguments", async () => {
  const { s, cm } = await setup();
  s.addTools({ name: "t" });
  const r = await cm.execute(`try { await tools.t([1]); } catch (e) { return [e.name, e.message]; }`);
  expect(r.result).toEqual(["TypeError", "tools.t() takes one object argument"]);
  expect(r.calls[0]).toMatchObject({ outcome: "error" });
});

test("unwrapResults: false passes outputs through untouched", async () => {
  const { s, cm } = await setup({ unwrapResults: false });
  s.addTools({ name: "t" });
  s.answer(() => ({ status: "Completed", output: { content: [{ type: "text", text: '{"a":1}' }] } }));
  expect((await cm.execute(`return await tools.t();`)).result).toEqual({ content: [{ type: "text", text: '{"a":1}' }] });
});

test("an answer that beat the navigation is unwrapped and returned", async () => {
  for (const unwrapResults of [true, false]) {
    const { s, cm } = await setup({ unwrapResults });
    s.addTools({ name: "t" });
    s.respond = (invocationId) => {
      s.emit("Page.frameNavigated", { frame: { id: "main", url: "http://shop/next" } });
      s.emit("WebMCP.toolResponded", { invocationId, status: "Completed", output: '{"ok":true}' });
    };
    const r = await cm.execute(`return await tools.t();`);
    expect(r.result).toEqual(unwrapResults ? { ok: true } : '{"ok":true}');
    expect(r.calls[0].outcome).toBe("navigated");
  }
});

test("browser helpers: tools, waitForTool, sleep, reload and invalid URLs", async () => {
  const { s, cm } = await setup();
  s.addTools({ name: "a", annotations: { readOnly: true } });
  s.commands["Page.reload"] = () => {
    setTimeout(() => s.emit("Page.loadEventFired", {}), 5);
    return {};
  };
  // Registered after the script has started (execute() first waits for the tool list to settle).
  setTimeout(() => s.addTools({ name: "late" }), 400);
  const r = await cm.execute(`
    const list = await browser.tools();
    const late = await browser.waitForTool("late", { timeoutMs: 3000 });
    const never = await browser.waitForTool("never", { timeoutMs: 10 });
    await browser.sleep(1);
    await browser.reload();
    let invalid;
    try { await browser.goto("http://[::1"); } catch (e) { invalid = e.name; }
    return { list, late, never, invalid };
  `);
  expect(r.error).toBeUndefined();
  expect(r.result).toEqual({
    list: [{ name: "a", description: "a", inputSchema: { type: "object", properties: {} }, annotations: { readOnly: true } }],
    late: true,
    never: false,
    invalid: "TypeError",
  });
});

test("scripts run one at a time per page", async () => {
  const { s, cm } = await setup();
  s.addTools({ name: "t" });
  const order: string[] = [];
  s.answer((input) => {
    order.push(String(input.id));
    return { status: "Completed", output: input.id };
  });
  const [a, b] = await Promise.all([
    cm.execute(`await browser.sleep(50); return await tools.t({ id: "a" });`),
    cm.execute(`return await tools.t({ id: "b" });`),
  ]);
  expect([a.result, b.result]).toEqual(["a", "b"]);
  expect(order).toEqual(["a", "b"]);
});

test("formatResult renders logs, calls, navigation and errors", async () => {
  const { s, cm } = await setup();
  s.addTools({ name: "t" });
  s.answer(() => ({ status: "Completed", output: "x".repeat(25_000) }));
  const r = await cm.execute(`console.log("plain"); console.error("bad"); return await tools.t({ q: "${"y".repeat(200)}" });`);
  const text = formatResult(r);
  expect(text).toContain("more characters)");
  expect(text).toContain("Console:\nplain\n[error] bad");
  expect(text).toMatch(/- t\(\{"q":"y+… \(\d+ more characters\)\) → completed \[\d+ ms\]/);
  expect(text).toContain("Page: http://shop/");
  expect(formatResult({ ...r, ok: true, result: undefined, calls: [], logs: [] })).toContain("Result:\nnull");
});

test("sessionFor accepts CDP sessions and rejects anything else", async () => {
  const s = new FakeSession();
  expect(await sessionFor(s)).toBe(s);
  await expect(sessionFor({} as never)).rejects.toThrow("Expected a Playwright page");
});

test("a call approved after the script ended is never started", async () => {
  let approve!: (v: boolean) => void;
  const { s, cm } = await setup({ timeoutMs: 100, onToolCall: () => new Promise<boolean>((resolve) => (approve = resolve)) });
  s.addTools({ name: "buy" });
  const r = await cm.execute(`await tools.buy();`);
  expect(r.error).toMatchObject({ name: "TimeoutError" });
  approve(true);
  await tick(20);
  expect(s.sent.some((m) => m.method === "WebMCP.invokeTool")).toBe(false);
  expect(r.calls[0]).toMatchObject({ name: "buy", outcome: "canceled" });
});
