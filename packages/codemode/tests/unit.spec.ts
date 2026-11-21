import { test, expect } from "@playwright/test";
import { QuickJSExecutor, runInSandbox, schemaToTs, ToolRegistry, unwrapResult, wrapUserCode, type CdpLikeSession } from "../src/index.js";

class FakeSession implements CdpLikeSession {
  handlers = new Map<string, Array<(p: any) => void>>();
  sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  next = 1;
  async send(method: string, params?: Record<string, unknown>) {
    this.sent.push({ method, params });
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "main", url: "http://shop/" }, childFrames: [{ frame: { id: "child", url: "http://shop/ad" } }] } };
    if (method === "WebMCP.invokeTool") return { invocationId: `inv-${this.next++}` };
    return {};
  }
  on(event: string, handler: (p: any) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  emit(event: string, params: any) {
    for (const h of this.handlers.get(event) ?? []) h(params);
  }
}

const tool = (name: string, frameId = "main", extra: object = {}) => ({ name, description: name, frameId, inputSchema: { type: "object" }, ...extra });

test.describe("registry", () => {
  test("drops a frame's tools when it navigates, since Chromium sends no toolsRemoved", async () => {
    const s = new FakeSession();
    const r = new ToolRegistry(s);
    await r.start();
    s.emit("WebMCP.toolsAdded", { tools: [tool("search"), tool("ad_click", "child")] });
    expect(r.list().map((t) => t.name)).toEqual(["search", "ad_click"]);
    s.emit("Page.frameNavigated", { frame: { id: "main", url: "http://shop/cart" } });
    // The child frame belonged to the old document too.
    expect(r.list()).toEqual([]);
    expect(r.url()).toBe("http://shop/cart");
  });

  test("prefers the main frame's tool when names collide", async () => {
    const s = new FakeSession();
    const r = new ToolRegistry(s);
    await r.start();
    s.emit("WebMCP.toolsAdded", { tools: [tool("search", "child"), tool("search", "main")] });
    expect(r.get("search")?.frameId).toBe("main");
  });

  test("ignores a removal for an older registration of the same name", async () => {
    const s = new FakeSession();
    const r = new ToolRegistry(s);
    await r.start();
    s.emit("WebMCP.toolsAdded", { tools: [tool("t", "main", { toolId: "a" })] });
    s.emit("WebMCP.toolsAdded", { tools: [tool("t", "main", { toolId: "b" })] });
    s.emit("WebMCP.toolsRemoved", { tools: [{ name: "t", frameId: "main", toolId: "a" }] });
    expect(r.get("t")?.toolId).toBe("b");
    const call = r.invoke(r.get("t")!, {}, 1000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.sent.at(-1)).toMatchObject({ method: "WebMCP.invokeTool", params: { toolId: "b" } });
    s.emit("WebMCP.toolResponded", { invocationId: "inv-1", status: "Completed", output: 1 });
    expect(await call).toEqual({ status: "completed", output: 1 });
  });

  test("reports the placeholder answer after navigation as navigated", async () => {
    const s = new FakeSession();
    const r = new ToolRegistry(s);
    await r.start();
    s.emit("WebMCP.toolsAdded", { tools: [tool("open")] });
    const call = r.invoke(r.get("open")!, {}, 1000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    s.emit("Page.frameNavigated", { frame: { id: "main", url: "http://shop/p/1" } });
    s.emit("WebMCP.toolResponded", { invocationId: "inv-1", status: "Completed", output: [] });
    expect(await call).toEqual({ status: "navigated", url: "http://shop/p/1" });
  });

  test("resolves as navigated when no answer follows a navigation", async () => {
    const s = new FakeSession();
    const r = new ToolRegistry(s, { navigationGraceMs: 50 });
    await r.start();
    s.emit("WebMCP.toolsAdded", { tools: [tool("open")] });
    const call = r.invoke(r.get("open")!, {}, 5000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    s.emit("Page.frameNavigated", { frame: { id: "main", url: "http://shop/p/2" } });
    expect(await call).toEqual({ status: "navigated", url: "http://shop/p/2" });
  });

  test("handles a response that arrives before the command reply", async () => {
    const s = new FakeSession();
    const original = s.send.bind(s);
    s.send = async (method, params) => {
      const res = await original(method, params);
      if (method === "WebMCP.invokeTool") s.emit("WebMCP.toolResponded", { invocationId: res.invocationId, status: "Completed", output: "early" });
      return res;
    };
    const r = new ToolRegistry(s);
    await r.start();
    s.emit("WebMCP.toolsAdded", { tools: [tool("t")] });
    expect(await r.invoke(r.get("t")!, {}, 1000)).toEqual({ status: "completed", output: "early" });
  });

  test("waitForTool resolves on registration and times out otherwise", async () => {
    const s = new FakeSession();
    const r = new ToolRegistry(s);
    await r.start();
    const waiting = r.waitForTool("late", 1000);
    setTimeout(() => s.emit("WebMCP.toolsAdded", { tools: [tool("late")] }), 20);
    expect((await waiting)?.name).toBe("late");
    expect(await r.waitForTool("never", 30)).toBeUndefined();
  });
});

test.describe("declarations", () => {
  test("schemaToTs covers the common JSON Schema shapes", () => {
    expect(schemaToTs({ type: "string", enum: ["a", "b"] })).toBe('"a" | "b"');
    expect(schemaToTs({ type: ["string", "null"] })).toBe("string | null");
    expect(schemaToTs({ type: "array", items: { type: "integer" } })).toBe("number[]");
    expect(schemaToTs({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } })).toBe("Array<string | number>");
    expect(schemaToTs({ type: "object", properties: {} })).toBe("{}");
    expect(schemaToTs({ type: "object" })).toBe("Record<string, unknown>");
    expect(schemaToTs({ type: "object", additionalProperties: { type: "number" } })).toBe("Record<string, number>");
    expect(schemaToTs({ type: "object", properties: { "a-b": { type: "string", description: "x */ y" } }, required: ["a-b"] })).toBe(
      '{\n  /** x *\\/ y */\n  "a-b": string;\n}',
    );
  });
});

test.describe("sandbox", () => {
  const noHost = async () => {
    throw new Error("no host");
  };

  test("accepts a function body or an async arrow function", async () => {
    expect(wrapUserCode("return 1")).toContain("return 1");
    expect(await runInSandbox("return 1 + 1", noHost)).toMatchObject({ ok: true, value: 2 });
    expect(await runInSandbox("async () => 'arrow'", noHost)).toMatchObject({ ok: true, value: "arrow" });
    expect(await runInSandbox("async function main() { return 3 }", noHost)).toMatchObject({ ok: true, value: 3 });
  });

  test("reports syntax errors and non-serializable results", async () => {
    expect(await runInSandbox("return {", noHost)).toMatchObject({ ok: false, error: { name: "SyntaxError" } });
    expect(await runInSandbox("const a = {}; a.a = a; return a;", noHost)).toMatchObject({ ok: false, error: { name: "TypeError" } });
  });

  test("enforces the memory limit", async () => {
    const r = await runInSandbox("const a = []; for (;;) a.push(new Array(1e4).fill(1));", noHost, "", { memoryLimitBytes: 2 * 1024 * 1024 });
    expect(r).toMatchObject({ ok: false, error: { message: "out of memory" } });
  });

  test("unwrapResult parses MCP-style text content and structuredContent", () => {
    expect(unwrapResult({ content: [{ type: "text", text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(unwrapResult({ content: [{ type: "text", text: "plain" }] })).toBe("plain");
    expect(unwrapResult({ structuredContent: { b: 2 }, content: [] })).toEqual({ b: 2 });
    expect(unwrapResult('{"c":3}')).toEqual({ c: 3 });
    expect(unwrapResult([1, 2])).toEqual([1, 2]);
  });
});

test.describe("QuickJSExecutor (Cloudflare codemode executor contract)", () => {
  test("exposes a function record as codemode.*", async () => {
    const ex = new QuickJSExecutor();
    const r = await ex.execute("async () => { console.warn('w'); return await codemode.add({ a: 2, b: 40 }); }", {
      add: async (args: any) => args.a + args.b,
    });
    expect(r).toEqual({ result: 42, logs: ["[warn] w"] });
  });

  test("exposes providers as namespaces, with multiple arguments and preludes", async () => {
    const ex = new QuickJSExecutor();
    const r = await ex.execute("async () => [await math.mul(6, 7), await math.square(3)]", [
      { name: "math", fns: { mul: async (a, b) => (a as number) * (b as number) }, prelude: "math.square = async (x) => math.mul(x, x);" },
    ]);
    expect(r).toEqual({ result: [42, 9], logs: [] });
  });

  test("returns errors as messages and never throws", async () => {
    const ex = new QuickJSExecutor({ cpuSliceMs: 100 });
    expect(await ex.execute("async () => codemode.nope()", {})).toMatchObject({ result: undefined, error: 'Tool "nope" not found' });
    expect(await ex.execute("async () => { while (true) {} }", {})).toMatchObject({ error: expect.stringContaining("without yielding") });
    expect(await ex.execute("async () =>", {})).toMatchObject({ error: expect.any(String) });
    expect(await ex.execute("async () => 1", [{ name: "not valid", fns: {} }])).toMatchObject({ error: expect.stringContaining("not a valid identifier") });
  });

  test("strips a Markdown code fence", async () => {
    expect(await new QuickJSExecutor().execute("```js\nreturn 5;\n```", {})).toMatchObject({ result: 5 });
  });
});
