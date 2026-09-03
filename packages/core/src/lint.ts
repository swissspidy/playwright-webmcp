import { builtinRules } from "./rules/index.js";
import { severityRank } from "./rules/helpers.js";
import type { Finding, LintOptions, LintResult, PageSnapshot, Rule, Severity } from "./types.js";

const SEVERITIES: Severity[] = ["error", "warning", "info"];

export function lint(snapshot: PageSnapshot, options: LintOptions = {}): LintResult {
  const rules = [...builtinRules, ...(options.extraRules ?? [])];
  const findings: Finding[] = [];
  const rulesRun: string[] = [];

  for (const rule of rules) {
    const cfg = options.rules?.[rule.id];
    if (cfg === false) continue;
    if (cfg === undefined && !rule.enabled) continue;
    let severity: Severity = rule.severity;
    let ruleOptions: Record<string, unknown> = { ...(rule.defaults ?? {}) };
    if (typeof cfg === "string") severity = cfg;
    else if (cfg && typeof cfg === "object") {
      ruleOptions = { ...ruleOptions, ...cfg };
      if (typeof cfg.severity === "string" && SEVERITIES.includes(cfg.severity as Severity)) severity = cfg.severity as Severity;
    }
    const effective: Rule = { ...rule, severity };
    rulesRun.push(rule.id);
    for (const f of rule.check({ snapshot, options: ruleOptions })) findings.push({ ...f, severity: effective.severity });
  }

  findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.ruleId.localeCompare(b.ruleId));
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return { findings, counts, rulesRun };
}

export function formatFindings(result: LintResult): string {
  if (!result.findings.length) return "No findings.";
  return result.findings
    .map((f) => {
      const where = [f.tool ? `tool ${f.tool}` : null, f.frame !== undefined ? `frame ${f.frame}` : null, f.path ?? null]
        .filter(Boolean)
        .join(", ");
      return `${f.severity.padEnd(7)} ${f.ruleId}${where ? ` (${where})` : ""}: ${f.message}${f.help ? `\n        ${f.help}` : ""}`;
    })
    .join("\n");
}
