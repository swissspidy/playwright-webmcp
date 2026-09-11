/**
 * A port of the trajectory matcher in Google's `webmcp-evals` CLI
 * (`evaluateExecutionTrajectory` in its `utils.ts`), so that a case which
 * passes here passes there too.
 *
 * The semantics differ from the lenient `reconcileCalls()` default:
 *  - expected calls are matched positionally: a required call must be
 *    satisfied by the very next unconsumed actual call, not by any later one;
 *  - an optional call that does not match simply yields its position to the
 *    next expected node;
 *  - `{ unordered: [...] }` groups of plain calls are matched against a pool of
 *    exactly as many actual calls as the group has entries, optional entries
 *    included, via maximum bipartite matching; groups that nest other groups
 *    are matched by trying orderings of their entries, capped at 15 entries;
 *  - every actual call that is not consumed by an expectation fails the case.
 */
import type { EvalFunctionCall, ExpectedCallNode } from "./evals-types.js";
import type { ActualCall } from "./reconcile.js";
import { matchesArgument } from "./matcher.js";

export interface TrajectoryRow {
  expected: EvalFunctionCall | null;
  actual: ActualCall | null;
  outcome: "pass" | "fail";
}

interface MatchResult {
  matches: boolean;
  consumed: number;
  rows: TrajectoryRow[];
}

function isFunctionCall(node: ExpectedCallNode): node is EvalFunctionCall {
  return node !== null && typeof node === "object" && "functionName" in node;
}
function isUnordered(node: ExpectedCallNode): node is { unordered: ExpectedCallNode[] } {
  return node !== null && typeof node === "object" && "unordered" in node;
}
function isOrdered(node: ExpectedCallNode): node is { ordered: ExpectedCallNode[] } {
  return node !== null && typeof node === "object" && "ordered" in node;
}

export function functionCallOutcome(expected: EvalFunctionCall, actual: ActualCall): "pass" | "fail" {
  if (expected.functionName !== actual.name) return "fail";
  if (expected.arguments != null && !matchesArgument(expected.arguments, actual.args)) return "fail";
  if (expected.result !== undefined && !matchesArgument(expected.result, actual.result)) return "fail";
  return "pass";
}

function countRequired(nodes: ExpectedCallNode[]): number {
  return nodes.reduce((n, node) => {
    if (isUnordered(node)) return n + countRequired(node.unordered);
    if (isOrdered(node)) return n + countRequired(node.ordered);
    if (isFunctionCall(node) && node.optional) return n;
    return n + 1;
  }, 0);
}

function matchSimpleUnordered(nodes: EvalFunctionCall[], executions: ActualCall[], start: number): MatchResult {
  const poolSize = Math.max(0, Math.min(nodes.length, executions.length - start));
  const adjacency = nodes.map((expected) => {
    const matches: number[] = [];
    for (let j = 0; j < poolSize; j++) if (functionCallOutcome(expected, executions[start + j]) === "pass") matches.push(j);
    return matches;
  });
  const executionToExpected: number[] = Array(poolSize).fill(-1);
  const augment = (expectedIndex: number, visited: boolean[]): boolean => {
    for (const executionIndex of adjacency[expectedIndex]) {
      if (visited[executionIndex]) continue;
      visited[executionIndex] = true;
      const previous = executionToExpected[executionIndex];
      if (previous < 0 || augment(previous, visited)) {
        executionToExpected[executionIndex] = expectedIndex;
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < nodes.length; i++) augment(i, Array(poolSize).fill(false));

  const matchedExpected = new Set(executionToExpected.filter((i) => i !== -1));
  let required = 0;
  let requiredMatched = 0;
  nodes.forEach((node, i) => {
    if (node.optional) return;
    required++;
    if (matchedExpected.has(i)) requiredMatched++;
  });
  const allMatched = requiredMatched === required && poolSize === matchedExpected.size;
  const unmatchedRequired = nodes.filter((node, i) => !matchedExpected.has(i) && node.optional !== true);

  const rows: TrajectoryRow[] = [];
  for (let j = 0; j < poolSize; j++) {
    const expectedIndex = executionToExpected[j];
    const actual = executions[start + j];
    if (expectedIndex !== -1) rows.push({ expected: nodes[expectedIndex], actual, outcome: "pass" });
    else rows.push({ expected: unmatchedRequired.shift() ?? null, actual, outcome: "fail" });
  }
  for (const expected of unmatchedRequired) rows.push({ expected, actual: null, outcome: "fail" });
  return { matches: allMatched, consumed: nodes.length, rows };
}

interface NestedBest {
  passes: number;
  matches: boolean;
  consumed: number;
  rows: TrajectoryRow[];
}

/**
 * The CLI enumerates every ordering of the group's entries and keeps the
 * first one with the most passing rows. Enumerating orderings is factorial,
 * so this memoises on (set of entries already placed, actual calls consumed
 * so far): the best completion from that state does not depend on the order
 * the placed entries were tried in. Iterating entries in index order and
 * only replacing a candidate on a strictly higher pass count keeps the CLI's
 * tie-break, the lexicographically first optimal ordering.
 */
function matchNestedUnordered(nodes: ExpectedCallNode[], executions: ActualCall[], start: number, fallbackConsumed: number): MatchResult {
  const n = nodes.length;
  if (n > 15) throw new Error(`Unordered group too large (${n} nodes). Max length is 15.`);
  const nodeCache = new Map<string, MatchResult>();
  const getMatch = (nodeIndex: number, execIndex: number): MatchResult => {
    const key = `${nodeIndex}:${execIndex}`;
    let r = nodeCache.get(key);
    if (!r) {
      r = matchNode(nodes[nodeIndex], executions, execIndex);
      nodeCache.set(key, r);
    }
    return r;
  };
  const stateCache = new Map<string, NestedBest>();
  const full = (1 << n) - 1;
  const solve = (placed: number, consumed: number): NestedBest => {
    if (placed === full) return { passes: 0, matches: true, consumed: 0, rows: [] };
    const key = `${placed}:${consumed}`;
    const cached = stateCache.get(key);
    if (cached) return cached;
    let best: NestedBest | undefined;
    for (let i = 0; i < n; i++) {
      if (placed & (1 << i)) continue;
      const r = getMatch(i, start + consumed);
      const rest = solve(placed | (1 << i), consumed + r.consumed);
      const passes = r.rows.filter((row) => row.outcome === "pass").length + rest.passes;
      if (!best || passes > best.passes) {
        best = { passes, matches: r.matches && rest.matches, consumed: r.consumed + rest.consumed, rows: [...r.rows, ...rest.rows] };
      }
    }
    stateCache.set(key, best!);
    return best!;
  };
  const best = n ? solve(0, 0) : undefined;
  return best ? { matches: best.matches, consumed: best.consumed, rows: best.rows } : { matches: true, consumed: fallbackConsumed, rows: [] };
}

function matchUnordered(nodes: ExpectedCallNode[], executions: ActualCall[], start: number): MatchResult {
  if (!nodes.some((node) => isUnordered(node) || isOrdered(node))) return matchSimpleUnordered(nodes as EvalFunctionCall[], executions, start);
  return matchNestedUnordered(nodes, executions, start, countRequired(nodes));
}

function matchNode(node: ExpectedCallNode, executions: ActualCall[], start: number): MatchResult {
  if (isUnordered(node)) return matchUnordered(node.unordered, executions, start);
  if (isOrdered(node)) return matchSequence(node.ordered, executions, start);
  if (isFunctionCall(node)) {
    if (start >= executions.length) {
      if (node.optional) return { matches: true, consumed: 0, rows: [] };
      return { matches: false, consumed: 1, rows: [{ expected: node, actual: null, outcome: "fail" }] };
    }
    const actual = executions[start];
    const outcome = functionCallOutcome(node, actual);
    if (node.optional && outcome === "fail") return { matches: true, consumed: 0, rows: [] };
    return { matches: outcome === "pass", consumed: 1, rows: [{ expected: node, actual, outcome }] };
  }
  return { matches: false, consumed: 0, rows: [] };
}

function matchSequence(nodes: ExpectedCallNode[], executions: ActualCall[], start: number): MatchResult {
  let cursor = start;
  let all = true;
  const rows: TrajectoryRow[] = [];
  for (const node of nodes) {
    const r = matchNode(node, executions, cursor);
    if (!r.matches) all = false;
    cursor += r.consumed;
    rows.push(...r.rows);
  }
  return { matches: all, consumed: cursor - start, rows };
}

/**
 * Match an expectation tree the way the `webmcp-evals` CLI does and return
 * one row per expected or actual call. The case passes when no row failed.
 */
export function evaluateTrajectory(expected: ExpectedCallNode[] | null | undefined, executions: ActualCall[]): TrajectoryRow[] {
  if (!expected || expected.length === 0) {
    if (executions.length === 0) return expected === null ? [{ expected: null, actual: null, outcome: "pass" }] : [];
    return executions.map((actual) => ({ expected: null, actual, outcome: "fail" }));
  }
  const { rows, consumed } = matchSequence(expected, executions, 0);
  return [...rows, ...executions.slice(consumed).map((actual): TrajectoryRow => ({ expected: null, actual, outcome: "fail" }))];
}

export function describeTrajectoryRow(row: TrajectoryRow): string {
  const call = (c: ActualCall) => `${c.name}(${JSON.stringify(c.args)})`;
  const want = (e: EvalFunctionCall) => (e.arguments ? `${e.functionName}(${JSON.stringify(e.arguments)})` : `${e.functionName}(…)`);
  if (row.expected && !row.actual) return `missing call ${want(row.expected)}`;
  if (!row.expected && row.actual) return `unexpected call ${call(row.actual)}`;
  if (row.expected && row.actual) return `${call(row.actual)} does not satisfy ${want(row.expected)}`;
  return "no calls expected or made";
}
