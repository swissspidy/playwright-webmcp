/**
 * A rule about how the API is called rather than what a tool declares. It
 * has no `webmcp-lint` counterpart because what it catches never survives to
 * runtime: a listener for an event nothing fires simply never runs.
 */
import type { Rule as ESLintRule, Scope } from "eslint";
import type * as ESTree from "estree";
import { unwrap } from "./extract.js";
import { ruleDocsUrl } from "./docs-url.js";

const DOCS = ruleDocsUrl("valid-event-name");

/** The name of a non-computed property, or of a computed one written as a string. */
function memberName(node: ESTree.MemberExpression): string | undefined {
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : undefined;
  return node.property.type === "Literal" && typeof node.property.value === "string" ? node.property.value : undefined;
}

/**
 * True for `x.modelContext`, and for a `const` (or never reassigned `let`)
 * initialised with it in this file. Unlike the plugin's value resolver this
 * does not treat `mc.ontoolchange = f` as a reason to stop following `mc`:
 * a property written on the object does not change what the binding holds.
 */
function isModelContext(node: ESTree.Node, sourceCode: ESLintRule.RuleContext["sourceCode"], seen = new Set<string>()): boolean {
  const n = unwrap(node);
  if (n.type === "MemberExpression") return memberName(n) === "modelContext";
  if (n.type !== "Identifier" || seen.has(n.name)) return false;
  let scope: Scope.Scope | null;
  try {
    scope = sourceCode.getScope(n);
  } catch {
    return false;
  }
  for (; scope; scope = scope.upper) {
    const variable = scope.set.get(n.name);
    if (!variable) continue;
    if (variable.defs.length !== 1) return false;
    const def = variable.defs[0];
    if (def.type !== "Variable" || def.node.type !== "VariableDeclarator" || !def.node.init || def.node.id.type !== "Identifier") return false;
    if (variable.references.some((ref) => ref.isWrite() && !ref.init)) return false;
    seen.add(n.name);
    return isModelContext(def.node.init as ESTree.Node, sourceCode, seen);
  }
  return false;
}

const EVENTS = ["toolchange", "toolactivated", "toolcancel"];

export const validEventName: ESLintRule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "ModelContext fires toolchange, toolactivated and toolcancel; a listener on document.modelContext for any other tool* event never runs.",
      url: DOCS,
    },
    schema: [],
    messages: { unknown: 'No "{{name}}" event is fired; ModelContext fires {{events}}.' },
  },
  create(context) {
    const check = (node: ESTree.Node, name: string) => {
      if (!/^tool/i.test(name) || EVENTS.includes(name)) return;
      context.report({ node: node as ESLintRule.Node, messageId: "unknown", data: { name, events: EVENTS.join(", ") } });
    };
    // Only a receiver known to be the ModelContext: any element may fire its own tool* events.
    return {
      CallExpression(node) {
        const callee = unwrap((node as ESTree.CallExpression).callee as ESTree.Node);
        if (callee.type !== "MemberExpression") return;
        const method = memberName(callee);
        if (method !== "addEventListener" && method !== "removeEventListener") return;
        if (!isModelContext(callee.object as ESTree.Node, context.sourceCode)) return;
        const first = (node as ESTree.CallExpression).arguments[0];
        if (first && first.type === "Literal" && typeof first.value === "string") check(first, first.value);
      },
      AssignmentExpression(node) {
        const left = unwrap((node as ESTree.AssignmentExpression).left as ESTree.Node);
        if (left.type !== "MemberExpression" || !isModelContext(left.object as ESTree.Node, context.sourceCode)) return;
        const name = memberName(left);
        if (name && /^ontool/i.test(name)) check(left.property as ESTree.Node, name.slice(2));
      },
    } as ESLintRule.RuleListener;
  },
};
