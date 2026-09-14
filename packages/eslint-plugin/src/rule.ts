/**
 * Turns one tool-scoped webmcp-lint rule into an ESLint rule. Each rule
 * extracts the tool definitions passed to the calls named in the settings,
 * runs only its own webmcp-lint rule against each, and maps the findings back
 * to source locations. Nothing beyond the ESLint rule contract is used
 * (CallExpression visitor, `context.sourceCode.getScope`, `context.settings`,
 * `context.report`), so the rules also load in oxlint's JS plugin runner.
 */
import type { Rule as ESLintRule, Scope } from "eslint";
import type * as ESTree from "estree";
import { builtinRules, lintTools, type Finding, type Rule as LintRule } from "webmcp-lint";
import { findProperty, nodeAtPath, toolsFromCall, unwrap, type ExtractedTool, type Resolver } from "./extract.js";
import { formTool, type ExtractedForm, type JSXElementNode } from "./jsx.js";
import { definitionSites } from "./settings.js";

/** webmcp-lint rules that read a field the extractor may have found to be dynamic. */
const NEEDS: Record<string, string[]> = {
  description: ["description-missing", "description-length", "description-injection"],
  inputSchema: [
    "param-description-missing",
    "schema-shape",
    "schema-no-null-literals",
    "schema-depth",
    "schema-unsupported-keywords",
    "sensitive-params",
    "description-injection",
  ],
  annotations: [],
  exposedTo: ["exposed-to-secure-origins"],
};

function optionSchema(rule: LintRule): ESLintRule.RuleMetaData["schema"] {
  const defaults = rule.defaults ?? {};
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value === "number") properties[key] = { type: "number" };
    else if (typeof value === "string") properties[key] = { type: "string" };
    else if (typeof value === "boolean") properties[key] = { type: "boolean" };
    else if (Array.isArray(value)) properties[key] = { type: "array", items: { type: "string" } };
    else properties[key] = {};
  }
  return [{ type: "object", properties, additionalProperties: false }];
}

function locate(tool: ExtractedTool, finding: Finding, resolve: Resolver): ESTree.Node {
  if (finding.path) {
    const schema = findProperty(tool.node, "inputSchema");
    if (schema && schema.value.type !== "AssignmentPattern") {
      const inner = unwrap(resolve(schema.value as ESTree.Node));
      if (inner.type === "ObjectExpression") {
        const at = nodeAtPath(inner, finding.path, resolve);
        if (at) return at;
        // A missing property description points at the property itself.
        const parent = nodeAtPath(inner, finding.path.replace(/\/[^/]+$/, ""), resolve);
        if (parent) return parent;
      }
      return schema.value as ESTree.Node;
    }
  }
  if (finding.ruleId.startsWith("description-")) {
    const description = findProperty(tool.node, "description");
    if (description) return description.value as ESTree.Node;
  }
  const name = findProperty(tool.node, "name");
  return (name?.value as ESTree.Node | undefined) ?? tool.node;
}

function locateInForm(form: ExtractedForm, finding: Finding): ESTree.Node {
  const field = finding.path?.match(/^\/properties\/([^/]+)/)?.[1];
  const node = (field && form.fieldNodes.get(field)) ?? form.node.openingElement;
  return node as unknown as ESTree.Node;
}

/**
 * Follows an identifier to the literal it was initialised with, when it is a
 * `const` or `let` declared once in this file. Anything else is returned as is.
 */
function makeResolver(sourceCode: ESLintRule.RuleContext["sourceCode"]): Resolver {
  const seen = new Set<ESTree.Node>();
  const resolve: Resolver = (node) => {
    const n = unwrap(node);
    if (n.type !== "Identifier" || seen.has(n)) return node;
    let scope: Scope.Scope | null;
    try {
      scope = sourceCode.getScope(n);
    } catch {
      return node;
    }
    for (; scope; scope = scope.upper) {
      const variable = scope.set.get(n.name);
      if (!variable) continue;
      if (variable.defs.length !== 1) return node;
      const def = variable.defs[0];
      if (def.type !== "Variable" || def.node.type !== "VariableDeclarator" || !def.node.init) return node;
      const declarator = def.node as ESTree.VariableDeclarator & { parent?: ESTree.Node };
      const declaration = ((def as { parent?: ESTree.Node | null }).parent ?? declarator.parent) as ESTree.VariableDeclaration | undefined;
      if (declaration?.type === "VariableDeclaration" && declaration.kind === "var") return node;
      if (def.node.id.type !== "Identifier") return node;
      // Only a binding that is never written after its initialiser can be trusted.
      if (variable.references.some((ref) => ref.isWrite() && !ref.init)) return node;
      seen.add(n);
      const target = resolve(def.node.init as ESTree.Node);
      seen.delete(n);
      return target;
    }
    return node;
  };
  return resolve;
}

export function createRule(rule: LintRule): ESLintRule.RuleModule {
  return {
    meta: {
      type: rule.severity === "error" ? "problem" : "suggestion",
      docs: {
        description: rule.description,
        url: "https://github.com/swissspidy/playwright-webmcp#rules",
      },
      schema: optionSchema(rule),
      messages: { finding: "{{message}}" },
    },
    create(context) {
      const options = (context.options[0] ?? {}) as Record<string, unknown>;
      const sites = definitionSites(context.settings);
      const resolve = makeResolver(context.sourceCode);
      const rules = Object.fromEntries(builtinRules.map((r) => [r.id, r.id === rule.id ? options : false]));
      const report = (definition: ExtractedTool["definition"], locateFinding: (finding: Finding) => ESTree.Node) => {
        const result = lintTools([definition], { scope: "tool", rules, url: context.filename });
        for (const finding of result.findings) {
          if (finding.ruleId !== rule.id) continue;
          context.report({
            node: locateFinding(finding) as ESLintRule.Node,
            messageId: "finding",
            data: { message: finding.help ? `${finding.message} ${finding.help}` : finding.message },
          });
        }
      };
      return {
        CallExpression(node) {
          for (const tool of toolsFromCall(node as ESTree.CallExpression, sites, resolve)) {
            if ([...tool.dynamic].some((field) => field === "*" || NEEDS[field]?.includes(rule.id))) continue;
            report(tool.definition, (finding) => locate(tool, finding, resolve));
          }
        },
        // `<form toolname="...">` in JSX: the declarative tool the browser would derive from it.
        JSXElement(node: unknown) {
          const form = formTool(node as JSXElementNode, resolve);
          if (form) report(form.definition, (finding) => locateInForm(form, finding));
        },
      } as ESLintRule.RuleListener;
    },
  };
}
