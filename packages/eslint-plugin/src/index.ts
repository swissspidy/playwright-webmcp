/**
 * eslint-plugin-webmcp: the tool-scoped rules of `webmcp-lint`, run
 * statically against `registerTool()` and `provideContext()` literals.
 *
 *   // eslint.config.js
 *   import webmcp from "eslint-plugin-webmcp";
 *   export default [webmcp.configs.recommended];
 *
 * Page-level rules (duplicate names, similar descriptions, tool count,
 * cross-origin frames) and declarative `<form toolname>` rules need a live
 * page; run those with `playwright-webmcp` or `webmcp-audit`.
 */
import { createRequire } from "node:module";
import type { ESLint, Linter } from "eslint";
import { builtinRules, type Rule as LintRule } from "webmcp-lint";
import { createRule } from "./rule.js";

export { createRule } from "./rule.js";
export { toolsFromCall, staticValue, DYNAMIC, type ExtractedTool } from "./extract.js";

function packageMeta(): { name: string; version: string } {
  const require = createRequire(import.meta.url);
  // dist/index.js in the published package; dist-test/src/index.js under test.
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      const pkg = require(candidate) as { name?: string; version?: string };
      if (pkg.name === "eslint-plugin-webmcp" && pkg.version) return { name: pkg.name, version: pkg.version };
    } catch {
      /* try the next location */
    }
  }
  return { name: "eslint-plugin-webmcp", version: "0.0.0" };
}

const { name, version } = packageMeta();

/** The webmcp-lint rules this plugin exposes: tool-scoped, and about imperative definitions. */
export const staticRules: LintRule[] = builtinRules.filter((r) => r.scope === "tool" && !r.id.startsWith("declarative-"));

const rules: Record<string, ReturnType<typeof createRule>> = Object.fromEntries(staticRules.map((r) => [r.id, createRule(r)]));

const level = (r: LintRule): Linter.RuleSeverity => (r.severity === "error" ? "error" : "warn");

const plugin = {
  meta: { name, version },
  rules,
  configs: {} as { recommended: Linter.Config; all: Linter.Config },
} satisfies ESLint.Plugin;

/** Every rule at the severity webmcp-lint gives it: errors as errors, warnings as warnings. */
plugin.configs.recommended = {
  name: "webmcp/recommended",
  plugins: { webmcp: plugin },
  rules: Object.fromEntries(staticRules.map((r) => [`webmcp/${r.id}`, level(r)])),
};

/** Every rule as an error. */
plugin.configs.all = {
  name: "webmcp/all",
  plugins: { webmcp: plugin },
  rules: Object.fromEntries(staticRules.map((r) => [`webmcp/${r.id}`, "error" as const])),
};

export default plugin;
