import { test } from "node:test";
import assert from "node:assert/strict";
import { isReadOnlyTool, toolHints } from "../src/annotations.js";
import { diffContracts, toContract } from "../src/contract.js";
import { renderToolDocs } from "../src/docs.js";

test("toolHints accepts spec hints and CDP spellings", () => {
  assert.deepEqual(toolHints({ readOnlyHint: true, consequentialHint: false, untrustedContentHint: true }), {
    readOnly: true,
    consequential: false,
    untrustedContent: true,
  });
  assert.deepEqual(toolHints({ readOnly: true, consequential: true, untrustedContent: false, autosubmit: true }), {
    readOnly: true,
    consequential: true,
    untrustedContent: false,
    autosubmit: true,
  });
  assert.deepEqual(toolHints({ readOnlyHint: false, readOnly: true }), { readOnly: false });
  assert.deepEqual(toolHints(undefined), {});
  assert.equal(isReadOnlyTool({ annotations: { readOnlyHint: true } }), true);
  assert.equal(isReadOnlyTool({ annotations: { readOnly: "yes" } }), false);
});

test("title is part of the contract and the docs", () => {
  const snap = (title?: string) => ({
    url: "u",
    capturedAt: "",
    frames: [],
    tools: [
      {
        name: "search",
        title,
        description: "Search things",
        inputSchema: null,
        origin: "o",
        frame: 0,
        source: "imperative" as const,
        annotations: { readOnlyHint: true },
      },
    ],
  });
  const before = toContract(snap());
  const after = toContract(snap("Search"));
  assert.deepEqual(
    diffContracts(before, after).map((c) => [c.kind, c.detail]),
    [["title-changed", '"" -> "Search"']],
  );
  const md = renderToolDocs(after);
  assert.match(md, /\*\*Search\*\*/);
  assert.match(md, /read-only/);
});

test("declarative autosubmit becomes an annotation in the contract", () => {
  const snap = {
    url: "u",
    capturedAt: "",
    frames: [],
    tools: [
      {
        name: "subscribe",
        description: "Subscribe",
        inputSchema: null,
        origin: "o",
        frame: 0,
        source: "declarative" as const,
        declarative: { formLocator: "form", autosubmit: true, hasDescription: true, fields: [] },
      },
    ],
  };
  const contract = toContract(snap);
  assert.deepEqual(contract.tools[0].annotations, { autosubmit: true });
  assert.match(renderToolDocs(contract), /auto-submits/);
});
