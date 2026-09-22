import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { audit, compareWithBaseline, renderMarkdown, type AuditReport } from "../src/index.js";

test("audit crawls the demo site and reports drift", async ({ browser, baseURL }) => {
  const report = await audit({ url: baseURL!, maxPages: 6, smoke: true, browser, settleMs: 1400, headers: { "x-webmcp-audit": "1" } });
  const urls = report.pages.map((p) => new URL(p.url).pathname).sort();
  expect(urls).toEqual(["/", "/bad.html", "/embed.html", "/late.html"]);
  expect(report.pages.every((p) => p.status === "ok")).toBe(true);
  expect(report.tools).toContain("search_products");
  expect(report.tools).toContain("partner_quote");
  // The header went to the audited origin and not to the partner frame on 127.0.0.1.
  type Requests = Record<string, Record<string, Record<string, string>>>;
  const requests = (await (await fetch(`${baseURL}/__requests`)).json()) as Requests;
  const host = new URL(baseURL!).host;
  expect(requests[host]["/"]["x-webmcp-audit"]).toBe("1");
  expect(requests[host]["/frame.html"]["x-webmcp-audit"]).toBe("1");
  expect(requests["127.0.0.1:4173"]["/partner.html"]).toBeDefined();
  expect(requests["127.0.0.1:4173"]["/partner.html"]["x-webmcp-audit"]).toBeUndefined();
  // A same-origin redirect keeps the header; a cross-origin one does not carry it along.
  await audit({ url: `${baseURL}/__redirect-home`, crawl: false, browser, settleMs: 200, headers: { "x-webmcp-audit": "same-origin" } });
  await audit({ url: `${baseURL}/__redirect-partner`, crawl: false, browser, settleMs: 200, headers: { "x-webmcp-audit": "cross-origin" } });
  const afterRedirects = (await (await fetch(`${baseURL}/__requests`)).json()) as Requests;
  expect(afterRedirects[host]["/__redirect-home"]["x-webmcp-audit"]).toBe("same-origin");
  expect(afterRedirects[host]["/"]["x-webmcp-audit"]).toBe("same-origin");
  expect(afterRedirects[host]["/__redirect-partner"]["x-webmcp-audit"]).toBe("cross-origin");
  expect(afterRedirects["127.0.0.1:4173"]["/partner.html"]["x-webmcp-audit"]).toBeUndefined();
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
        api: "native",
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

test("a baseline report surfaces contract changes per page and pages that disappeared", async ({ browser, baseURL }) => {
  const current = await audit({ url: baseURL!, maxPages: 1, crawl: false, browser, settleMs: 300 });
  const baseline = JSON.parse(JSON.stringify(current)) as AuditReport;
  const home = baseline.pages[0];
  const search = home.contract!.tools.find((t) => t.name === "search_products")!;
  search.description = "An older description of the search tool.";
  home.contract!.tools.push({ ...search, name: "removed_tool" });
  baseline.pages.push({ ...home, url: `${baseURL}/gone.html` });

  const comparison = compareWithBaseline(current.pages, baseline);
  expect(comparison.pages).toHaveLength(1);
  expect(comparison.pages[0].changes.map((c) => `${c.kind} ${c.tool}`).sort()).toEqual(["description-changed search_products", "tool-removed removed_tool"]);
  expect(comparison.missing).toEqual([`${baseURL}/gone.html`]);

  const withBaseline = await audit({ url: baseURL!, maxPages: 1, crawl: false, browser, settleMs: 300, baseline });
  expect(withBaseline.findings.map((f) => f.ruleId)).toEqual(expect.arrayContaining(["contract-changed", "baseline-page-missing"]));
  const md = renderMarkdown(withBaseline);
  expect(md).toContain("## Changes since baseline");
  expect(md).toContain("description-changed");
  expect(md).toContain("was in the baseline but was not reached");

  const unchanged = await audit({ url: baseURL!, maxPages: 1, crawl: false, browser, settleMs: 300, baseline: current });
  expect(unchanged.findings.some((f) => f.ruleId === "contract-changed")).toBe(false);
  expect(renderMarkdown(unchanged)).toContain("No tool changed on any page the baseline covered.");
});

test("the CLI prints GitHub annotations, honours --fail-on and --header, and reads a baseline", () => {
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");
  const out = mkdtempSync(join(tmpdir(), "webmcp-audit-"));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: join(out, "summary.md") } });

  const bad = run("http://localhost:4173/bad.html", "--no-crawl", "--format", "github", "--out", out, "--header", "X-Audit: yes", "--settle", "300");
  expect(bad.status, bad.stderr).toBe(1);
  expect(bad.stdout).toMatch(/^::error title=webmcp-audit%3A tool-name-valid::/m);
  expect(bad.stdout).toMatch(/^::warning title=webmcp-audit%3A sensitive-params::/m);
  expect(readFileSync(join(out, "summary.md"), "utf8")).toContain("# WebMCP audit of");
  const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as AuditReport;
  expect(report.pages[0].status).toBe("ok");

  const lenient = run("http://localhost:4173/bad.html", "--no-crawl", "--fail-on", "never", "--quiet", "--out", out, "--settle", "300");
  expect(lenient.status, lenient.stderr).toBe(0);

  const baselinePath = join(out, "baseline.json");
  const edited = JSON.parse(JSON.stringify(report)) as AuditReport;
  edited.pages[0].contract!.tools[0].description = "Something else entirely.";
  writeFileSync(baselinePath, JSON.stringify(edited));
  const compared = run(
    "http://localhost:4173/bad.html",
    "--no-crawl",
    "--baseline",
    baselinePath,
    "--format",
    "json",
    "--fail-on",
    "never",
    "--out",
    out,
    "--settle",
    "300",
  );
  expect(compared.status, compared.stderr).toBe(0);
  const parsed = JSON.parse(compared.stdout) as AuditReport;
  expect(parsed.baseline?.pages[0].changes[0].kind).toBe("description-changed");

  const usage = run("http://localhost:4173/", "--header", "no-colon");
  expect(usage.status).toBe(2);
  expect(usage.stderr).toContain('--header expects "Name: value"');
});
