import type { Finding, JsonSchema, Rule, RuleContext, Severity, ToolSnapshot } from "../types.js";

export function defineRule(rule: Omit<Rule, "enabled"> & { enabled?: boolean }): Rule {
  return { enabled: true, ...rule };
}

export function finding(rule: Pick<Rule, "id" | "severity">, message: string, extra: Partial<Finding> = {}): Finding {
  return { ruleId: rule.id, severity: rule.severity, message, ...extra };
}

export function forEachTool(ctx: RuleContext, fn: (tool: ToolSnapshot) => Finding[]): Finding[] {
  return ctx.snapshot.tools.flatMap(fn);
}

export function opt<T>(ctx: RuleContext, key: string, fallback: T): T {
  const v = ctx.options[key];
  return (v === undefined ? fallback : v) as T;
}

export function schemaProperties(schema: JsonSchema | null): Record<string, JsonSchema> {
  const props = schema?.properties;
  if (!props || typeof props !== "object") return {};
  return props as Record<string, JsonSchema>;
}

/** Depth-first walk over a JSON value, yielding (path, value). */
export function* walk(value: unknown, path = ""): Generator<[string, unknown]> {
  yield [path, value];
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* walk(value[i], `${path}/${i}`);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) yield* walk(v, `${path}/${k}`);
  }
}

export function severityRank(s: Severity): number {
  return s === "error" ? 3 : s === "warning" ? 2 : 1;
}
