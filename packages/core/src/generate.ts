/**
 * Schema-driven argument generation for smoke runs. Produces a small,
 * deterministic set of inputs from a tool's inputSchema: a minimal valid
 * call, a full valid call, boundary values, and invalid inputs.
 */
import type { JsonSchema } from "./types.js";

export type ArgumentKind = "valid-minimal" | "valid-full" | "boundary" | "invalid";

export interface GeneratedArguments {
  kind: ArgumentKind;
  /** Short label for reports, e.g. "quantity at minimum". */
  label: string;
  args: Record<string, unknown>;
}

export interface GenerateOptions {
  /** Cap on boundary cases per tool. Default 8. */
  maxBoundary?: number;
  /** Cap on invalid cases per tool. Default 6. */
  maxInvalid?: number;
}

function firstType(schema: JsonSchema): string | undefined {
  const t = schema.type;
  if (Array.isArray(t)) return t.find((x) => x !== "null") as string | undefined;
  return typeof t === "string" ? t : undefined;
}

function sampleString(schema: JsonSchema, name: string): string {
  if (Array.isArray(schema.enum) && schema.enum.length) return String(schema.enum[0]);
  if (typeof schema.const === "string") return schema.const;
  if (typeof schema.default === "string") return schema.default;
  if (Array.isArray(schema.examples) && typeof schema.examples[0] === "string") return schema.examples[0];
  const format = schema.format;
  if (format === "email") return "user@example.com";
  if (format === "uri" || format === "url") return "https://example.com/";
  if (format === "date") return "2026-01-15";
  if (format === "date-time") return "2026-01-15T10:00:00Z";
  if (format === "uuid") return "123e4567-e89b-12d3-a456-426614174000";
  let value = /id$/i.test(name) ? "1" : "example";
  const min = typeof schema.minLength === "number" ? schema.minLength : 0;
  while (value.length < min) value += "x";
  const max = typeof schema.maxLength === "number" ? schema.maxLength : Infinity;
  if (value.length > max) value = value.slice(0, max);
  return value;
}

function sampleNumber(schema: JsonSchema): number {
  if (Array.isArray(schema.enum) && schema.enum.length) return Number(schema.enum[0]);
  if (typeof schema.const === "number") return schema.const;
  if (typeof schema.default === "number") return schema.default;
  const min = typeof schema.minimum === "number" ? schema.minimum : typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum + 1 : undefined;
  const max = typeof schema.maximum === "number" ? schema.maximum : typeof schema.exclusiveMaximum === "number" ? schema.exclusiveMaximum - 1 : undefined;
  if (min !== undefined) return min;
  if (max !== undefined) return Math.min(max, 1);
  return 1;
}

export function sampleValue(schema: JsonSchema | undefined, name = ""): unknown {
  if (!schema || typeof schema !== "object") return "example";
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  const type = firstType(schema) ?? (schema.properties ? "object" : schema.items ? "array" : "string");
  switch (type) {
    case "string":
      return sampleString(schema, name);
    case "number":
    case "integer":
      return sampleNumber(schema);
    case "boolean":
      return typeof schema.default === "boolean" ? schema.default : true;
    case "array": {
      const items = (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items) ? schema.items : undefined) as JsonSchema | undefined;
      const minItems = typeof schema.minItems === "number" ? schema.minItems : 1;
      return Array.from({ length: Math.max(1, minItems) }, () => sampleValue(items, name));
    }
    case "object": {
      const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
      const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) if (required.has(k)) out[k] = sampleValue(v, k);
      return out;
    }
    case "null":
      return null;
    default:
      return "example";
  }
}

function wrongTypeValue(schema: JsonSchema): unknown {
  const type = firstType(schema) ?? "string";
  if (type === "string") return 12345;
  if (type === "number" || type === "integer") return "not-a-number";
  if (type === "boolean") return "yes";
  if (type === "array") return "not-an-array";
  if (type === "object") return "not-an-object";
  return {};
}

export function generateArguments(schema: JsonSchema | null | undefined, options: GenerateOptions = {}): GeneratedArguments[] {
  const maxBoundary = options.maxBoundary ?? 8;
  const maxInvalid = options.maxInvalid ?? 6;
  const props = ((schema?.properties ?? {}) as Record<string, JsonSchema>) || {};
  const required = Array.isArray(schema?.required) ? (schema!.required as string[]).filter((r) => r in props) : [];
  const out: GeneratedArguments[] = [];

  const minimal: Record<string, unknown> = {};
  for (const r of required) minimal[r] = sampleValue(props[r], r);
  out.push({ kind: "valid-minimal", label: required.length ? "required parameters only" : "no parameters", args: minimal });

  const full: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) full[k] = sampleValue(v, k);
  if (Object.keys(full).length > Object.keys(minimal).length) out.push({ kind: "valid-full", label: "all parameters", args: full });

  const boundary: GeneratedArguments[] = [];
  for (const [k, v] of Object.entries(props)) {
    const type = firstType(v);
    if (type === "number" || type === "integer") {
      if (typeof v.minimum === "number") boundary.push({ kind: "boundary", label: `${k} at minimum`, args: { ...minimal, [k]: v.minimum } });
      if (typeof v.maximum === "number") boundary.push({ kind: "boundary", label: `${k} at maximum`, args: { ...minimal, [k]: v.maximum } });
    }
    if (type === "string" && typeof v.maxLength === "number") {
      boundary.push({ kind: "boundary", label: `${k} at maxLength`, args: { ...minimal, [k]: "x".repeat(v.maxLength) } });
    }
    if (type === "string" && !("maxLength" in v) && !Array.isArray(v.enum)) {
      boundary.push({ kind: "boundary", label: `${k} empty string`, args: { ...minimal, [k]: "" } });
    }
    if (Array.isArray(v.enum)) {
      for (const e of v.enum.slice(1, 4)) boundary.push({ kind: "boundary", label: `${k} = ${JSON.stringify(e)}`, args: { ...minimal, [k]: e } });
    }
    if (type === "array") boundary.push({ kind: "boundary", label: `${k} empty array`, args: { ...minimal, [k]: [] } });
  }
  out.push(...boundary.slice(0, maxBoundary));

  const invalid: GeneratedArguments[] = [];
  for (const r of required) {
    const rest = { ...minimal };
    delete rest[r];
    invalid.push({ kind: "invalid", label: `missing required ${r}`, args: rest });
  }
  for (const [k, v] of Object.entries(props)) {
    invalid.push({ kind: "invalid", label: `${k} has wrong type`, args: { ...minimal, [k]: wrongTypeValue(v) } });
    if (Array.isArray(v.enum)) invalid.push({ kind: "invalid", label: `${k} outside enum`, args: { ...minimal, [k]: "__not_in_enum__" } });
    if (typeof v.minimum === "number") invalid.push({ kind: "invalid", label: `${k} below minimum`, args: { ...minimal, [k]: v.minimum - 1 } });
    if (typeof v.maximum === "number") invalid.push({ kind: "invalid", label: `${k} above maximum`, args: { ...minimal, [k]: v.maximum + 1 } });
  }
  out.push(...invalid.slice(0, maxInvalid));
  return out;
}
