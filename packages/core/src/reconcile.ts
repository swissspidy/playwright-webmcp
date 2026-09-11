import type { EvalFunctionCall, ExpectedCallNode } from "./evals-types.js";
import { matchesArgument } from "./matcher.js";
import { evaluateTrajectory, describeTrajectoryRow } from "./trajectory.js";

export interface ActualCall {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
}

export type ReconcileMode = "lenient" | "evals";

export interface ReconcileOptions {
  /**
   * "lenient" (default): expected calls may be satisfied by any later actual
   * call, so the expectation is a subsequence of what happened.
   * "evals": the exact algorithm of the `webmcp-evals` CLI. Calls are matched
   * positionally and every unexplained actual call fails the case. Use this
   * when the expectation will also be run by that CLI.
   */
  mode?: ReconcileMode;
  /** Lenient mode only: actual calls not consumed by any expectation fail the match. Default false. Always on in "evals" mode. */
  strict?: boolean;
}

export interface ReconcileResult {
  ok: boolean;
  /** Human readable reasons, empty when ok. */
  problems: string[];
  /** Indexes of actual calls that were matched. */
  consumed: number[];
}

function isFunctionCall(node: ExpectedCallNode): node is EvalFunctionCall {
  return typeof (node as EvalFunctionCall).functionName === "string";
}

function callMatches(expected: EvalFunctionCall, actual: ActualCall): boolean {
  if (expected.functionName !== actual.name) return false;
  if (expected.arguments !== undefined && expected.arguments !== null) {
    if (!matchesArgument(expected.arguments, actual.args)) return false;
  }
  if (expected.result !== undefined) {
    if (!matchesArgument(expected.result, actual.result)) return false;
  }
  return true;
}

function describe(node: EvalFunctionCall): string {
  return node.arguments ? `${node.functionName}(${JSON.stringify(node.arguments)})` : `${node.functionName}(…)`;
}

/**
 * Match an expectation tree against the actual call sequence.
 *
 * Semantics (documented in the README):
 *  - the top level array is ordered: each node must be satisfied by calls that
 *    occur after the calls used by the previous node
 *  - `{ ordered: [...] }` behaves like a nested top level array
 *  - `{ unordered: [...] }` lets its children match in any order, but all of
 *    them must be satisfied within the same window
 *  - `optional: true` on a function call means it may be absent; when present
 *    it must match
 *  - extra actual calls are tolerated unless `strict` is set
 *
 * Pass `mode: "evals"` for the positional semantics of the `webmcp-evals` CLI
 * (see ./trajectory.ts).
 */
export function reconcileCalls(expected: ExpectedCallNode[] | null | undefined, actual: ActualCall[], options: ReconcileOptions = {}): ReconcileResult {
  if (options.mode === "evals") {
    // Copy each call so that the same object appearing twice in `actual` still maps back to its own index.
    const positioned = actual.map((c) => ({ ...c }));
    const rows = evaluateTrajectory(expected, positioned);
    const failed = rows.filter((r) => r.outcome === "fail");
    const consumedIdx = rows.filter((r) => r.outcome === "pass" && r.actual).map((r) => positioned.indexOf(r.actual!));
    return { ok: failed.length === 0, problems: Array.from(new Set(failed.map(describeTrajectoryRow))), consumed: consumedIdx.sort((a, b) => a - b) };
  }
  const consumed = new Set<number>();
  const problems: string[] = [];

  // Returns the index after the last consumed call, or -1 on failure.
  function matchOrdered(nodes: ExpectedCallNode[], from: number): number {
    let cursor = from;
    for (const node of nodes) {
      const next = matchNode(node, cursor);
      if (next === -1) return -1;
      cursor = next;
    }
    return cursor;
  }

  function matchUnordered(nodes: ExpectedCallNode[], from: number): number {
    // Greedy: try each remaining node against the earliest possible position.
    const remaining = [...nodes];
    let maxCursor = from;
    while (remaining.length) {
      let progressed = false;
      for (let i = 0; i < remaining.length; i++) {
        const next = matchNode(remaining[i], from, /* probe */ true);
        if (next !== -1) {
          const committed = matchNode(remaining[i], from);
          maxCursor = Math.max(maxCursor, committed);
          remaining.splice(i, 1);
          progressed = true;
          break;
        }
      }
      if (!progressed) {
        // Anything left that is not optional is a failure.
        const hard = remaining.filter((n) => !(isFunctionCall(n) && n.optional));
        if (hard.length) {
          for (const n of hard) {
            if (isFunctionCall(n)) problems.push(`missing call ${describe(n)}`);
            else problems.push(`unsatisfied ${"ordered" in n ? "ordered" : "unordered"} group`);
          }
          return -1;
        }
        return maxCursor;
      }
    }
    return maxCursor;
  }

  function matchNode(node: ExpectedCallNode, from: number, probe = false): number {
    if (isFunctionCall(node)) {
      for (let i = from; i < actual.length; i++) {
        if (consumed.has(i)) continue;
        if (callMatches(node, actual[i])) {
          if (!probe) consumed.add(i);
          return i + 1;
        }
      }
      if (node.optional) return from;
      if (!probe) problems.push(`missing call ${describe(node)}`);
      return -1;
    }
    if ("ordered" in node) {
      if (probe) {
        const snapshot = new Set(consumed);
        const r = matchOrdered(node.ordered, from);
        consumed.clear();
        for (const c of snapshot) consumed.add(c);
        return r;
      }
      return matchOrdered(node.ordered, from);
    }
    if (probe) {
      const snapshot = new Set(consumed);
      const r = matchUnordered(node.unordered, from);
      consumed.clear();
      for (const c of snapshot) consumed.add(c);
      return r;
    }
    return matchUnordered(node.unordered, from);
  }

  const end = matchOrdered(expected ?? [], 0);
  let ok = end !== -1;

  if (ok && options.strict) {
    const extras = actual.map((c, i) => (consumed.has(i) ? null : c)).filter((c): c is ActualCall => c !== null);
    if (extras.length) {
      ok = false;
      for (const e of extras) problems.push(`unexpected call ${e.name}(${JSON.stringify(e.args)})`);
    }
  }

  return { ok, problems: Array.from(new Set(problems)), consumed: [...consumed].sort((a, b) => a - b) };
}
