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
});
