import { test } from "node:test";
import assert from "node:assert/strict";
import { lint } from "../src/lint.js";
import type { PageSnapshot } from "../src/types.js";

function snap(tools: Partial<PageSnapshot["tools"][number]>[], frames?: PageSnapshot["frames"]): PageSnapshot {
  return {
    url: "https://example.test/",
    capturedAt: new Date(0).toISOString(),
    frames: frames ?? [{ url: "https://example.test/", origin: "https://example.test", isTop: true, api: "shim" }],
    tools: tools.map((t) => ({
      name: "tool",
      description: "A perfectly adequate description of what this does.",
      inputSchema: { type: "object", properties: {} },
      origin: "https://example.test",
      frame: 0,
      source: "imperative",
      ...t,
    })),
  };
}

const ids = (r: ReturnType<typeof lint>) => r.findings.map((f) => f.ruleId);

test("clean tool produces no findings beyond info", () => {
  const r = lint(snap([{ name: "search" }]));
  assert.equal(r.counts.error, 0);
  assert.equal(r.counts.warning, 0);
});

test("name, description and schema rules", () => {
  const r = lint(
    snap([
      { name: "bad name!", description: "" },
      { name: "short", description: "Too short" },
      { name: "nulls", inputSchema: { type: "object", properties: { a: { type: "string", default: null } }, required: ["b"] } },
    ]),
  );
  const found = ids(r);
  assert.ok(found.includes("tool-name-valid"));
  assert.ok(found.includes("description-missing"));
  assert.ok(found.includes("description-length"));
  assert.ok(found.includes("schema-no-null-literals"));
  assert.ok(found.includes("schema-shape"));
});

test("page level rules", () => {
  const r = lint(
    snap([
      { name: "search", description: "Search the product catalogue by keyword and return matches." },
      { name: "search", description: "Search the product catalogue by keyword and return matching items." },
    ]),
  );
  const found = ids(r);
  assert.ok(found.includes("duplicate-tool-name"));
  assert.ok(found.includes("similar-descriptions"));
});

test("declarative rules", () => {
  const r = lint(
    snap([
      {
        name: "login",
        source: "declarative",
        inputSchema: { type: "object", properties: { user: { type: "string" }, password: { type: "string" } } },
        declarative: {
          formLocator: "form#login",
          autosubmit: true,
          hasDescription: false,
          fields: [
            { name: "user", type: "text", required: true, hasLabel: false },
            { name: "password", type: "password", required: true, hasLabel: true },
          ],
        },
      },
    ]),
  );
  const found = ids(r);
  assert.ok(found.includes("declarative-description"));
  assert.ok(found.includes("declarative-field-description"));
  assert.ok(found.includes("declarative-autosubmit-sensitive"));
  assert.ok(found.includes("sensitive-params"));
});

test("rule configuration: disable, re-severity, options", () => {
  const s = snap([{ name: "x", description: "Short desc here" }]);
  assert.ok(ids(lint(s)).includes("description-length"));
  assert.ok(!ids(lint(s, { rules: { "description-length": false } })).includes("description-length"));
  assert.ok(!ids(lint(s, { rules: { "description-length": { min: 5 } } })).includes("description-length"));
  const r = lint(s, { rules: { "description-length": "error" } });
  assert.equal(r.findings.find((f) => f.ruleId === "description-length")?.severity, "error");
});
