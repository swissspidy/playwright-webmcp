import { test, expect } from "@playwright/test";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { CodeMode, createMcpServer } from "../src/index.js";
import { FakeSession } from "./fake-session.js";

async function serve() {
  const s = new FakeSession();
  const cm = await CodeMode.create(s, { toolWaitMs: 50, firstToolWaitMs: 0 });
  s.addTools({ name: "add", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } });
  s.answer((input) => ({ status: "Completed", output: (input.a as number) + (input.b as number) }));
  const input = new PassThrough();
  const output = new PassThrough();
  const done = createMcpServer(cm, { input, output, version: "9.9.9" });
  const replies: any[] = [];
  const waiting = new Map<unknown, (msg: any) => void>();
  createInterface({ input: output }).on("line", (line) => {
    const msg = JSON.parse(line);
    replies.push(msg);
    waiting.get(msg.id)?.(msg);
  });
  let id = 0;
  const rpc = (method: string, params?: object) =>
    new Promise<any>((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      input.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  return { input, rpc, done, replies, waiting, s };
}

test("handshake, ping and tool listing", async () => {
  const { rpc, input, done } = await serve();
  const init = await rpc("initialize", { protocolVersion: "1999-01-01" });
  expect(init.result).toMatchObject({
    protocolVersion: "2025-11-25",
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: "webmcp-codemode", version: "9.9.9" },
  });
  expect((await rpc("ping")).result).toEqual({});
  const { result } = await rpc("tools/list");
  expect(result.tools.map((t: any) => t.name)).toEqual(["webmcp_api", "webmcp_execute"]);
  input.end();
  await done;
});

test("webmcp_api and webmcp_execute", async () => {
  const { rpc, input, done } = await serve();
  const api = await rpc("tools/call", { name: "webmcp_api", arguments: {} });
  expect(api.result.content[0].text).toContain("add(args: {");
  const ok = await rpc("tools/call", { name: "webmcp_execute", arguments: { code: "return await tools.add({ a: 2, b: 40 });" } });
  expect(ok.result).toMatchObject({ isError: false, content: [{ type: "text", text: expect.stringContaining("Result:\n42") }] });
  const failed = await rpc("tools/call", { name: "webmcp_execute", arguments: { code: "throw new Error('nope')" } });
  expect(failed.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Error: Error: nope") }] });
  const bad = await rpc("tools/call", { name: "webmcp_execute", arguments: {} });
  expect(bad.result).toEqual({ content: [{ type: "text", text: "`code` must be a string" }], isError: true });
  input.end();
  await done;
});

test("protocol errors", async () => {
  const { rpc, input, done, replies, waiting } = await serve();
  expect((await rpc("tools/call", { name: "nope" })).error).toEqual({ code: -32602, message: "Unknown tool: nope" });
  expect((await rpc("resources/list")).error).toEqual({ code: -32601, message: "Method not found: resources/list" });
  const parseError = new Promise<any>((resolve) => waiting.set(null, resolve));
  input.write("{not json\n");
  expect((await parseError).error).toEqual({ code: -32700, message: "Parse error" });
  // Notifications and blank lines get no reply.
  const before = replies.length;
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n\n");
  await rpc("ping");
  expect(replies.length).toBe(before + 1);
  input.end();
  await done;
});

test("rejects invalid envelopes and batches without stopping", async () => {
  const { rpc, input, done, waiting } = await serve();
  for (const line of ["null", "42", '[{"jsonrpc":"2.0","id":2,"method":"ping"}]', '{"jsonrpc":"2.0","id":"x"}']) {
    const reply = new Promise<any>((resolve) => waiting.set(line.includes('"x"') ? "x" : null, resolve));
    input.write(line + "\n");
    expect((await reply).error).toEqual({ code: -32600, message: "Invalid Request" });
  }
  expect((await rpc("ping")).result).toEqual({});
  input.end();
  await done;
});

test("does not negotiate the batch-only protocol version 2025-03-26", async () => {
  const { rpc, input, done } = await serve();
  expect((await rpc("initialize", { protocolVersion: "2025-03-26" })).result.protocolVersion).toBe("2025-11-25");
  expect((await rpc("initialize", { protocolVersion: "2024-11-05" })).result.protocolVersion).toBe("2024-11-05");
  input.end();
  await done;
});

test("webmcp_execute's description holds the page's API; clients hear when it changes", async () => {
  const { rpc, input, done, replies, s } = await serve();
  const { result } = await rpc("tools/list");
  const execute = result.tools.find((t: any) => t.name === "webmcp_execute");
  expect(execute.description).toContain("The current page's API");
  expect(execute.description).toContain("add(args: {");
  expect(execute.description).toContain("declare const browser");
  s.addTools({ name: "subtract" });
  await expect.poll(() => replies.filter((m) => m.method === "notifications/tools/list_changed").length).toBe(1);
  // Only once until the client lists the tools again.
  s.addTools({ name: "multiply" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(replies.filter((m) => m.method === "notifications/tools/list_changed")).toEqual([{ jsonrpc: "2.0", method: "notifications/tools/list_changed" }]);
  const relisted = await rpc("tools/list");
  expect(relisted.result.tools[1].description).toContain("multiply(args?: {");
  s.addTools({ name: "divide" });
  await expect.poll(() => replies.filter((m) => m.method === "notifications/tools/list_changed").length).toBe(2);
  input.end();
  await done;
});

test("after the tools change, webmcp_execute returns only the tools declaration", async () => {
  const { rpc, input, done, s } = await serve();
  s.answer((_input, name) => {
    if (name === "add") setTimeout(() => s.addTools({ name: "subtract" }), 0);
    return { status: "Completed", output: 1 };
  });
  const r = await rpc("tools/call", { name: "webmcp_execute", arguments: { code: "return await tools.add({ a: 1, b: 2 });" } });
  const text: string = r.result.content[0].text;
  expect(text).toContain("Tools changed: +subtract");
  expect(text).toContain("Updated API:\n// Page: http://shop/\ndeclare const tools: {");
  expect(text).toContain("subtract(args?: {");
  expect(text).not.toContain("declare const browser");
  expect(text).not.toContain("declare const codemode");
  input.end();
  await done;
});
