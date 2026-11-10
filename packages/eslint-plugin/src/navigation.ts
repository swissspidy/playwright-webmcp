/**
 * A rule about what a tool's `execute` does rather than what the tool
 * declares. Navigating away (a cross-document load) unregisters every tool
 * on the page and discards what the user had in front of them; a same-document
 * route change still swaps the view under them. Neither is visible to the
 * engine at runtime, which only ever sees the declaration, so this lives in the
 * plugin only.
 *
 * Detection is a heuristic over the source: assignments to `location`,
 * `location.assign()`/`replace()`/`reload()`, the History and Navigation APIs,
 * router objects (`router.push()`, `this.router.navigate()`), and a bare
 * `navigate()` as returned by React Router's `useNavigate()`. Calls to
 * functions defined in the same file are followed a few levels deep, so a
 * handler written next to the tool is read too.
 */
import type { Rule as ESLintRule } from "eslint";
import type * as ESTree from "estree";
import { toolHints } from "@swissspidy/webmcp-lint";
import { DYNAMIC, findProperty, memberName, staticValue, unwrap, type Resolver } from "./extract.js";
import { findVariable, type SourceCode } from "./scope.js";
import { discoverTools } from "./discover.js";
import { makeResolver } from "./rule.js";
import { ruleDocsUrl } from "./docs-url.js";

type Node = ESTree.Node;
export type AnyFunction = ESTree.FunctionExpression | ESTree.ArrowFunctionExpression | ESTree.FunctionDeclaration;

const DOCS = ruleDocsUrl("navigation-consequential");
/** How many calls to local functions are followed from `execute`. */
const MAX_DEPTH = 3;

const LOCATION_PROPS = new Set(["href", "pathname", "search"]);
const LOCATION_METHODS = new Set(["assign", "replace", "reload"]);
const HISTORY_METHODS = new Set(["pushState", "replaceState", "back", "forward", "go", "push", "replace"]);
const NAVIGATION_METHODS = new Set(["navigate", "back", "forward", "traverseTo", "reload"]);
const ROUTER_METHODS = new Set(["push", "replace", "navigate", "navigateByUrl", "back", "go"]);
const NAVIGATE_FUNCTIONS = new Set(["navigate", "navigateTo"]);

/** The last name in `a.b.c`, `this`, or a bare identifier. */
function lastName(node: Node): string | undefined {
  const n = unwrap(node);
  if (n.type === "Identifier") return n.name;
  if (n.type === "ThisExpression") return "this";
  return n.type === "MemberExpression" ? memberName(n) : undefined;
}

const GLOBAL_OBJECTS = new Set(["window", "document", "globalThis", "self"]);

/** True when the identifier is a parameter of an enclosing function: tool input, not the browser's global. */
function isParameter(identifier: ESTree.Identifier, sourceCode: SourceCode): boolean {
  return findVariable(identifier, sourceCode)?.defs.some((def) => def.type === "Parameter") ?? false;
}

/**
 * `location`, `window.location`, `document.location`: the browser's own object. Not `args.location`
 * or a `location` parameter, which are data that happens to share the name.
 */
function isLocation(node: Node, sourceCode: SourceCode): boolean {
  const n = unwrap(node);
  if (n.type === "Identifier") return n.name === "location" && !isParameter(n, sourceCode);
  if (n.type !== "MemberExpression" || lastName(n) !== "location") return false;
  const object = unwrap(n.object as Node);
  return object.type === "Identifier" && GLOBAL_OBJECTS.has(object.name);
}

/** A short description of how a node navigates, or undefined when it does not. */
function navigationAt(node: Node, sourceCode: SourceCode): string | undefined {
  if (node.type === "AssignmentExpression") {
    const left = unwrap(node.left as Node);
    if (isLocation(left, sourceCode)) return "assigns location";
    if (left.type === "MemberExpression" && isLocation(left.object as Node, sourceCode)) {
      const prop = lastName(left);
      if (prop && LOCATION_PROPS.has(prop)) return `sets location.${prop}`;
    }
    return undefined;
  }
  if (node.type !== "CallExpression") return undefined;
  const callee = unwrap(node.callee as Node);
  if (callee.type === "Identifier") return NAVIGATE_FUNCTIONS.has(callee.name) ? `calls ${callee.name}()` : undefined;
  if (callee.type !== "MemberExpression") return undefined;
  const method = lastName(callee);
  if (!method) return undefined;
  const object = unwrap(callee.object as Node);
  if (isLocation(object, sourceCode)) return LOCATION_METHODS.has(method) ? `calls location.${method}()` : undefined;
  // A parameter named history or router is the tool's input (a list, a string), not the API.
  if (object.type === "Identifier" && isParameter(object, sourceCode)) return undefined;
  const receiver = lastName(object) ?? "";
  if (receiver === "location") return undefined;
  if (receiver === "history" && HISTORY_METHODS.has(method)) return `calls history.${method}()`;
  if (receiver === "navigation" && NAVIGATION_METHODS.has(method)) return `calls navigation.${method}()`;
  if (/router$/i.test(receiver) && ROUTER_METHODS.has(method)) return `calls ${receiver}.${method}()`;
  if (method === "navigate") return `calls ${receiver ? `${receiver}.` : ""}navigate()`;
  return undefined;
}

/** The function a node stands for: a function literal, or an identifier bound to one in this file. */
export function functionOf(node: Node, resolve: Resolver, sourceCode: SourceCode): AnyFunction | undefined {
  const n = unwrap(resolve(node));
  if (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression" || n.type === "FunctionDeclaration") return n;
  if (n.type !== "Identifier") return undefined;
  const variable = findVariable(n, sourceCode);
  const def = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  return def?.type === "FunctionName" ? (def.node as ESTree.FunctionDeclaration) : undefined;
}

const SKIP_KEYS = new Set(["parent", "loc", "range", "start", "end", "typeAnnotation", "returnType", "typeParameters"]);

export function* children(node: Node): Generator<Node> {
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === "object" && typeof item.type === "string") yield item as Node;
    } else if (value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string") yield value as Node;
  }
}

interface Hit {
  node: Node;
  how: string;
}

/** The first navigation reachable from a function body, following calls to local functions. */
function findNavigation(fn: AnyFunction, resolve: Resolver, sourceCode: SourceCode, depth = 0, seen = new Set<AnyFunction>()): Hit | undefined {
  if (seen.has(fn)) return undefined;
  seen.add(fn);
  const stack: Node[] = [fn.body as Node];
  while (stack.length) {
    const node = stack.pop()!;
    const how = navigationAt(node, sourceCode);
    if (how) return { node, how };
    if (node.type === "CallExpression" && depth < MAX_DEPTH) {
      const target = functionOf(node.callee as Node, resolve, sourceCode);
      if (target) {
        const hit = findNavigation(target, resolve, sourceCode, depth + 1, seen);
        if (hit) return hit;
      }
    }
    stack.push(...[...children(node)].reverse());
  }
  return undefined;
}

export const navigationConsequential: ESLintRule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "A tool whose execute navigates changes what the user sees and, across documents, unregisters the page's tools; it should say so with consequentialHint and must not claim readOnlyHint.",
      url: DOCS,
    },
    schema: [],
    messages: {
      readOnly: 'Tool "{{name}}" declares readOnlyHint but its execute {{how}}; a tool that navigates is not read-only.',
      undeclared:
        'Tool "{{name}}" {{how}} in its execute but does not declare consequentialHint. Set it to true so clients can confirm before the view changes, or to false if you decided it is not.',
    },
  },
  create(context) {
    const resolve = makeResolver(context.sourceCode);
    return discoverTools(context, resolve, ({ node: obj }) => {
      // A spread may carry annotations or execute this rule cannot see.
      if (obj.properties.some((p) => p.type !== "Property")) return;
      const execute = findProperty(obj, "execute");
      if (!execute) return;
      const fn = functionOf(execute.value as Node, resolve, context.sourceCode);
      if (!fn) return;
      const annotationsProp = findProperty(obj, "annotations");
      const annotations = annotationsProp ? staticValue(annotationsProp.value as Node, resolve) : undefined;
      if (annotations === DYNAMIC) return;
      const hints = toolHints(annotations as Record<string, unknown> | undefined);
      if (hints.readOnly !== true && hints.consequential !== undefined) return;
      const hit = findNavigation(fn, resolve, context.sourceCode);
      if (!hit) return;
      const nameProp = findProperty(obj, "name");
      const name = nameProp ? staticValue(nameProp.value as Node, resolve) : undefined;
      context.report({
        node: hit.node as ESLintRule.Node,
        messageId: hints.readOnly === true ? "readOnly" : "undeclared",
        data: { name: typeof name === "string" ? name : "(computed)", how: hit.how },
      });
    });
  },
};
