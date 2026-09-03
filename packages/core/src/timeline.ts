/**
 * Registration timeline: when tools become available relative to navigation,
 * and whether they flap.
 */
import type { Finding, RegistrationEvent, Severity } from "./types.js";

export interface TimelineMarks {
  domContentLoaded?: number;
  load?: number;
}

export interface TimelineBudgets {
  /** First registration later than this many ms after navigation start is flagged. Default 3000. */
  lateMs?: number;
  /** A tool registered and unregistered at least this many times is flagged. Default 3. */
  churnCount?: number;
}

export interface TimelineReport {
  events: RegistrationEvent[];
  timeToFirstTool?: number;
  /** Tools registered only after the load event. */
  afterLoad: string[];
  findings: Finding[];
  counts: Record<Severity, number>;
}

export const TIMELINE_RULES = {
  "tools-register-late": { severity: "warning" as Severity, description: "Tools appear long after navigation; agents inspecting the page early will not see them." },
  "tool-churn": { severity: "warning" as Severity, description: "A tool is registered and unregistered repeatedly, which fires toolchange storms and confuses agents mid-task." },
  "tools-after-load": { severity: "info" as Severity, description: "Tools registered after the load event; consider registering during initial script execution." },
} as const;

export function judgeTimeline(events: RegistrationEvent[], marks: TimelineMarks = {}, budgets: TimelineBudgets = {}): TimelineReport {
  const lateMs = budgets.lateMs ?? 3000;
  const churnCount = budgets.churnCount ?? 3;
  const findings: Finding[] = [];
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const first = sorted.find((e) => e.type === "registered");
  const timeToFirstTool = first?.at;

  if (timeToFirstTool !== undefined && timeToFirstTool > lateMs) {
    findings.push({ ruleId: "tools-register-late", severity: TIMELINE_RULES["tools-register-late"].severity, message: `First tool ("${first!.name}") registered ${Math.round(timeToFirstTool)} ms after navigation start; budget is ${lateMs} ms.`, tool: first!.name, help: TIMELINE_RULES["tools-register-late"].description });
  }

  const afterLoad: string[] = [];
  if (marks.load !== undefined) {
    const firstByName = new Map<string, number>();
    for (const e of sorted) if (e.type === "registered" && !firstByName.has(e.name)) firstByName.set(e.name, e.at);
    for (const [name, at] of firstByName) if (at > marks.load) afterLoad.push(name);
    if (afterLoad.length) findings.push({ ruleId: "tools-after-load", severity: TIMELINE_RULES["tools-after-load"].severity, message: `${afterLoad.length} tool(s) registered after the load event: ${afterLoad.join(", ")}.`, help: TIMELINE_RULES["tools-after-load"].description });
  }

  const cycles = new Map<string, number>();
  for (const e of sorted) if (e.type === "unregistered") cycles.set(e.name, (cycles.get(e.name) ?? 0) + 1);
  for (const [name, n] of cycles) {
    if (n >= churnCount) findings.push({ ruleId: "tool-churn", severity: TIMELINE_RULES["tool-churn"].severity, message: `Tool "${name}" was unregistered ${n} times during the session.`, tool: name, help: TIMELINE_RULES["tool-churn"].description });
  }

  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return { events: sorted, timeToFirstTool, afterLoad, findings, counts };
}
