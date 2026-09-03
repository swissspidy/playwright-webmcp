/**
 * Crawl a site with Playwright and audit every page's WebMCP surface.
 */
import { chromium, type Browser, type Page } from "@playwright/test";
import { WebMCP, runSmoke, type SmokeOptions } from "playwright-webmcp";
import {
  computeCoverage,
  computeScore,
  formatChanges,
  formatFindings,
  formatScore,
  lint,
  toContract,
  diffContracts,
  type Finding,
  type LintOptions,
  type LintResult,
  type PageSnapshot,
  type Score,
  type SmokeReport,
  type ToolContract,
} from "webmcp-lint";

export interface AuditOptions {
  /** Start URL. Only same-origin pages are followed. */
  url: string;
  /** Maximum pages to visit. Default 10. */
  maxPages?: number;
  /** Follow links to other pages. Default true. */
  crawl?: boolean;
  /** Run smoke on each page. Default false. Read-only tools only unless smokeOptions widens it. */
  smoke?: boolean;
  smokeOptions?: SmokeOptions;
  lint?: LintOptions;
  /** Milliseconds to wait after load for tools to register. Default 500. */
  settleMs?: number;
  /** Reuse an existing browser instead of launching one. */
  browser?: Browser;
  /** Chrome executable path, for environments with a preinstalled browser. */
  executablePath?: string;
  /** Extra Chromium args, e.g. ["--enable-features=WebMCP"]. */
  args?: string[];
  /** Called after each page. */
  onPage?: (result: PageAudit) => void;
}

export interface PageAudit {
  url: string;
  status: "ok" | "error";
  error?: string;
  snapshot?: PageSnapshot;
  contract?: ToolContract;
  lint?: LintResult;
  smoke?: SmokeReport & { skipped: string[] };
  score?: Score;
  api?: "native" | "shim" | "none";
  cdp?: boolean;
}

export interface AuditReport {
  startUrl: string;
  finishedAt: string;
  pages: PageAudit[];
  /** Tools that appear with different schemas or descriptions on different pages. */
  drift: Array<{ tool: string; pages: string[]; changes: string[] }>;
  /** Union of tools across pages. */
  tools: string[];
  score: number;
  findings: Finding[];
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function normalize(url: string): string {
  const u = new URL(url);
  u.hash = "";
  return u.toString();
}

async function discoverLinks(page: Page, base: string): Promise<string[]> {
  const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => (a as HTMLAnchorElement).href));
  return hrefs.filter((h) => /^https?:/.test(h) && sameOrigin(h, base)).map(normalize);
}

export async function auditPage(page: Page, url: string, options: AuditOptions): Promise<PageAudit> {
  const webmcp = new WebMCP(page, undefined, { shim: "auto", record: true, lint: options.lint ?? {}, cdp: "auto" });
  await webmcp.install();
  try {
    await page.goto(url, { waitUntil: "load" });
    await page.waitForTimeout(options.settleMs ?? 500);
    const snapshot = await webmcp.snapshot();
    const lintResult = lint(snapshot, options.lint ?? {});
    let smoke: PageAudit["smoke"];
    if (options.smoke) smoke = await runSmoke(snapshot.tools, (name, args) => webmcp.call(name, args), options.smokeOptions ?? {});
    const coverage = smoke ? computeCoverage(snapshot.tools, webmcp.calls()) : undefined;
    const score = computeScore({ lint: lintResult, smoke, coverage });
    return { url, status: "ok", snapshot, contract: toContract(snapshot), lint: lintResult, smoke, score, api: snapshot.frames[0]?.api, cdp: Boolean(webmcp.cdp?.enabled) };
  } catch (err) {
    return { url, status: "error", error: String((err as Error)?.message ?? err) };
  } finally {
    await webmcp.flush().catch(() => {});
  }
}

export function detectDrift(pages: PageAudit[]): AuditReport["drift"] {
  const seen = new Map<string, Array<{ url: string; contract: ToolContract }>>();
  for (const p of pages) {
    if (!p.contract) continue;
    for (const t of p.contract.tools) {
      const single: ToolContract = { version: 1, tools: [t] };
      seen.set(t.name, [...(seen.get(t.name) ?? []), { url: p.url, contract: single }]);
    }
  }
  const out: AuditReport["drift"] = [];
  for (const [tool, entries] of seen) {
    if (entries.length < 2) continue;
    const first = entries[0];
    const changes = new Set<string>();
    const pagesWithDrift = new Set<string>([first.url]);
    for (const e of entries.slice(1)) {
      const diff = diffContracts(first.contract, e.contract).filter((c) => c.kind !== "tool-added" && c.kind !== "tool-removed");
      if (diff.length) {
        pagesWithDrift.add(e.url);
        for (const c of diff) changes.add(c.detail);
      }
    }
    if (changes.size) out.push({ tool, pages: [...pagesWithDrift], changes: [...changes] });
  }
  return out;
}

export async function audit(options: AuditOptions): Promise<AuditReport> {
  const maxPages = options.maxPages ?? 10;
  const ownBrowser = !options.browser;
  const browser = options.browser ?? (await chromium.launch({ executablePath: options.executablePath, args: options.args }));
  const context = await browser.newContext();
  const queue = [normalize(options.url)];
  const visited = new Set<string>();
  const pages: PageAudit[] = [];
  try {
    while (queue.length && pages.length < maxPages) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);
      const page = await context.newPage();
      const result = await auditPage(page, url, options);
      if (options.crawl !== false && result.status === "ok") {
        for (const link of await discoverLinks(page, options.url)) if (!visited.has(link) && !queue.includes(link)) queue.push(link);
      }
      await page.close();
      pages.push(result);
      options.onPage?.(result);
    }
  } finally {
    await context.close();
    if (ownBrowser) await browser.close();
  }
  const drift = detectDrift(pages);
  const tools = [...new Set(pages.flatMap((p) => p.contract?.tools.map((t) => t.name) ?? []))].sort();
  const scored = pages.filter((p) => p.score);
  const score = scored.length ? Math.round(scored.reduce((n, p) => n + p.score!.score, 0) / scored.length) : 0;
  const findings: Finding[] = [
    ...pages.flatMap((p) => [...(p.lint?.findings ?? []), ...(p.smoke?.findings ?? [])].map((f) => ({ ...f, help: f.help, message: `${p.url}: ${f.message}` }))),
    ...drift.map((d) => ({ ruleId: "cross-page-drift", severity: "warning" as const, tool: d.tool, message: `Tool "${d.tool}" differs across ${d.pages.length} pages: ${d.changes.join("; ")}.` })),
  ];
  return { startUrl: options.url, finishedAt: new Date().toISOString(), pages, drift, tools, score, findings };
}

export function renderMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`# WebMCP audit of ${report.startUrl}`, "", `Overall agent readiness: **${report.score}/100** across ${report.pages.length} page(s). ${report.tools.length} distinct tool(s): ${report.tools.map((t) => `\`${t}\``).join(", ") || "none"}.`, "");
  if (report.drift.length) {
    lines.push("## Cross-page drift", "");
    for (const d of report.drift) lines.push(`- \`${d.tool}\` on ${d.pages.join(", ")}: ${d.changes.join("; ")}`);
    lines.push("");
  }
  for (const p of report.pages) {
    lines.push(`## ${p.url}`, "");
    if (p.status === "error") {
      lines.push(`Failed: ${p.error}`, "");
      continue;
    }
    lines.push(`API: ${p.api}${p.cdp ? " (CDP collector attached)" : ""}. Tools: ${p.contract?.tools.map((t) => `\`${t.name}\``).join(", ") || "none"}.`, "");
    if (p.score) lines.push("```", formatScore(p.score), "```", "");
    if (p.lint?.findings.length) lines.push("Lint:", "", "```", formatFindings(p.lint), "```", "");
    if (p.smoke) lines.push(`Smoke: ${p.smoke.runs.length} run(s), ${p.smoke.findings.length} finding(s)${p.smoke.skipped.length ? `, skipped ${p.smoke.skipped.join(", ")}` : ""}.`, "");
    if (p.smoke?.findings.length) lines.push("```", formatFindings({ findings: p.smoke.findings, counts: p.smoke.counts, rulesRun: [] }), "```", "");
  }
  return lines.join("\n");
}

export { formatChanges };
