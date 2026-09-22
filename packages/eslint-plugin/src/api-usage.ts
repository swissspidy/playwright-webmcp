/**
 * A rule about how the API is called rather than what a tool declares. It
 * has no `webmcp-lint` counterpart because what it catches never survives to
 * runtime: a listener for an event nothing fires simply never runs.
 */
import type { Rule as ESLintRule } from "eslint";
import type * as ESTree from "estree";
import { unwrap } from "./extract.js";

const DOCS = "https://github.com/swissspidy/playwright-webmcp#rules";

/** The name of a non-computed property, or of a computed one written as a string. */
function memberName(node: ESTree.MemberExpression): string | undefined {
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : undefined;
  return node.property.type === "Literal" && typeof node.property.value === "string" ? node.property.value : undefined;
}

function calleeMethod(call: ESTree.CallExpression): string | undefined {
  const callee = unwrap(call.callee as ESTree.Node);
  if (callee.type === "MemberExpression") return memberName(callee);
  return callee.type === "Identifier" ? callee.name : undefined;
}

const EVENTS = ["toolchange", "toolactivated", "toolcancel"];

export const validEventName: ESLintRule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "ModelContext fires toolchange, toolactivated and toolcancel; a listener for any other tool* event never runs.", url: DOCS },
    schema: [],
    messages: { unknown: 'No "{{name}}" event is fired; ModelContext fires {{events}}.' },
  },
  create(context) {
    const check = (node: ESTree.Node, name: string) => {
      if (!/^tool/i.test(name) || EVENTS.includes(name)) return;
      context.report({ node: node as ESLintRule.Node, messageId: "unknown", data: { name, events: EVENTS.join(", ") } });
    };
    return {
      CallExpression(node) {
        const method = calleeMethod(node as ESTree.CallExpression);
        if (method !== "addEventListener" && method !== "removeEventListener") return;
        const first = (node as ESTree.CallExpression).arguments[0];
        if (first && first.type === "Literal" && typeof first.value === "string") check(first, first.value);
      },
      AssignmentExpression(node) {
        const left = unwrap((node as ESTree.AssignmentExpression).left as ESTree.Node);
        if (left.type !== "MemberExpression") return;
        const name = memberName(left);
        if (name && /^ontool/i.test(name)) check(left.property as ESTree.Node, name.slice(2));
      },
    } as ESLintRule.RuleListener;
  },
};
