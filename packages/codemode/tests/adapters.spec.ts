import { test, expect, chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { CodeMode } from "../src/index.js";

test("works with a Puppeteer page", async ({ baseURL }) => {
  const browser = await puppeteer.launch({
    executablePath: process.env.PW_CHROMIUM ?? chromium.executablePath(),
    headless: true,
    args: ["--enable-features=WebMCP", "--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`${baseURL}/`);
    const cm = await CodeMode.create(page);
    const r = await cm.execute(`
      await tools.open_product({ id: 4 });
      return (await tools.get_product()).name;
    `);
    expect(r.error).toBeUndefined();
    expect(r.result).toBe("Milk frother");
  } finally {
    await browser.close();
  }
});

test("serves code mode over MCP stdio", async ({ baseURL }) => {
  // The built CLI, as npx would run it; `pnpm test` builds first.
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const browser = process.env.PW_CHROMIUM ? ["--executable-path", process.env.PW_CHROMIUM] : [];
  const child = spawn(process.execPath, [cli, "--url", `${baseURL}/`, "--allow-origin", baseURL!, ...browser], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout! });
  const waiting = new Map<number, (msg: any) => void>();
  lines.on("line", (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  });
  let id = 0;
  const rpc = (method: string, params?: object) =>
    new Promise<any>((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(init.result.protocolVersion).toBe("2025-06-18");
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: any) => t.name)).toEqual(["webmcp_api", "webmcp_execute"]);
    const api = await rpc("tools/call", { name: "webmcp_api", arguments: {} });
    expect(api.result.content[0].text).toContain("search_products(args: {");
    const exec = await rpc("tools/call", {
      name: "webmcp_execute",
      arguments: { code: `await tools.go_to_cart(); return await tools.get_cart();` },
    });
    expect(exec.result.isError).toBe(false);
    const text = exec.result.content[0].text;
    expect(text).toContain('"total": 0');
    expect(text).toContain("Page navigated:");
    expect(text).toContain("Tools changed: +get_cart");
    expect(text).toContain("Updated API:");
    const denied = await rpc("tools/call", { name: "webmcp_execute", arguments: { code: `await browser.goto("https://example.com/")` } });
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0].text).toContain("NavigationDeniedError");
  } finally {
    child.stdin!.end();
    await new Promise((resolve) => child.once("exit", resolve));
  }
});
