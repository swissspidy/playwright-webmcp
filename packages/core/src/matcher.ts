/**
 * Argument matcher with the same semantics as webmcp-evals' matcher:
 *  - a "constraint object" is a non-null object whose keys all start with "$"
 *  - objects match as subsets (extra actual keys are fine)
 *  - arrays match positionally and must have equal length
 *  - primitives must be strictly equal
 */

export type Constraint = {
  $pattern?: string;
  $contains?: string;
  $gt?: number;
  $gte?: number;
  $lt?: number;
  $lte?: number;
  $type?: "string" | "number" | "boolean" | "array" | "object" | "null";
  $any?: boolean;
};

export function isConstraint(value: unknown): value is Constraint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as object);
  return keys.length > 0 && keys.every((k) => k.startsWith("$"));
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

const INLINE_FLAG_RE = /^\(\?([dgimsuvy]+)\)/;

function compilePattern(pattern: string): RegExp {
  const m = INLINE_FLAG_RE.exec(pattern);
  if (m) return new RegExp(pattern.slice(m[0].length), m[1]);
  return new RegExp(pattern);
}

export function matchesConstraint(constraint: Constraint, actual: unknown): boolean {
  if (constraint.$any !== undefined) {
    return actual !== undefined;
  }
  if (constraint.$type !== undefined && typeOf(actual) !== constraint.$type) return false;
  if (constraint.$pattern !== undefined) {
    if (typeof actual !== "string") return false;
    if (!compilePattern(constraint.$pattern).test(actual)) return false;
  }
  if (constraint.$contains !== undefined) {
    if (typeof actual !== "string" || !actual.includes(constraint.$contains)) return false;
  }
  for (const op of ["$gt", "$gte", "$lt", "$lte"] as const) {
    const bound = constraint[op];
    if (bound === undefined) continue;
    if (typeof actual !== "number") return false;
    if (op === "$gt" && !(actual > bound)) return false;
    if (op === "$gte" && !(actual >= bound)) return false;
    if (op === "$lt" && !(actual < bound)) return false;
    if (op === "$lte" && !(actual <= bound)) return false;
  }
  return true;
}

export function matchesArgument(expected: unknown, actual: unknown): boolean {
  if (isConstraint(expected)) return matchesConstraint(expected, actual);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, i) => matchesArgument(item, actual[i]));
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const actualObj = actual as Record<string, unknown>;
    return Object.entries(expected as Record<string, unknown>).every(([k, v]) =>
      matchesArgument(v, actualObj[k]),
    );
  }
  return expected === actual;
}

/**
 * Explain a mismatch as a list of dotted paths. Used only for error messages,
 * so it favours readability over completeness.
 */
export function explainMismatch(expected: unknown, actual: unknown, path = ""): string[] {
  if (matchesArgument(expected, actual)) return [];
  if (isConstraint(expected) || Array.isArray(expected) || expected === null || typeof expected !== "object") {
    return [`${path || "$"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
  }
  const out: string[] = [];
  const actualObj = (actual ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
    out.push(...explainMismatch(v, actualObj[k], path ? `${path}.${k}` : k));
  }
  return out;
}
