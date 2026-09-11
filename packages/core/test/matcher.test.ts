import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesArgument, explainMismatch } from "../src/matcher.js";

test("primitives and subset objects", () => {
  assert.equal(matchesArgument({ a: 1 }, { a: 1, b: 2 }), true);
  assert.equal(matchesArgument({ a: 1, b: 2 }, { a: 1 }), false);
  assert.equal(matchesArgument("x", "x"), true);
  assert.equal(matchesArgument(1, "1"), false);
});

test("arrays are positional and length strict", () => {
  assert.equal(matchesArgument([1, 2], [1, 2]), true);
  assert.equal(matchesArgument([1], [1, 2]), false);
  assert.equal(matchesArgument([{ id: 1 }], [{ id: 1, x: 2 }]), true);
});

test("constraint operators", () => {
  assert.equal(matchesArgument({ $pattern: "^red" }, "red shirt"), true);
  assert.equal(matchesArgument({ $pattern: "(?i)^red" }, "RED shirt"), true);
  assert.equal(matchesArgument({ $contains: "shirt" }, "red shirt"), true);
  assert.equal(matchesArgument({ $gte: 1, $lte: 3 }, 2), true);
  assert.equal(matchesArgument({ $gt: 2 }, 2), false);
  assert.equal(matchesArgument({ $type: "array" }, []), true);
  assert.equal(matchesArgument({ $type: "null" }, null), true);
  assert.equal(matchesArgument({ $any: true }, 0), true);
  assert.equal(matchesArgument({ $any: true }, undefined), false);
  assert.equal(matchesArgument({ $gt: 1 }, "2"), false);
});

test("nested constraints", () => {
  assert.equal(matchesArgument({ item: { qty: { $gte: 2 } } }, { item: { qty: 2, sku: "a" } }), true);
  assert.deepEqual(explainMismatch({ item: { qty: { $gte: 5 } } }, { item: { qty: 2 } }), ['item.qty: expected {"$gte":5}, got 2']);
});
