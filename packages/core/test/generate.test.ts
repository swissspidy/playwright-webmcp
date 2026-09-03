import { test } from "node:test";
import assert from "node:assert/strict";
import { generateArguments } from "../src/generate.js";
import { judgeRuns } from "../src/smoke.js";
import { diffContracts, toContract } from "../src/contract.js";

const schema = {
  type: "object",
  properties: {
    query: { type: "string", description: "q" },
    quantity: { type: "number", minimum: 1, maximum: 10 },
    color: { type: "string", enum: ["red", "blue"] },
    email: { type: "string", format: "email" },
  },
  required: ["query"],
};

test("generateArguments covers minimal, full, boundary and invalid cases", () => {
  const cases = generateArguments(schema);
  const kinds = cases.map((c) => c.kind);
  assert.deepEqual(cases[0], { kind: "valid-minimal", label: "required parameters only", args: { query: "example" } });
  assert.equal(cases[1].kind, "valid-full");
  assert.deepEqual(cases[1].args, { query: "example", quantity: 1, color: "red", email: "user@example.com" });
  assert.ok(cases.some((c) => c.label === "quantity at minimum" && c.args.quantity === 1));
  assert.ok(cases.some((c) => c.label === "quantity at maximum" && c.args.quantity === 10));
  assert.ok(cases.some((c) => c.label === 'color = "blue"'));
  assert.ok(cases.some((c) => c.kind === "invalid" && c.label === "missing required query" && !("query" in c.args)));
  assert.ok(cases.some((c) => c.kind === "invalid" && c.label === "query has wrong type" && c.args.query === 12345));
  assert.ok(kinds.filter((k) => k === "invalid").length <= 6);
});

test("generateArguments handles empty schemas", () => {
  assert.deepEqual(generateArguments(null), [{ kind: "valid-minimal", label: "no parameters", args: {} }]);
});

test("judgeRuns produces runtime findings", () => {
  const base = { tool: "t", kind: "valid-minimal" as const, label: "x", args: {}, ok: true, durationMs: 10 };
  const report = judgeRuns(
    [
      { ...base, result: { a: 1 } },
      { ...base, result: { a: null, b: [null] } },
      { ...base, result: undefined },
      { ...base, ok: false, error: "boom" },
      { ...base, result: "x".repeat(20_000) },
      { ...base, durationMs: 9000, result: {} },
      { ...base, kind: "invalid", ok: true, result: {} },
      { ...base, kind: "invalid", ok: false, error: "rejected" },
      { ...base, result: '{"json":true}' },
    ],
    {},
  );
  const ids = report.findings.map((f) => f.ruleId);
  assert.deepEqual(ids.sort(), [
    "result-accepts-invalid-input",
    "result-contains-null",
    "result-error-on-valid-input",
    "result-slow",
    "result-string-json",
    "result-too-large",
    "result-undefined",
  ]);
  assert.equal(report.counts.error, 2);
});

test("diffContracts reports meaningful changes", () => {
  const snap = (desc: string, schema: Record<string, unknown>) => ({
    url: "u",
    capturedAt: "",
    frames: [],
    tools: [{ name: "search", description: desc, inputSchema: schema, origin: "o", frame: 0, source: "imperative" as const }],
  });
  const before = toContract(snap("Search things", { type: "object", properties: { q: { type: "string" } }, required: ["q"] }));
  const after = toContract(snap("Search products", { type: "object", properties: { q: { type: "number" }, page: { type: "number" } } }));
  const changes = diffContracts(before, after);
  assert.deepEqual(
    changes.map((c) => c.detail),
    ['"Search things" -> "Search products"', 'parameter "page" added', 'parameter "q" type "string" -> "number"', 'parameter "q" is no longer required'],
  );
  assert.deepEqual(diffContracts(before, before), []);
});
