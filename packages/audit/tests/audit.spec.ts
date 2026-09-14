import { test, expect } from "@playwright/test";
import { audit, renderMarkdown } from "../src/index.js";

test("audit crawls the demo site and reports drift", async ({ browser, baseURL }) => {
  const report = await audit({ url: baseURL!, maxPages: 6, smoke: true, browser, settleMs: 1400 });
  const urls = report.pages.map((p) => new URL(p.url).pathname).sort();
  expect(urls).toEqual(["/", "/bad.html", "/embed.html", "/late.html"]);
  expect(report.pages.every((p) => p.status === "ok")).toBe(true);
  expect(report.tools).toContain("search_products");
  expect(report.tools).toContain("partner_quote");
  const drift = report.drift.find((d) => d.tool === "search_products");
  expect(drift?.pages.map((u) => new URL(u).pathname).sort()).toEqual(["/", "/late.html"]);
  expect(drift?.changes.some((c) => c.includes('"category" added'))).toBe(true);
  expect(report.findings.some((f) => f.ruleId === "cross-page-drift")).toBe(true);
  expect(report.findings.some((f) => f.ruleId === "tool-name-valid" && f.message.includes("/bad.html"))).toBe(true);
  expect(report.score).toBeGreaterThan(0);
  const md = renderMarkdown(report);
  expect(md).toContain("# WebMCP audit of");
  expect(md).toContain("## Cross-page drift");
  expect(md).toContain("Agent readiness:");
  // The smoke section lists every generated input that ran, so "which inputs?" is answered by the report itself.
  const home = report.pages.find((p) => new URL(p.url).pathname === "/")!;
  expect(home.smoke?.runs.filter((r) => r.tool === "search_products").map((r) => r.label)).toEqual([
    "required parameters only",
    "query empty string",
    "missing required query",
    "query has wrong type",
  ]);
  expect(home.smoke?.skipped.sort()).toEqual(["add_to_cart", "subscribe_newsletter"]);
  expect([...new Set(home.smoke?.runs.map((r) => r.tool))].sort()).toEqual(["list_reviews", "search_products"]);
  expect(md).toContain("| Tool | Input | Arguments | Outcome | ms |");
  expect(md).toContain('| `search_products` | valid-minimal: required parameters only | `{"query":"example"}` | ok |');
  expect(md).toContain("not called: `add_to_cart`");
});

test("the report explains an empty smoke run", () => {
  const md = renderMarkdown({
    startUrl: "https://shop.test/",
    finishedAt: "",
    pages: [
      {
        url: "https://shop.test/",
        status: "ok",
        api: "shim",
        contract: { version: 1, tools: [] },
        smoke: { runs: [], findings: [], counts: { error: 0, warning: 0, info: 0 }, skipped: ["add_to_cart"] },
      },
    ],
    drift: [],
    tools: ["add_to_cart"],
    score: 50,
    findings: [],
  });
  expect(md).toContain("Smoke: 0 generated input(s) against 0 tool(s)");
  expect(md).toContain("No tool on this page is annotated read-only");
  expect(md).toContain("--all-tools");
});
