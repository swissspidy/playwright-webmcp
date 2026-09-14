import { test } from "node:test";
import assert from "node:assert/strict";
import { lintTools, snapshotFromFrames, snapshotFromTools, toSnapshot } from "../src/from-tools.js";
import { lint } from "../src/lint.js";
import { builtinRules } from "../src/rules/index.js";
import type { FrameCollectResult } from "../src/collect.js";

const good = {
  name: "search_products",
  title: "Search products",
  description: "Search the product catalogue by keyword and return matching products.",
  inputSchema: { type: "object", properties: { query: { type: "string", description: "Keyword to search for" } }, required: ["query"] },
  annotations: { readOnlyHint: true },
  execute: () => ({}),
};

test("snapshotFromTools builds a single-frame snapshot from definitions", () => {
  const s = snapshotFromTools([good, { name: "bad name!", exposedTo: ["http://partner.example"] }], { url: "https://shop.test/" });
  assert.equal(s.frames.length, 1);
  assert.equal(s.frames[0].origin, "https://shop.test");
  assert.equal(s.tools[0].title, "Search products");
  assert.deepEqual(s.tools[0].annotations, { readOnlyHint: true });
  assert.equal(s.tools[0].frame, 0);
  assert.equal(s.tools[1].description, "");
  assert.equal(s.tools[1].inputSchema, null);
  assert.deepEqual(s.tools[1].exposedTo, ["http://partner.example"]);
  assert.ok(!("execute" in s.tools[0]));
});

test("snapshotFromTools accepts the webmcp-evals tools file shape", () => {
  const s = snapshotFromTools({ tools: [{ name: "a", description: "Does a thing for the user in detail.", inputSchema: null, outputSchema: null }] });
  assert.equal(s.url, "about:blank");
  assert.equal(s.tools[0].name, "a");
});

test("lintTools runs the same rules as lint()", () => {
  const defs = [good, { name: "bad name!", description: "" }];
  const viaHelper = lintTools(defs, { url: "https://shop.test/" });
  const viaLint = lint(snapshotFromTools(defs, { url: "https://shop.test/" }));
  assert.deepEqual(viaHelper.findings, viaLint.findings);
  assert.ok(viaHelper.findings.some((f) => f.ruleId === "tool-name-valid"));
  assert.ok(viaHelper.findings.some((f) => f.ruleId === "description-missing"));
  assert.ok(viaHelper.findings.some((f) => f.ruleId === "exposed-to-secure-origins") === false);
});

test("lintTools passes a snapshot through and rejects other shapes", () => {
  const snap = snapshotFromTools([good]);
  assert.equal(toSnapshot(snap), snap);
  assert.throws(() => lintTools({} as never), TypeError);
  assert.throws(() => lintTools("nope" as never), TypeError);
});

test("every built-in rule declares a scope and scope: tool skips page rules", () => {
  for (const rule of builtinRules) assert.ok(rule.scope === "tool" || rule.scope === "page", `${rule.id} has no scope`);
  const dup = { ...good };
  const all = lintTools([dup, dup]);
  assert.ok(all.rulesRun.includes("duplicate-tool-name"));
  assert.ok(all.findings.some((f) => f.ruleId === "duplicate-tool-name"));
  const toolOnly = lintTools([dup, dup], { scope: "tool" });
  assert.ok(!toolOnly.rulesRun.includes("duplicate-tool-name"));
  assert.ok(!toolOnly.rulesRun.includes("no-tools"));
  assert.ok(toolOnly.rulesRun.includes("tool-name-valid"));
  assert.equal(toolOnly.findings.length, 0);
  const pageOnly = lintTools([], { scope: "page" });
  assert.ok(pageOnly.findings.some((f) => f.ruleId === "no-tools"));
  assert.ok(!pageOnly.rulesRun.includes("tool-name-valid"));
});

test("snapshotFromFrames assembles frames like the Playwright fixture", () => {
  const top: FrameCollectResult = {
    frame: { url: "https://shop.test/", origin: "https://shop.test", isTop: true, api: "native" },
    tools: [
      { name: "search", description: "Search the catalogue for products by keyword.", inputSchema: null, origin: "https://shop.test", source: "imperative" },
    ],
  };
  const partner: FrameCollectResult & { allow?: string | null } = {
    frame: { url: "https://partner.test/widget", origin: "https://partner.test", isTop: false, api: "native" },
    tools: [
      {
        name: "quote",
        description: "Get a shipping quote for the current cart contents.",
        inputSchema: null,
        origin: "https://partner.test",
        source: "imperative",
      },
    ],
    allow: null,
  };
  const s = snapshotFromFrames([top, partner]);
  assert.equal(s.url, "https://shop.test/");
  assert.equal(s.frames[1].crossOriginFromTop, true);
  assert.equal(s.frames[1].allow, null);
  assert.equal(s.tools[1].frame, 1);
  const r = lint(s);
  assert.ok(r.findings.some((f) => f.ruleId === "iframe-allow-tools" && f.frame === 1));
  const allowed = lint(snapshotFromFrames([top, { ...partner, allow: "tools" }]));
  assert.ok(!allowed.findings.some((f) => f.ruleId === "iframe-allow-tools"));
});

test("a malformed inputSchema is kept so schema-shape can report it", () => {
  const snapshot = snapshotFromTools([{ name: "ok_tool", description: "A description that is long enough.", inputSchema: "not a schema" as never }]);
  assert.equal(snapshot.tools[0].inputSchema as unknown, "not a schema");
  const result = lintTools([{ name: "ok_tool", description: "A description that is long enough.", inputSchema: "not a schema" as never }], { scope: "tool" });
  assert.ok(result.findings.some((f) => f.ruleId === "schema-shape" && f.message.includes("not an object")));
});
