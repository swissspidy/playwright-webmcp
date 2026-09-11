import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import Reporter from "../src/reporter.js";

test("reporter writes tools.json, coverage.json and TOOLS.md from attachments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webmcp-report-"));
  const reporter = new Reporter({ outputDir: dir, title: "Shop tools" });
  reporter.onBegin({ rootDir: "/" } as never);
  const attach = (name: string, body: unknown) => ({ name, contentType: "application/json", body: Buffer.from(JSON.stringify(body)) });
  const tool = {
    name: "add_to_cart",
    title: "Add to cart",
    description: "Add a product to the cart.",
    inputSchema: { type: "object", properties: { productId: { type: "number" }, quantity: { type: "number" } }, required: ["productId"] },
    origin: "http://localhost:4173",
    frame: 0,
    source: "imperative",
  };
  reporter.onTestEnd(
    { title: "checkout flow" } as never,
    {
      attachments: [
        attach("webmcp-tool-snapshots", [tool]),
        attach("webmcp-calls", [{ name: "add_to_cart", args: { productId: 1 }, result: { total: 20 }, startedAt: 1, durationMs: 1, via: "fixture" }]),
      ],
    } as never,
  );
  reporter.onEnd();
  const tools = JSON.parse(readFileSync(join(dir, "tools.json"), "utf8"));
  expect(tools.tools).toEqual([{ name: "add_to_cart", description: "Add a product to the cart.", inputSchema: tool.inputSchema, outputSchema: null }]);
  const coverage = JSON.parse(readFileSync(join(dir, "coverage.json"), "utf8"));
  expect(coverage.tools[0]).toMatchObject({ name: "add_to_cart", calls: 1, parametersNeverSet: ["quantity"] });
  const docs = readFileSync(join(dir, "TOOLS.md"), "utf8");
  expect(docs).toContain("# Shop tools");
  expect(docs).toContain("**Add to cart**");
  expect(docs).toContain('"productId": 1');
});
