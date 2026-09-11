/**
 * Tool coverage: which exposed tools and parameters the recorded calls
 * actually exercised. The agent-facing analogue of code coverage.
 */
import type { RecordedCall, ToolSnapshot } from "./types.js";
import { schemaProperties } from "./rules/helpers.js";

export interface ToolCoverage {
  name: string;
  calls: number;
  errors: number;
  via: Record<"api" | "fixture" | "agent", number>;
  parameters: string[];
  parametersSeen: string[];
  parametersNeverSet: string[];
}

export interface CoverageReport {
  tools: ToolCoverage[];
  total: number;
  called: number;
  /** called / total, 0..1. */
  ratio: number;
  /** Parameters set at least once / all parameters, 0..1. */
  parameterRatio: number;
  uncalled: string[];
}

export function computeCoverage(tools: Pick<ToolSnapshot, "name" | "inputSchema">[], calls: RecordedCall[]): CoverageReport {
  const byName = new Map<string, ToolCoverage>();
  for (const t of tools) {
    if (byName.has(t.name)) continue;
    const parameters = Object.keys(schemaProperties(t.inputSchema));
    byName.set(t.name, {
      name: t.name,
      calls: 0,
      errors: 0,
      via: { api: 0, fixture: 0, agent: 0 },
      parameters,
      parametersSeen: [],
      parametersNeverSet: [...parameters],
    });
  }
  for (const c of calls) {
    const entry = byName.get(c.name);
    if (!entry) continue;
    entry.calls++;
    if (c.error) entry.errors++;
    entry.via[c.via]++;
    for (const k of Object.keys(c.args ?? {})) {
      if (entry.parameters.includes(k) && !entry.parametersSeen.includes(k)) {
        entry.parametersSeen.push(k);
        entry.parametersNeverSet = entry.parametersNeverSet.filter((p) => p !== k);
      }
    }
  }
  const list = [...byName.values()];
  const called = list.filter((t) => t.calls > 0).length;
  const allParams = list.reduce((n, t) => n + t.parameters.length, 0);
  const seenParams = list.reduce((n, t) => n + t.parametersSeen.length, 0);
  return {
    tools: list,
    total: list.length,
    called,
    ratio: list.length ? called / list.length : 1,
    parameterRatio: allParams ? seenParams / allParams : 1,
    uncalled: list.filter((t) => t.calls === 0).map((t) => t.name),
  };
}

export function formatCoverage(report: CoverageReport): string {
  const rows = report.tools.map(
    (t) =>
      `${t.calls > 0 ? "x" : " "} ${t.name.padEnd(28)} ${String(t.calls).padStart(4)} calls${t.errors ? ` (${t.errors} failed)` : ""}${t.parametersNeverSet.length ? `  never set: ${t.parametersNeverSet.join(", ")}` : ""}`,
  );
  return [
    `Tools: ${report.called}/${report.total} called (${Math.round(report.ratio * 100)}%), parameters ${Math.round(report.parameterRatio * 100)}%`,
    ...rows,
  ].join("\n");
}
