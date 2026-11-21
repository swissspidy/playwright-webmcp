#!/usr/bin/env node
/**
 * webmcp-codemode: an MCP server that drives Chromium through Playwright and
 * offers the page's WebMCP tools in code mode.
 *
 *   webmcp-codemode --url https://example.com          launch Chromium and open a page
 *   webmcp-codemode --cdp http://localhost:9222        attach to a running Chrome
 */
import { parseArgs } from "node:util";
import { CodeMode } from "./codemode.js";
import { createMcpServer } from "./mcp.js";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    cdp: { type: "string" },
    headed: { type: "boolean", default: false },
    "executable-path": { type: "string" },
    "allow-origin": { type: "string", multiple: true },
    "tool-wait": { type: "string" },
    timeout: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  process.stderr.write(`Usage: webmcp-codemode [--url URL] [--cdp ENDPOINT] [--headed] [--executable-path PATH]
                       [--allow-origin ORIGIN ...] [--tool-wait MS] [--timeout MS]

Starts an MCP server on stdio with two tools, webmcp_api and webmcp_execute, that let a model run
JavaScript against the WebMCP tools of the page. Launches Chromium with --enable-features=WebMCP
unless --cdp attaches to a running browser. --allow-origin limits browser.goto() to the given origins.
`);
  process.exit(0);
}

const log = (...args: unknown[]) => process.stderr.write(`[webmcp-codemode] ${args.join(" ")}\n`);

let playwright: typeof import("playwright");
try {
  playwright = await import("playwright");
} catch {
  log("This command needs the `playwright` package: npm install playwright");
  process.exit(1);
}

const browser = values.cdp
  ? await playwright.chromium.connectOverCDP(values.cdp)
  : await playwright.chromium.launch({
      headless: !values.headed,
      executablePath: values["executable-path"],
      args: ["--enable-features=WebMCP"],
    });
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = context.pages()[0] ?? (await context.newPage());
if (values.url) await page.goto(values.url);

const origins = values["allow-origin"]?.map((o) => new URL(o).origin);
const codeMode = await CodeMode.create(page, {
  ...(values["tool-wait"] ? { toolWaitMs: Number(values["tool-wait"]) } : {}),
  ...(values.timeout ? { timeoutMs: Number(values.timeout) } : {}),
  canNavigate: (u) => (u.protocol === "http:" || u.protocol === "https:") && (!origins || origins.includes(u.origin)),
});
log(`ready on ${page.url()} with ${codeMode.registry.list().length} tools`);

await createMcpServer(codeMode);
// For --cdp this only disconnects; the browser keeps running.
await browser.close();
