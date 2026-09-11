import { test } from "node:test";
import assert from "node:assert/strict";
import { toEvalCase, toToolsSchema } from "../src/evals.js";
import type { RecordedCall } from "../src/types.js";

const calls: RecordedCall[] = [
  { name: "search_products", args: { query: "red" }, result: { products: [] }, startedAt: 1, durationMs: 1, via: "agent" },
  { name: "add_to_cart", args: { productId: 1, quantity: 2 }, startedAt: 2, durationMs: 1, via: "agent" },
];

test("toEvalCase drafts a case from a recording", () => {
  assert.deepEqual(toEvalCase(calls, { name: "add two shirts", prompt: "Add two red shirts to my cart" }), {
    name: "add two shirts",
    messages: [{ role: "user", type: "message", content: "Add two red shirts to my cart" }],
    expectedCall: [
      { functionName: "search_products", arguments: { query: "red" } },
      { functionName: "add_to_cart", arguments: { productId: 1, quantity: 2 } },
    ],
  });
});

test("argument modes and unordered groups", () => {
  const typed = toEvalCase(calls, { prompt: "p", argumentsMode: "types", unordered: true });
  assert.deepEqual(typed.expectedCall, [
    {
      unordered: [
        { functionName: "search_products", arguments: { query: { $type: "string" } } },
        { functionName: "add_to_cart", arguments: { productId: { $type: "number" }, quantity: { $type: "number" } } },
      ],
    },
  ]);
  assert.deepEqual(toEvalCase(calls.slice(0, 1), { prompt: "p", argumentsMode: "any" }).expectedCall, [{ functionName: "search_products", arguments: null }]);
  assert.deepEqual(toEvalCase(calls.slice(0, 1), { prompt: "p", includeResults: true }).expectedCall, [
    { functionName: "search_products", arguments: { query: "red" }, result: { products: [] } },
  ]);
});

test("toToolsSchema dedupes by name and matches the CLI's tools.json shape", () => {
  const tools = [
    { name: "a", description: "A", inputSchema: { type: "object" }, origin: "o", frame: 0, source: "imperative" as const },
    { name: "a", description: "dup", inputSchema: null, origin: "o", frame: 1, source: "imperative" as const },
  ];
  assert.deepEqual(toToolsSchema({ tools }), { tools: [{ name: "a", description: "A", inputSchema: { type: "object" }, outputSchema: null }] });
});
