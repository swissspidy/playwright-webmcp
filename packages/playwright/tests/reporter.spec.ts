import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import Reporter from "playwright-webmcp-evals";

test("reporter writes evals.json and tools.json from attachments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webmcp-evals-"));
  const reporter = new Reporter({ outputDir: dir });
  reporter.onBegin({ rootDir: "/" } as never);
  const attach = (name: string, body: unknown) => ({ name, contentType: "application/json", body: Buffer.from(JSON.stringify(body)) });
  reporter.onTestEnd(
    { title: "checkout flow" } as never,
    {
      attachments: [
        attach("webmcp-eval", {
          url: "http://localhost:4173/",
          eval: { name: "buy", messages: [{ role: "user", type: "message", content: "Buy a hat" }], expectedCall: [{ functionName: "add_to_cart" }] },
        }),
        attach("webmcp-tools", { tools: [{ name: "add_to_cart", description: "d", inputSchema: null, outputSchema: null }] }),
      ],
    } as never,
  );
  reporter.onEnd();
  const evals = JSON.parse(readFileSync(join(dir, "evals.json"), "utf8"));
  const tools = JSON.parse(readFileSync(join(dir, "tools.json"), "utf8"));
  expect(evals).toEqual([
    { name: "checkout flow › buy", messages: [{ role: "user", type: "message", content: "Buy a hat" }], expectedCall: [{ functionName: "add_to_cart" }] },
  ]);
  expect(tools.tools.map((t: { name: string }) => t.name)).toEqual(["add_to_cart"]);
});

test("reporter keeps eval names unique across unnamed scenarios", () => {
  const dir = mkdtempSync(join(tmpdir(), "webmcp-evals-"));
  const reporter = new Reporter({ outputDir: dir });
  reporter.onBegin({ rootDir: "/" } as never);
  const attach = (body: unknown) => ({ name: "webmcp-eval", contentType: "application/json", body: Buffer.from(JSON.stringify(body)) });
  const unnamed = { url: "http://localhost/", eval: { messages: [{ role: "user", type: "message", content: "x" }], expectedCall: [] } };
  reporter.onTestEnd({ title: "modes" } as never, { attachments: [attach(unnamed), attach(unnamed)] } as never);
  reporter.onEnd();
  const evals = JSON.parse(readFileSync(join(dir, "evals.json"), "utf8"));
  expect(evals.map((e: { name: string }) => e.name)).toEqual(["modes", "modes (2)"]);
});
