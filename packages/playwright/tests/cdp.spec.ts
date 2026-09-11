import { test, expect } from "@playwright/test";
import { CdpCollector, type CdpLikeSession } from "../src/cdp.js";
import type { RecordedCall } from "webmcp-lint";

class FakeSession implements CdpLikeSession {
  handlers = new Map<string, Array<(p: any) => void>>();
  sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  supported = true;
  nextInvocation = 1;
  async send(method: string, params?: Record<string, unknown>) {
    this.sent.push({ method, params });
    if (method === "WebMCP.enable" && !this.supported) throw new Error("'WebMCP.enable' wasn't found");
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "F1", url: "http://top/" }, childFrames: [{ frame: { id: "F2", url: "http://top/frame.html" } }] } };
    if (method === "WebMCP.invokeTool") return { invocationId: `inv-${this.nextInvocation++}` };
    return {};
  }
  on(event: string, handler: (p: any) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  emit(event: string, params: any) {
    for (const h of this.handlers.get(event) ?? []) h(params);
  }
}

test("enable() returns false when the domain is missing", async () => {
  const session = new FakeSession();
  session.supported = false;
  const collector = new CdpCollector(session);
  expect(await collector.enable()).toBe(false);
  expect(collector.enabled).toBe(false);
});

test("tracks registrations, frames and locations", async () => {
  const session = new FakeSession();
  const collector = new CdpCollector(session);
  expect(await collector.enable()).toBe(true);
  session.emit("WebMCP.toolsAdded", {
    tools: [
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnly: true },
        frameId: "F1",
        stackTrace: { callFrames: [{ url: "http://top/app.js", lineNumber: 41, columnNumber: 4 }] },
      },
      { name: "subscribe", description: "Form", frameId: "F2", backendNodeId: 7, annotations: { autosubmit: true } },
    ],
  });
  expect(collector.list().map((t) => t.name)).toEqual(["search", "subscribe"]);
  expect(collector.find("search")?.location).toEqual({ url: "http://top/app.js", line: 42, column: 5 });
  expect(collector.frameUrl("F2")).toBe("http://top/frame.html");
  session.emit("WebMCP.toolsRemoved", { tools: [{ name: "subscribe", frameId: "F2" }] });
  expect(collector.list().map((t) => t.name)).toEqual(["search"]);
});

test("records external invocations as agent calls and own invocations as fixture calls", async () => {
  const calls: RecordedCall[] = [];
  const session = new FakeSession();
  const collector = new CdpCollector(session, { onCall: (c) => calls.push(c) });
  await collector.enable();
  session.emit("WebMCP.toolsAdded", { tools: [{ name: "search", description: "", frameId: "F1" }] });

  // Something else (Chrome's agent) invokes the tool.
  session.emit("WebMCP.toolInvoked", { toolName: "search", frameId: "F1", invocationId: "ext-1", input: '{"query":"hat"}' });
  session.emit("WebMCP.toolResponded", { invocationId: "ext-1", status: "Completed", output: { products: [] } });

  // We invoke it through the collector. CDP delivers the invokeTool response
  // before the tool events, so let that response settle before emitting them.
  const pending = collector.invoke("search", { query: "shirt" });
  await new Promise((r) => setTimeout(r, 0));
  session.emit("WebMCP.toolInvoked", { toolName: "search", frameId: "F1", invocationId: "inv-1", input: '{"query":"shirt"}' });
  session.emit("WebMCP.toolResponded", { invocationId: "inv-1", status: "Error", errorText: "boom" });
  const outcome = await pending;

  expect(outcome).toEqual({ ok: false, result: undefined, error: "boom" });
  expect(calls.map((c) => [c.name, c.via, c.source, c.args])).toEqual([
    ["search", "agent", "cdp", { query: "hat" }],
    ["search", "fixture", "cdp", { query: "shirt" }],
  ]);
  expect(calls[0].result).toEqual({ products: [] });
  expect(calls[1].error).toBe("boom");
  expect(session.sent.find((s) => s.method === "WebMCP.invokeTool")?.params).toEqual({ frameId: "F1", toolName: "search", input: { query: "shirt" } });
});
