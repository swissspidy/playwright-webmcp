/**
 * Turns one tool-scoped webmcp-lint rule into an ESLint rule. Every rule
 * shares the extraction of tool definitions from the file; each runs only its
 * own webmcp-lint rule against each extracted tool and maps the findings back
 * to source locations.
 */
import type { Rule as ESLintRule } from "eslint";
import type * as ESTree from "estree";
import { builtinRules, lintTools, type Finding, type Rule as LintRule } from "webmcp-lint";
import { findProperty, nodeAtPath, toolsFromCall, type ExtractedTool } from "./extract.js";

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

function locate(tool: ExtractedTool, finding: Finding): ESTree.Node {
  if (finding.path) {
    const schema = findProperty(tool.node, "inputSchema");
    if (schema && schema.value.type !== "AssignmentPattern") {
      const inner = schema.value as ESTree.Node;
      if (inner.type === "ObjectExpression") {
        const at = nodeAtPath(inner, finding.path);
        if (at) return at;
        // A missing property description points at the property itself.
        const parent = nodeAtPath(inner, finding.path.replace(/\/[^/]+$/, ""));
        if (parent) return parent;
      }
      return inner;
    }
  }
  if (finding.ruleId.startsWith("description-")) {
    const description = findProperty(tool.node, "description");
    if (description) return description.value as ESTree.Node;
  }
  const name = findProperty(tool.node, "name");
  return (name?.value as ESTree.Node | undefined) ?? tool.node;
}

const cache = new WeakMap<object, ExtractedTool[]>();

/** Tool definitions in a file, computed once per Program node and shared by every rule. */
function extractAll(program: ESTree.Program, sourceCode: ESLintRule.RuleContext["sourceCode"]): ExtractedTool[] {
  const hit = cache.get(program);
  if (hit) return hit;
  const out: ExtractedTool[] = [];
  const visit = (node: ESTree.Node | null | undefined): void => {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression") out.push(...toolsFromCall(node));
    const keys = sourceCode.visitorKeys[node.type] ?? [];
    for (const key of keys) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) for (const c of child) visit(c as ESTree.Node);
      else if (child && typeof child === "object" && "type" in (child as object)) visit(child as ESTree.Node);
    }
  };
  visit(program);
  cache.set(program, out);
  return out;
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
      return {
        Program(program) {
          for (const tool of extractAll(program as ESTree.Program, context.sourceCode)) {
            if ([...tool.dynamic].some((field) => field === "*" || NEEDS[field]?.includes(rule.id))) continue;
            const result = lintTools([tool.definition], {
              scope: "tool",
              rules: Object.fromEntries(builtinRules.map((r) => [r.id, r.id === rule.id ? options : false])),
              url: context.filename,
            });
            for (const finding of result.findings) {
              if (finding.ruleId !== rule.id) continue;
              context.report({
                node: locate(tool, finding) as ESLintRule.Node,
                messageId: "finding",
                data: { message: finding.help ? `${finding.message} ${finding.help}` : finding.message },
              });
            }
          }
        },
      };
    },
  };
}
