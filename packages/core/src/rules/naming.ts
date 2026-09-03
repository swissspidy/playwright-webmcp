import type { Finding } from "../types.js";
import { defineRule, finding, schemaProperties } from "./helpers.js";

export type NamingStyle = "snake_case" | "camelCase" | "kebab-case" | "dot.separated" | "PascalCase" | "single" | "mixed";

export function namingStyle(name: string): NamingStyle {
  if (/^[a-z][a-z0-9]*$/.test(name)) return "single";
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name)) return "snake_case";
  if (/^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(name)) return "camelCase";
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(name)) return "kebab-case";
  if (/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/.test(name)) return "dot.separated";
  if (/^[A-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)*$/.test(name)) return "PascalCase";
  return "mixed";
}

function dominant(styles: NamingStyle[]): { style: NamingStyle; count: number } | undefined {
  const counts = new Map<NamingStyle, number>();
  for (const s of styles) if (s !== "single") counts.set(s, (counts.get(s) ?? 0) + 1);
  let best: { style: NamingStyle; count: number } | undefined;
  for (const [style, count] of counts) if (!best || count > best.count) best = { style, count };
  return best;
}

export const namingConsistency = defineRule({
  id: "naming-consistency",
  description: "Tool and parameter names should follow one naming style; mixed styles make names harder for models to reproduce.",
  severity: "warning",
  check: (ctx) => {
    const out: Finding[] = [];
    const tools = ctx.snapshot.tools;
    const toolStyles = tools.map((t) => namingStyle(t.name));
    const lead = dominant(toolStyles);
    if (lead) {
      tools.forEach((t, i) => {
        const s = toolStyles[i];
        if (s !== "single" && s !== lead.style)
          out.push(finding(namingConsistency, `Tool "${t.name}" is ${s} while most tools use ${lead.style}.`, { tool: t.name, frame: t.frame }));
      });
    }
    const params = tools.flatMap((t) => Object.keys(schemaProperties(t.inputSchema)).map((p) => ({ tool: t, param: p, style: namingStyle(p) })));
    const paramLead = dominant(params.map((p) => p.style));
    if (paramLead) {
      for (const p of params) {
        if (p.style !== "single" && p.style !== paramLead.style)
          out.push(
            finding(namingConsistency, `Parameter "${p.param}" of "${p.tool.name}" is ${p.style} while most parameters use ${paramLead.style}.`, {
              tool: p.tool.name,
              frame: p.tool.frame,
              path: `/properties/${p.param}`,
            }),
          );
      }
    }
    return out;
  },
});

export const exposedToInsecure = defineRule({
  id: "exposed-to-secure-origins",
  description: "exposedTo must list secure origins; http:// origins other than localhost are rejected by the API.",
  severity: "error",
  check: (ctx) =>
    ctx.snapshot.tools.flatMap((t) =>
      (t.exposedTo ?? [])
        .filter((o) => o !== "*" && !/^https:\/\//.test(o) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o))
        .map((o) => finding(exposedToInsecure, `Tool "${t.name}" is exposed to insecure origin ${o}.`, { tool: t.name, frame: t.frame })),
    ),
});
