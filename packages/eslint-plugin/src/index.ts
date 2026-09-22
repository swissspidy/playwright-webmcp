/**
 * @swissspidy/eslint-plugin-webmcp: the tool-scoped rules of `webmcp-lint`,
 * run statically against `registerTool()` literals.
 *
 *   // eslint.config.js
 *   import webmcp from "@swissspidy/eslint-plugin-webmcp";
 *   export default [webmcp.configs.recommended];
 *
 * Page-level rules (duplicate names, similar descriptions, tool count,
 * cross-origin frames) and declarative `<form toolname>` rules need a live
 * page; run those with `playwright-webmcp` or `webmcp-audit`.
 */
import { createRequire } from "node:module";
import type { ESLint, Linter, Rule as ESLintRule } from "eslint";

import { builtinRules, type Rule as LintRule } from "webmcp-lint";
import { noInterpolatedText } from "./interpolation.js";
import { createRule } from "./rule.js";

export { createRule } from "./rule.js";
export { noInterpolatedText, interpolationOf } from "./interpolation.js";
export { toolsFromCall, toolObjectsFromCall, staticValue, DYNAMIC, type ExtractedTool, type ToolObject, type Resolver } from "./extract.js";
export { formTool, type ExtractedForm } from "./jsx.js";
export { DEFAULT_DEFINITION_SITES, definitionSites, type DefinitionSite, type DefinitionSiteSetting, type WebMCPSettings } from "./settings.js";

function packageMeta(): { name: string; version: string } {
  const require = createRequire(import.meta.url);
  // dist/index.js in the published package; dist-test/src/index.js under test.
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      const pkg = require(candidate) as { name?: string; version?: string };
      if (pkg.name === "@swissspidy/eslint-plugin-webmcp" && pkg.version) return { name: pkg.name, version: pkg.version };
    } catch {
      /* try the next location */
    }
  }
  return { name: "@swissspidy/eslint-plugin-webmcp", version: "0.0.0" };
}

const { name, version } = packageMeta();

/** The webmcp-lint rules this plugin exposes: every tool-scoped rule. Declarative rules apply to `<form toolname>` in JSX. */
export const staticRules: LintRule[] = builtinRules.filter((r) => r.scope === "tool");

/**
 * Rules with no `webmcp-lint` counterpart, because they judge the source that
 * built a definition rather than the definition. By the time the engine sees a
 * tool, an interpolated description is just a string.
 */
const sourceOnlyRules: Record<string, ESLintRule.RuleModule> = { "no-interpolated-text": noInterpolatedText };

const rules: Record<string, ESLintRule.RuleModule> = {
  ...Object.fromEntries(staticRules.map((r) => [r.id, createRule(r)])),
  ...sourceOnlyRules,
};

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
  rules: {
    ...Object.fromEntries(staticRules.map((r) => [`webmcp/${r.id}`, level(r)])),
    // Interpolation is not by itself a bug; it is a question about provenance.
    ...Object.fromEntries(Object.keys(sourceOnlyRules).map((id) => [`webmcp/${id}`, "warn" as const])),
  },
};

/** Every rule as an error. */
plugin.configs.all = {
  name: "webmcp/all",
  plugins: { webmcp: plugin },
  rules: Object.fromEntries(Object.keys(rules).map((id) => [`webmcp/${id}`, "error" as const])),
};

export default plugin;
