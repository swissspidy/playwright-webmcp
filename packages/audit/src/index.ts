/**
 * Crawl a site with Playwright and audit every page's WebMCP surface.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { WebMCP, runSmoke, type SmokeOptions } from "@swissspidy/playwright-webmcp";
import {
  computeCoverage,
  computeScore,
  formatChanges,
  formatFindings,
  formatScore,
  formatSmokeRuns,
  lint,
  toContract,
  diffContracts,
  type ContractChange,
  type Finding,
  type LintOptions,
  type LintResult,
  type PageSnapshot,
  type Score,
  type SmokeReport,
  type ToolContract,
} from "@swissspidy/webmcp-lint";

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
  /** Extra Chromium args, added to `--enable-features=WebMCP`, which turns the API on in Chromium builds that carry it. */
  args?: string[];
  /**
   * HTTP headers sent with every request to the audited origin, e.g. an
   * Authorization header for a staging site. Requests to other origins
   * (third-party frames, CDNs) do not carry them.
   */
  headers?: Record<string, string>;
  /** A previous report to compare tool contracts against, page by page. */
  baseline?: Pick<AuditReport, "pages">;
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
  api?: "native" | "none";
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
  /** Present when a baseline was supplied: per-page contract changes and pages the baseline had but this run did not reach. */
  baseline?: BaselineComparison;
}

export interface BaselineComparison {
  pages: Array<{ url: string; changes: ContractChange[] }>;
  missing: string[];
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
  const webmcp = new WebMCP(page, undefined, { record: true, lint: options.lint ?? {}, cdp: "auto" });
  await webmcp.install();
  try {
    await page.goto(url, { waitUntil: "load" });
    const settleMs = options.settleMs ?? 500;
    await page.waitForTimeout(settleMs);
    // Then require the tool list to hold still for as long again: on native Chrome an iframe's
    // tools can land a few hundred milliseconds after the top page's, and two audits of the
    // same page must see the same contract.
    await webmcp.settle({ quietMs: Math.max(150, Math.min(settleMs, 1000)), timeoutMs: 5000 });
    const snapshot = await webmcp.snapshot();
    const lintResult = lint(snapshot, options.lint ?? {});
    let smoke: PageAudit["smoke"];
    if (options.smoke) smoke = await runSmoke(snapshot.tools, (name, args) => webmcp.call(name, args), options.smokeOptions ?? {});
    const coverage = smoke ? computeCoverage(snapshot.tools, webmcp.calls()) : undefined;
    const score = computeScore({ lint: lintResult, smoke, coverage });
    return {
      url,
      status: "ok",
      snapshot,
      contract: toContract(snapshot),
      lint: lintResult,
      smoke,
      score,
      api: snapshot.frames[0]?.api,
      cdp: Boolean(webmcp.cdp?.enabled),
    };
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

/** Compare each page's tool contract with the same page in a previous report. */
export function compareWithBaseline(pages: PageAudit[], baseline: Pick<AuditReport, "pages">): BaselineComparison {
  const key = (url: string) => {
    try {
      return normalize(url);
    } catch {
      return url;
    }
  };
  const previous = new Map(baseline.pages.filter((p) => p.contract).map((p) => [key(p.url), p]));
  const out: BaselineComparison = { pages: [], missing: [] };
  const seen = new Set<string>();
  for (const page of pages) {
    const before = previous.get(key(page.url));
    seen.add(key(page.url));
    if (!before?.contract || !page.contract) continue;
    const changes = diffContracts(before.contract, page.contract);
    if (changes.length) out.pages.push({ url: page.url, changes });
  }
  for (const [url, page] of previous) if (!seen.has(url) && page.status === "ok") out.missing.push(page.url);
  return out;
}

const MAX_REDIRECT_HOPS = 10;

/** WebMCP is behind a feature flag in Chromium; the audit turns it on in the browser it launches. */
export const WEBMCP_ARGS = ["--enable-features=WebMCP"];

/**
 * Send extra headers with every request to one origin and to no other. Not
 * `extraHTTPHeaders`, which goes to every origin the page touches, and not a
 * plain `route.continue({ headers })` either: Chromium carries the override
 * into the request's redirects, which may leave the origin. So the redirect
 * chain is followed here first, with the headers, up to the first hop that
 * leaves the origin; the browser is then sent to that hop directly and goes
 * without them. A document that stays on the origin is loaded by the browser
 * itself (a fulfilled document breaks its cross-origin frames); anything else
 * is served from the response fetched here.
 */
async function sendHeadersToOrigin(context: BrowserContext, origin: string, headers: Record<string, string>): Promise<void> {
  const isRedirect = (status: number) => status >= 300 && status < 400;
  await context.route(
    (url) => url.origin === origin,
    async (route) => {
      const request = route.request();
      const withHeaders = { ...request.headers(), ...headers };
      try {
        let url = request.url();
        let response = await route.fetch({ headers: withHeaders, maxRedirects: 0 });
        for (let hop = 0; ; hop++) {
          const location = response.headers().location;
          if (!isRedirect(response.status()) || !location) break;
          const next = new URL(location, url);
          if (next.origin !== origin || hop >= MAX_REDIRECT_HOPS) return route.fulfill({ status: response.status(), headers: { location: next.href } });
          url = next.href;
          response = await route.fetch({ url, headers: withHeaders, maxRedirects: 0 });
        }
        if (request.resourceType() === "document" && (request.method() === "GET" || request.method() === "HEAD")) {
          return route.continue({ headers: withHeaders });
        }
        return route.fulfill({ response });
      } catch {
        return route.abort().catch(() => {});
      }
    },
  );
}

export async function audit(options: AuditOptions): Promise<AuditReport> {
  const maxPages = options.maxPages ?? 10;
  const ownBrowser = !options.browser;
  const browser = options.browser ?? (await chromium.launch({ executablePath: options.executablePath, args: [...WEBMCP_ARGS, ...(options.args ?? [])] }));
  const context = await browser.newContext();
  if (options.headers && Object.keys(options.headers).length) await sendHeadersToOrigin(context, new URL(options.url).origin, options.headers);
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
  const baseline = options.baseline ? compareWithBaseline(pages, options.baseline) : undefined;
  const findings: Finding[] = [
    ...pages.flatMap((p) =>
      [...(p.lint?.findings ?? []), ...(p.smoke?.findings ?? [])].map((f) => ({ ...f, help: f.help, message: `${p.url}: ${f.message}` })),
    ),
    ...drift.map((d) => ({
      ruleId: "cross-page-drift",
      severity: "warning" as const,
      tool: d.tool,
      message: `Tool "${d.tool}" differs across ${d.pages.length} pages: ${d.changes.join("; ")}.`,
    })),
    ...(baseline?.pages ?? []).map((p) => ({
      ruleId: "contract-changed",
      severity: "warning" as const,
      message: `${p.url}: tools changed since the baseline: ${p.changes.map((c) => `${c.kind} ${c.tool}`).join(", ")}.`,
      help: formatChanges(p.changes),
    })),
    ...(baseline?.missing ?? []).map((url) => ({
      ruleId: "baseline-page-missing",
      severity: "warning" as const,
      message: `${url} was in the baseline but was not reached in this run.`,
    })),
  ];
  return { startUrl: options.url, finishedAt: new Date().toISOString(), pages, drift, tools, score, findings, ...(baseline ? { baseline } : {}) };
}

export function renderMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(
    `# WebMCP audit of ${report.startUrl}`,
    "",
    `Overall agent readiness: **${report.score}/100** across ${report.pages.length} page(s). ${report.tools.length} distinct tool(s): ${report.tools.map((t) => `\`${t}\``).join(", ") || "none"}.`,
    "",
  );
  if (report.baseline) {
    lines.push("## Changes since baseline", "");
    if (!report.baseline.pages.length && !report.baseline.missing.length) lines.push("No tool changed on any page the baseline covered.", "");
    for (const p of report.baseline.pages) lines.push(`### ${p.url}`, "", "```", formatChanges(p.changes), "```", "");
    for (const url of report.baseline.missing) lines.push(`- ${url} was in the baseline but was not reached in this run.`);
    if (report.baseline.missing.length) lines.push("");
  }
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
    if (p.smoke) {
      const exercised = new Set(p.smoke.runs.map((r) => r.tool)).size;
      lines.push(
        `Smoke: ${p.smoke.runs.length} generated input(s) against ${exercised} tool(s), ${p.smoke.findings.length} finding(s)${p.smoke.skipped.length ? `; not called: ${p.smoke.skipped.map((t) => `\`${t}\``).join(", ")}` : ""}.`,
        "",
      );
      if (!p.smoke.runs.length && p.smoke.skipped.length)
        lines.push(
          "No tool on this page is annotated read-only (`readOnlyHint`), so none was called. Annotate the tools that are safe to call, or pass `--all-tools` (`smokeOptions: { all: true }`) to call every tool.",
          "",
        );
      if (p.smoke.findings.length) lines.push("```", formatFindings({ findings: p.smoke.findings, counts: p.smoke.counts, rulesRun: [] }), "```", "");
      if (p.smoke.runs.length) lines.push(formatSmokeRuns(p.smoke.runs), "");
    }
  }
  return lines.join("\n");
}

export { formatChanges };
