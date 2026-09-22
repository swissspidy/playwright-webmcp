/**
 * A single agent-readiness number from lint, smoke and coverage results.
 * Weights are documented in the README; the breakdown is always returned
 * so the number can be explained.
 */
import type { CoverageReport } from "./coverage.js";
import type { Finding, LintResult } from "./types.js";
import type { SmokeReport } from "./smoke.js";

export interface ScoreInput {
  lint: LintResult;
  smoke?: SmokeReport;
  coverage?: CoverageReport;
}

export interface ScoreCategory {
  name: "declarations" | "runtime" | "safety" | "coverage";
  weight: number;
  /** 0..1 */
  value: number;
  points: number;
  notes: string[];
}

export interface Score {
  /** 0..100 */
  score: number;
  categories: ScoreCategory[];
}

export const SAFETY_RULES = new Set([
  "sensitive-params",
  "declarative-autosubmit-sensitive",
  "description-injection",
  "result-suspicious-content",
  "untrusted-content-unmarked",
  "exposed-to-secure-origins",
  "capability-trifecta",
  "tool-shadowing",
  "third-party-registration",
]);

function penalty(findings: Finding[]): { value: number; notes: string[] } {
  let p = 0;
  const notes: string[] = [];
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  p += errors * 0.15 + warnings * 0.05;
  if (errors) notes.push(`${errors} error(s)`);
  if (warnings) notes.push(`${warnings} warning(s)`);
  return { value: Math.max(0, 1 - p), notes };
}

export function computeScore(input: ScoreInput): Score {
  const lintSafety = input.lint.findings.filter((f) => SAFETY_RULES.has(f.ruleId));
  const lintOther = input.lint.findings.filter((f) => !SAFETY_RULES.has(f.ruleId));
  const smokeSafety = input.smoke?.findings.filter((f) => SAFETY_RULES.has(f.ruleId)) ?? [];
  const smokeOther = input.smoke?.findings.filter((f) => !SAFETY_RULES.has(f.ruleId)) ?? [];

  const categories: ScoreCategory[] = [];
  const decl = penalty(lintOther);
  categories.push({ name: "declarations", weight: 40, value: decl.value, points: 0, notes: decl.notes });
  if (input.smoke) {
    const rt = penalty(smokeOther);
    categories.push({ name: "runtime", weight: 30, value: rt.value, points: 0, notes: [...rt.notes, `${input.smoke.runs.length} run(s)`] });
  }
  const safety = penalty([...lintSafety, ...smokeSafety]);
  categories.push({ name: "safety", weight: 15, value: safety.value, points: 0, notes: safety.notes });
  if (input.coverage) {
    const v = input.coverage.total ? 0.7 * input.coverage.ratio + 0.3 * input.coverage.parameterRatio : 1;
    categories.push({ name: "coverage", weight: 15, value: v, points: 0, notes: [`${input.coverage.called}/${input.coverage.total} tools called`] });
  }
  const totalWeight = categories.reduce((n, c) => n + c.weight, 0);
  let score = 0;
  for (const c of categories) {
    c.points = Math.round((c.value * c.weight * 100) / totalWeight);
    score += c.points;
  }
  return { score: Math.min(100, score), categories };
}

export function formatScore(score: Score): string {
  return [
    `Agent readiness: ${score.score}/100`,
    ...score.categories.map((c) => `  ${c.name.padEnd(13)} ${String(c.points).padStart(3)}${c.notes.length ? `  (${c.notes.join(", ")})` : ""}`),
  ].join("\n");
}
