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

/**
 * Which field of the definition a finding was derived from, so findings about
 * a field the extractor could not read are dropped rather than guessed at. A
 * finding with a path is about the input schema; the rest are keyed by rule.
 */
const EXPOSED_TO_RULES = new Set(["exposed-to-secure-origins"]);

const NEEDS: Record<string, string[]> = {
  description: ["description-missing", "description-length", "description-injection", "declarative-description"],
  inputSchema: ["param-description-missing", "schema-shape", "schema-no-null-literals", "schema-depth", "schema-unsupported-keywords", "sensitive-params"],
  exposedTo: ["exposed-to-secure-origins"],
};

function fieldOf(finding: Finding): string | undefined {
  if (finding.path?.startsWith("/title")) return "title";
  if (finding.path?.startsWith("/annotations")) return "annotations";
  if (finding.path) return "inputSchema";
  for (const [field, ids] of Object.entries(NEEDS)) if (ids.includes(finding.ruleId)) return field;
  return undefined;
}

/** True when the finding concerns something the extractor marked dynamic. */
function aboutDynamic(finding: Finding, dynamic: Set<string>): boolean {
  if (dynamic.has("*")) return true;
  const field = fieldOf(finding);
  if (field && dynamic.has(field)) return true;
  if (finding.path) for (const entry of dynamic) if (entry.startsWith("/") && (finding.path === entry || finding.path.startsWith(`${entry}/`))) return true;
  return false;
}

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
  if (EXPOSED_TO_RULES.has(finding.ruleId) && tool.exposedToNode) return tool.exposedToNode;
  // Findings on `title` and `annotations` carry the field as their path.
  const field = finding.path?.match(/^\/(title|annotations)/)?.[1];
  if (field) {
    const at = nodeAtPath(tool.node, finding.path!.slice(1), resolve) ?? findProperty(tool.node, field)?.value;
    if (at) return at as ESTree.Node;
  }
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

type WithParent = ESTree.Node & { parent?: WithParent };

/**
 * Whether a reference to a binding is the target of an in-place mutation:
 * `tool.name = x`, `tool.inputSchema.properties.q = x`, `delete tool.x`,
 * `tool.count++`, or `Object.assign(tool, ...)`.
 */
function mutates(identifier: ESTree.Node): boolean {
  let node = identifier as WithParent;
  let parent = node.parent;
  while (parent?.type === "MemberExpression" && parent.object === node) {
    node = parent;
    parent = node.parent;
  }
  if (!parent) return false;
  if (node === identifier) {
    // `Object.assign(tool, ...)` with the binding as the target.
    if (parent.type !== "CallExpression" || parent.arguments[0] !== node) return false;
    const callee = unwrap(parent.callee as ESTree.Node);
    return (
      callee.type === "MemberExpression" &&
      callee.object.type === "Identifier" &&
      callee.object.name === "Object" &&
      callee.property.type === "Identifier" &&
      callee.property.name === "assign"
    );
  }
  if (parent.type === "AssignmentExpression") return parent.left === node;
  if (parent.type === "UpdateExpression") return true;
  if (parent.type === "UnaryExpression") return parent.operator === "delete";
  if (parent.type === "ForInStatement" || parent.type === "ForOfStatement") return parent.left === node;
  // A destructuring target: `[tool.x] = arr`, `({ y: tool.x } = obj)`.
  if (parent.type === "ArrayPattern" || parent.type === "RestElement") return true;
  if (parent.type === "Property") return parent.parent?.type === "ObjectPattern";
  return false;
}

/**
 * Follows an identifier to the literal it was initialised with, when it is a
 * `const` or `let` declared once in this file. Anything else is returned as is.
 */
export function makeResolver(sourceCode: ESLintRule.RuleContext["sourceCode"]): Resolver {
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
      // Only a binding that is never written after its initialiser, and whose value is not
      // visibly mutated in place, can be trusted. A reference handed to another function is
      // assumed not to mutate it.
      if (variable.references.some((ref) => (ref.isWrite() && !ref.init) || mutates(ref.identifier as ESTree.Node))) return node;
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
      const report = (definition: ExtractedTool["definition"], dynamic: Set<string>, locateFinding: (finding: Finding) => ESTree.Node) => {
        if (dynamic.has("*")) return;
        const result = lintTools([definition], { scope: "tool", rules, url: context.filename });
        for (const finding of result.findings) {
          if (finding.ruleId !== rule.id || aboutDynamic(finding, dynamic)) continue;
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
            report(tool.definition, tool.dynamic, (finding) => locate(tool, finding, resolve));
          }
        },
        // `<form toolname="...">` in JSX: the declarative tool the browser would derive from it.
        JSXElement(node: unknown) {
          const form = formTool(node as JSXElementNode, resolve);
          if (form) report(form.definition, form.dynamic, (finding) => locateInForm(form, finding));
        },
      } as ESLintRule.RuleListener;
    },
  };
}
