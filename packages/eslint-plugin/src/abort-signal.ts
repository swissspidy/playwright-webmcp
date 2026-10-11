/**
 * A rule about what a consequential tool's `execute` does with the call's
 * abort signal. The browser passes `execute` a second argument whose `signal`
 * aborts when the browser or the agent cancels the call, and tells the agent
 * the call was canceled; the code keeps running unless it checks. A tool that
 * waits and then does something it cannot take back should read the signal
 * first. What `execute` does with its arguments is not part of the
 * declaration, so this lives in the plugin only.
 *
 * It flags an `execute` that waits (is async, awaits, chains `.then()`, or
 * hands its work to another call) and never uses its second parameter. Any use
 * counts, including passing it to a helper; a tool whose `execute` is not a
 * function written in this file is left alone.
 */
import type { Rule as ESLintRule } from "eslint";
import type * as ESTree from "estree";
import { toolHints } from "@swissspidy/webmcp-lint";
import { DYNAMIC, findProperty, staticValue, unwrap } from "./extract.js";
import { discoverTools } from "./discover.js";
import { makeResolver } from "./rule.js";
import { ruleDocsUrl } from "./docs-url.js";
import { children, functionOf, type AnyFunction } from "./navigation.js";

type Node = ESTree.Node;

const DOCS = ruleDocsUrl("consequential-abort-signal");

/** Names a parameter pattern binds: `client`, `{ signal }`, `{ signal: s = x }`, `[a, ...b]`. */
function boundNames(pattern: ESTree.Pattern, out: string[] = []): string[] {
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const p of pattern.properties) boundNames(p.type === "RestElement" ? p.argument : p.value, out);
      break;
    case "ArrayPattern":
      for (const p of pattern.elements) if (p) boundNames(p, out);
      break;
    case "RestElement":
      boundNames(pattern.argument, out);
      break;
    case "AssignmentPattern":
      boundNames(pattern.left, out);
      break;
  }
  return out;
}

/** Whether the body reads any of these names, or `arguments`. Property names and object keys are not reads. */
function readsAny(fn: AnyFunction, names: Set<string>): boolean {
  const stack: Array<{ node: Node; parent?: Node }> = [{ node: fn.body as Node }];
  while (stack.length) {
    const { node, parent } = stack.pop()!;
    if (node.type === "Identifier" && (names.has(node.name) || node.name === "arguments")) {
      const isPropertyName = parent?.type === "MemberExpression" && parent.property === node && !parent.computed;
      const isKey = parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand;
      if (!isPropertyName && !isKey) return true;
    }
    for (const child of children(node)) stack.push({ node: child, parent: node });
  }
  return false;
}

/** Whether the function waits on something, so a cancel can arrive while it runs. */
function waits(fn: AnyFunction): boolean {
  if (fn.async) return true;
  const body = unwrap(fn.body as Node);
  // `(args) => placeOrder(args)`: the work, and its waiting, is in the call.
  if (body.type === "CallExpression") return true;
  const stack: Node[] = [body];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "AwaitExpression") return true;
    if (node.type === "CallExpression") {
      const callee = unwrap(node.callee as Node);
      if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier" && callee.property.name === "then") return true;
    }
    // A nested function's awaits are its own.
    if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration") continue;
    stack.push(...children(node));
  }
  return false;
}

export const consequentialAbortSignal: ESLintRule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "A tool that declares consequentialHint and waits in its execute should read the abort signal it is given; a canceled call keeps running otherwise, and its side effect happens after the agent was told it did not.",
      url: DOCS,
    },
    schema: [],
    messages: {
      unread:
        'Tool "{{name}}" declares consequentialHint, but its execute never reads the signal it is given, so a canceled call carries on. Take the second parameter and check client.signal before the side effect (client?.signal?.throwIfAborted()), or pass it on, e.g. to fetch().',
    },
  },
  create(context) {
    const resolve = makeResolver(context.sourceCode);
    return discoverTools(context, resolve, ({ node: obj }) => {
      // A spread may carry annotations or execute this rule cannot see.
      if (obj.properties.some((p) => p.type !== "Property")) return;
      const annotationsProp = findProperty(obj, "annotations");
      const annotations = annotationsProp ? staticValue(annotationsProp.value as Node, resolve) : undefined;
      if (annotations === DYNAMIC) return;
      if (toolHints(annotations as Record<string, unknown> | undefined).consequential !== true) return;
      const execute = findProperty(obj, "execute");
      if (!execute) return;
      const fn = functionOf(execute.value as Node, resolve, context.sourceCode);
      if (!fn || !waits(fn)) return;
      // `(...args)` keeps the second argument within reach as args[1].
      if (fn.params[0]?.type === "RestElement") return;
      const names = new Set(fn.params.slice(1).flatMap((p) => boundNames(p as ESTree.Pattern)));
      if (readsAny(fn, names)) return;
      const nameProp = findProperty(obj, "name");
      const name = nameProp ? staticValue(nameProp.value as Node, resolve) : undefined;
      context.report({
        node: execute as ESLintRule.Node,
        messageId: "unread",
        data: { name: typeof name === "string" ? name : "(computed)" },
      });
    });
  },
};
