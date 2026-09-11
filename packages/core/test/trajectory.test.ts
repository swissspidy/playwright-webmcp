import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileCalls } from "../src/reconcile.js";
import { evaluateTrajectory } from "../src/trajectory.js";

const calls = [
  { name: "search", args: { query: "shirt" } },
  { name: "get_details", args: { id: 7 } },
  { name: "add_to_cart", args: { id: 7, qty: 2 } },
];

test("evals mode is positional: skipping a call fails where lenient mode passes", () => {
  const expected = [{ functionName: "search" }, { functionName: "add_to_cart" }];
  assert.equal(reconcileCalls(expected, calls).ok, true);
  const strict = reconcileCalls(expected, calls, { mode: "evals" });
  assert.equal(strict.ok, false);
  assert.ok(
    strict.problems.some((p) => /get_details.*does not satisfy add_to_cart/.test(p)),
    strict.problems.join("; "),
  );
});

test("evals mode fails on unexplained extra calls", () => {
  const r = reconcileCalls([{ functionName: "search" }, { functionName: "get_details" }], calls, { mode: "evals" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ['unexpected call add_to_cart({"id":7,"qty":2})']);
  assert.deepEqual(r.consumed, [0, 1]);
});

test("evals mode: optional calls yield their position", () => {
  const r = reconcileCalls(
    [{ functionName: "search" }, { functionName: "get_current_results", optional: true }, { functionName: "get_details" }, { functionName: "add_to_cart" }],
    calls,
    { mode: "evals" },
  );
  assert.equal(r.ok, true, r.problems.join("; "));
});

test("evals mode: unordered groups match a pool of the group's size", () => {
  const ok = reconcileCalls([{ unordered: [{ functionName: "get_details" }, { functionName: "search" }] }, { functionName: "add_to_cart" }], calls, {
    mode: "evals",
  });
  assert.equal(ok.ok, true, ok.problems.join("; "));
  const bad = reconcileCalls([{ unordered: [{ functionName: "add_to_cart" }, { functionName: "search" }] }, { functionName: "get_details" }], calls, {
    mode: "evals",
  });
  assert.equal(bad.ok, false);
});

test("evals mode: null expectation passes only when nothing was called", () => {
  assert.equal(reconcileCalls(null, [], { mode: "evals" }).ok, true);
  assert.equal(reconcileCalls(null, calls, { mode: "evals" }).ok, false);
  assert.equal(reconcileCalls([], [], { mode: "evals" }).ok, true);
});

test("evaluateTrajectory returns one row per call, like the CLI", () => {
  const rows = evaluateTrajectory([{ functionName: "search", arguments: { query: { $contains: "shirt" } } }], calls);
  assert.deepEqual(
    rows.map((r) => [r.expected?.functionName ?? null, r.actual?.name ?? null, r.outcome]),
    [
      ["search", "search", "pass"],
      [null, "get_details", "fail"],
      [null, "add_to_cart", "fail"],
    ],
  );
});

test("evals mode: nested unordered groups at the 15-entry limit stay fast", () => {
  const nodes = Array.from({ length: 14 }, (_, i) => ({ functionName: `t${i}` }));
  const expected = [{ unordered: [...nodes, { ordered: [{ functionName: "a" }, { functionName: "b" }] }] }];
  const actual = [{ name: "a", args: {} }, { name: "b", args: {} }, ...nodes.map((n) => ({ name: n.functionName, args: {} })).reverse()];
  const started = Date.now();
  const r = reconcileCalls(expected, actual, { mode: "evals" });
  assert.equal(r.ok, true, r.problems.join("; "));
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  // A partially matching trajectory still terminates and reports the shortfall.
  const bad = reconcileCalls(expected, actual.slice(0, 10), { mode: "evals" });
  assert.equal(bad.ok, false);
});

test("evals mode: the same call object at two positions maps to both indexes", () => {
  const call = { name: "search", args: {} };
  const r = reconcileCalls([{ functionName: "search" }, { functionName: "search" }], [call, call], { mode: "evals" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.consumed, [0, 1]);
});
