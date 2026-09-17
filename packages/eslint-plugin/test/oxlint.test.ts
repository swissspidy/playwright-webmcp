/**
 * Loads the plugin through oxlint's JS plugin runner and checks that the
 * rules report the same findings as under ESLint. Runs the real oxlint
 * binary against a fixture in a temporary directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Under `pnpm test` this file runs from dist-test/test, next to dist-test/src/index.js.
const pluginPath = resolve(here, "../src/index.js");

function runOxlint(files: Record<string, string>, config: object): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "eslint-plugin-webmcp-oxlint-"));
  writeFileSync(join(dir, ".oxlintrc.json"), JSON.stringify(config));
  for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, name), code);
  const bin = resolve(here, "../../node_modules/oxlint/bin/oxlint");
  const result = spawnSync(process.execPath, [bin, "-c", ".oxlintrc.json", "--format", "json", ...Object.keys(files)], { cwd: dir, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function diagnostics(stdout: string): Array<{ rule: string; message: string; line: number; column: number }> {
  const parsed = JSON.parse(stdout) as { diagnostics: Array<{ code: string; message: string; labels: Array<{ span: { line: number; column: number } }> }> };
  return parsed.diagnostics.map((d) => ({ rule: d.code, message: d.message, line: d.labels[0]?.span.line ?? 0, column: d.labels[0]?.span.column ?? 0 }));
}

test("oxlint loads the plugin and reports the tool-scoped rules", () => {
  const { status, stdout, stderr } = runOxlint(
    {
      "shop.js": `const mc = navigator.modelContext;
mc.registerTool({
  name: "add to cart",
  description: "Add.",
  inputSchema: { type: "object", properties: { apiKey: { type: "string", default: null } }, required: ["apiKey"] },
  execute: () => ({}),
});
`,
    },
    {
      jsPlugins: [{ name: "webmcp", specifier: pluginPath }],
      rules: {
        "webmcp/tool-name-valid": "error",
        "webmcp/description-length": "warn",
        "webmcp/param-description-missing": "warn",
        "webmcp/sensitive-params": "warn",
        "webmcp/schema-no-null-literals": "error",
      },
    },
  );
  assert.equal(status, 1, stderr);
  const found = diagnostics(stdout);
  const byRule = new Map(found.map((d) => [d.rule, d]));
  assert.deepEqual([...byRule.keys()].sort(), [
    "webmcp(description-length)",
    "webmcp(param-description-missing)",
    "webmcp(schema-no-null-literals)",
    "webmcp(sensitive-params)",
    "webmcp(tool-name-valid)",
  ]);
  assert.equal(byRule.get("webmcp(tool-name-valid)")?.line, 3);
  assert.equal(byRule.get("webmcp(schema-no-null-literals)")?.column, 83);
  assert.match(byRule.get("webmcp(tool-name-valid)")?.message ?? "", /not a valid WebMCP tool name/);
});

test("oxlint passes settings.webmcp.definitions and rule options through", () => {
  const { status, stdout, stderr } = runOxlint(
    {
      "hooks.js": `import { useWebMCP } from "use-webmcp-tool";
const tool = { name: "search", description: "Short one.", inputSchema: { type: "object", properties: {} } };
export function Tools() {
  useWebMCP(tool);
  defineAgentTool({ name: "bad name", description: "A perfectly long description of what this tool does." });
  return null;
}
`,
    },
    {
      jsPlugins: [{ name: "webmcp", specifier: pluginPath }],
      settings: { webmcp: { definitions: ["defineAgentTool"] } },
      rules: {
        "webmcp/tool-name-valid": "error",
        "webmcp/description-length": ["warn", { min: 5 }],
      },
    },
  );
  assert.equal(status, 1, stderr);
  const found = diagnostics(stdout);
  assert.deepEqual(
    found.map((d) => [d.rule, d.line]),
    [["webmcp(tool-name-valid)", 5]],
  );
});

test("oxlint lints JSX form tools with the declarative rules", () => {
  const { status, stdout, stderr } = runOxlint(
    {
      "Newsletter.jsx": `export function Newsletter() {
  return (
    <form toolname="subscribe_newsletter" toolautosubmit>
      <input name="email" type="email" />
      <input name="password" type="password" aria-label="Password" />
    </form>
  );
}
`,
    },
    {
      jsPlugins: [{ name: "webmcp", specifier: pluginPath }],
      rules: {
        "webmcp/declarative-description": "error",
        "webmcp/declarative-field-description": "warn",
        "webmcp/declarative-autosubmit-sensitive": "error",
      },
    },
  );
  assert.equal(status, 1, stderr);
  assert.deepEqual(
    diagnostics(stdout)
      .map((d) => [d.rule, d.line])
      .sort(),
    [
      ["webmcp(declarative-autosubmit-sensitive)", 3],
      ["webmcp(declarative-description)", 3],
      ["webmcp(declarative-field-description)", 4],
    ],
  );
});

test("oxlint runs the source-only rule, which reads scopes and JSX", () => {
  const { status, stdout, stderr } = runOxlint(
    {
      "shop.jsx": `const mc = navigator.modelContext;
const blurb = \`Search \${siteName} for products.\`;
mc.registerTool({ name: "search", description: blurb, execute: () => ({}) });
export const Form = () => <form toolname="subscribe" tooldescription={\`Join \${listName}.\`} />;
`,
    },
    { jsPlugins: [{ name: "webmcp", specifier: pluginPath }], rules: { "webmcp/no-interpolated-text": "error" } },
  );
  assert.equal(status, 1, stderr);
  const found = diagnostics(stdout);
  assert.deepEqual(
    found.map((d) => d.rule),
    ["webmcp(no-interpolated-text)", "webmcp(no-interpolated-text)"],
  );
  // The binding is followed to the template it holds, as it is under ESLint.
  assert.equal(found[0].line, 2);
  assert.equal(found[1].line, 4);
});
