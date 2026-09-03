import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileCalls } from "../src/reconcile.js";

const calls = [
  { name: "search", args: { query: "shirt" } },
  { name: "get_details", args: { id: 7 } },
  { name: "add_to_cart", args: { id: 7, qty: 2 } },
];

test("ordered subsequence with subset args", () => {
  const r = reconcileCalls([{ functionName: "search" }, { functionName: "add_to_cart", arguments: { qty: { $gte: 1 } } }], calls);
  assert.equal(r.ok, true, r.problems.join("; "));
  assert.deepEqual(r.consumed, [0, 2]);
});

test("order violations fail", () => {
  const r = reconcileCalls([{ functionName: "add_to_cart" }, { functionName: "search" }], calls);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /missing call search/);
});

test("unordered groups", () => {
  const r = reconcileCalls([{ unordered: [{ functionName: "get_details" }, { functionName: "search" }] }, { functionName: "add_to_cart" }], calls);
  assert.equal(r.ok, true, r.problems.join("; "));
});

test("optional calls may be absent", () => {
  const r = reconcileCalls([{ functionName: "search" }, { functionName: "get_current_results", optional: true }, { functionName: "add_to_cart" }], calls);
  assert.equal(r.ok, true);
});

test("strict mode rejects extras", () => {
  const r = reconcileCalls([{ functionName: "search" }, { functionName: "add_to_cart" }], calls, { strict: true });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /unexpected call get_details/);
});

test("null expectation accepts anything", () => {
  assert.equal(reconcileCalls(null, calls).ok, true);
  assert.equal(reconcileCalls(null, [], { strict: true }).ok, true);
});

test("result expectations", () => {
  const r = reconcileCalls([{ functionName: "search", result: { total: { $gte: 1 } } }], [{ name: "search", args: {}, result: { total: 3 } }]);
  assert.equal(r.ok, true);
  const bad = reconcileCalls([{ functionName: "search", result: { total: { $gte: 5 } } }], [{ name: "search", args: {}, result: { total: 3 } }]);
  assert.equal(bad.ok, false);
});
