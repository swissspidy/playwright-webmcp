/**
 * Tool text assembled at runtime.
 *
 * Every other rule here judges a string the author wrote. This one judges a
 * string the author only wrote half of: `description: `Search ${siteName}`` is
 * a description whose remainder arrives from somewhere else, and "somewhere
 * else" on a CMS-backed page is a title, a category or a display name that
 * somebody who is not the author can set. Whatever lands there is read by
 * every agent that visits, in the same breath as the rest of the description.
 *
 * It is the one problem in this package that only static analysis can see: by
 * the time a page is running, an interpolated description is just a string,
 * indistinguishable from a literal one. So it is an ESLint rule rather than a
 * `webmcp-lint` rule -- the engine is handed the definition, not the source
 * that built it.
 *
 * Interpolation is not by itself a bug, which is why this warns rather than
 * errors: what it asks is whether the author can name where each interpolated
 * value comes from.
 */
import type { Rule as ESLintRule } from "eslint";
import type * as ESTree from "estree";
import { findProperty, staticValue, toolObjectsFromCall, unwrap, type Resolver } from "./extract.js";
import { elementsWithin, type JSXAttributeNode, type JSXElementNode, type JSXOpeningElementNode } from "./jsx.js";
import { makeResolver } from "./rule.js";
import { definitionSites } from "./settings.js";

type Shape = "template" | "concatenation";

/**
 * A `+` chain with a string literal or template somewhere in it: text assembly,
 * not arithmetic. Operands are resolved like every other value this plugin
 * reads, so `prefix + siteName` is judged by what `prefix` holds rather than by
 * the fact that it is an identifier.
 */
function assemblesText(node: ESTree.Node, resolve: Resolver): boolean {
  const n = unwrap(resolve(node));
  if (n.type === "Literal") return typeof n.value === "string";
  if (n.type === "TemplateLiteral") return true;
  if (n.type === "BinaryExpression" && n.operator === "+") {
    return assemblesText(n.left as ESTree.Node, resolve) || assemblesText(n.right, resolve);
  }
  return false;
}

/**
 * How the value is built, or undefined when it is not built at all. A call or
 * a member expression is a *reference* to text -- a translation, a constant --
 * not an interpolation, and is left alone.
 */
export function interpolationOf(node: ESTree.Node, resolve: Resolver): { shape: Shape; node: ESTree.Node } | undefined {
  const n = unwrap(resolve(node));
  if (n.type === "TemplateLiteral" && n.expressions.length > 0) return { shape: "template", node: n };
  if (n.type === "BinaryExpression" && n.operator === "+" && assemblesText(n, resolve)) return { shape: "concatenation", node: n };
  return undefined;
}

/** What is at stake for each field, in the words of the finding. */
const FIELDS: Record<string, string> = {
  name: "A tool name built from data can collide with, or shadow, another tool on the page",
  title: "A title is shown to the user and read by the agent",
  description: "A description is read by every agent that visits the page",
};

const PARAM = "A parameter description is read by every agent that visits the page";

function attributeNode(el: JSXOpeningElementNode, name: string): JSXAttributeNode | undefined {
  for (const attr of el.attributes) {
    if (attr.type !== "JSXAttribute") continue;
    const attrName = attr.name.type === "JSXIdentifier" ? attr.name.name : attr.name.name.name;
    if (attrName.toLowerCase() === name) return attr;
  }
  return undefined;
}

/** The expression written inside `attr={...}`, when there is one. */
function attributeExpression(attr: JSXAttributeNode): ESTree.Node | undefined {
  if (!attr.value || attr.value.type !== "JSXExpressionContainer") return undefined;
  const expression = attr.value.expression;
  return expression.type === "JSXEmptyExpression" ? undefined : (expression as ESTree.Node);
}

export const noInterpolatedText: ESLintRule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Tool names, titles and descriptions should be written out, not assembled at runtime from values the author cannot name the source of.",
      url: "https://github.com/swissspidy/playwright-webmcp#rules",
    },
    schema: [
      {
        type: "object",
        properties: { fields: { type: "array", items: { enum: ["name", "title", "description", "parameters"] } } },
        additionalProperties: false,
      },
    ],
    messages: { finding: "{{message}}" },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as { fields?: string[] };
    const fields = new Set(options.fields ?? ["name", "title", "description", "parameters"]);
    const sites = definitionSites(context.settings);
    const resolve = makeResolver(context.sourceCode);

    const report = (node: ESTree.Node, shape: Shape, what: string, subject: string) => {
      const how = shape === "template" ? "a template literal" : "string concatenation";
      context.report({
        node: node as ESLintRule.Node,
        messageId: "finding",
        data: {
          message: `${subject} is built with ${how}. ${what}, so whatever is interpolated here reaches the agent as if the page had written it. Make sure you can name where each value comes from.`,
        },
      });
    };

    /** Tool text in an object literal: the three top-level fields plus each parameter description. */
    const checkObject = (obj: ESTree.ObjectExpression, label: (field: string) => string) => {
      for (const [field, what] of Object.entries(FIELDS)) {
        if (!fields.has(field)) continue;
        const prop = findProperty(obj, field);
        if (!prop || prop.value.type === "AssignmentPattern") continue;
        const found = interpolationOf(prop.value as ESTree.Node, resolve);
        if (found) report(found.node, found.shape, what, label(field));
      }
      if (!fields.has("parameters")) return;
      const schema = findProperty(obj, "inputSchema");
      if (!schema || schema.value.type === "AssignmentPattern") return;
      const inner = unwrap(resolve(schema.value as ESTree.Node));
      if (inner.type !== "ObjectExpression") return;
      const properties = findProperty(inner, "properties");
      if (!properties || properties.value.type === "AssignmentPattern") return;
      const bag = unwrap(resolve(properties.value as ESTree.Node));
      if (bag.type !== "ObjectExpression") return;
      for (const prop of bag.properties) {
        if (prop.type !== "Property") continue;
        const param = unwrap(resolve(prop.value as ESTree.Node));
        if (param.type !== "ObjectExpression") continue;
        const description = findProperty(param, "description");
        if (!description || description.value.type === "AssignmentPattern") continue;
        const found = interpolationOf(description.value as ESTree.Node, resolve);
        const key = prop.key.type === "Identifier" ? prop.key.name : String((prop.key as ESTree.Literal).value);
        if (found) report(found.node, found.shape, PARAM, `The description of parameter "${key}"`);
      }
    };

    return {
      CallExpression(node) {
        // Definition objects, not extracted tools: a tool whose name is computed
        // has no definition to lint, and that computation is this rule's subject.
        for (const { node: obj } of toolObjectsFromCall(node as ESTree.CallExpression, sites, resolve)) {
          const nameProp = findProperty(obj, "name");
          const name = nameProp && nameProp.value.type !== "AssignmentPattern" ? staticValue(nameProp.value as ESTree.Node, resolve) : undefined;
          const named = typeof name === "string" && name ? ` of "${name}"` : "";
          checkObject(obj, (field) => (field === "name" ? "This tool's name" : `The ${field}${named}`));
        }
      },
      // `<form toolname={...} tooldescription={...}>` and its fields.
      JSXElement(node: unknown) {
        const el = node as JSXElementNode;
        const opening = el.openingElement;
        if (!attributeNode(opening, "toolname")) return;
        for (const [attr, field, subject] of [
          ["toolname", "name", "This form's tool name"],
          ["tooldescription", "description", "This form's tooldescription"],
        ] as const) {
          if (!fields.has(field)) continue;
          const written = attributeNode(opening, attr);
          const expression = written && attributeExpression(written);
          const found = expression && interpolationOf(expression, resolve);
          if (found) report(found.node, found.shape, FIELDS[field], subject);
        }
        if (!fields.has("parameters")) return;
        for (const child of elementsWithin(el.children)) {
          const written = attributeNode(child.openingElement, "toolparamdescription");
          const expression = written && attributeExpression(written);
          const found = expression && interpolationOf(expression, resolve);
          if (!found) continue;
          const nameAttr = attributeNode(child.openingElement, "name");
          const literal = nameAttr?.value?.type === "Literal" ? String(nameAttr.value.value) : undefined;
          report(found.node, found.shape, PARAM, literal ? `The description of field "${literal}"` : "A field description");
        }
      },
    } as ESLintRule.RuleListener;
  },
};
