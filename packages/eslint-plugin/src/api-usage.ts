/**
 * Rules about how the API is called rather than what a tool declares:
 * removed entry points, properties the dictionaries do not have, methods
 * called unbound, event names nothing fires, and a missing `execute`. None
 * of them has a `webmcp-lint` counterpart because none of them survives to
 * runtime: a misspelt dictionary member is silently dropped, and an
 * unbound method throws before any tool exists.
 */
import type { Rule as ESLintRule } from "eslint";
import type * as ESTree from "estree";
import { findProperty, toolObjectsFromCall, unwrap, type Resolver } from "./extract.js";
import { makeResolver } from "./rule.js";
import { definitionSites } from "./settings.js";

const DOCS = "https://github.com/swissspidy/playwright-webmcp#rules";

type WithParent = ESTree.Node & { parent?: WithParent };

/** The name of a non-computed property, or of a computed one written as a string. */
function memberName(node: ESTree.MemberExpression): string | undefined {
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : undefined;
  return node.property.type === "Literal" && typeof node.property.value === "string" ? node.property.value : undefined;
}

function propertyName(prop: ESTree.Property): string | undefined {
  if (!prop.computed) return prop.key.type === "Identifier" ? prop.key.name : prop.key.type === "Literal" ? String(prop.key.value) : undefined;
  return prop.key.type === "Literal" && typeof prop.key.value === "string" ? prop.key.value : undefined;
}

/** True for `x.modelContext` and for an identifier initialised with it. */
function isModelContext(node: ESTree.Node, resolve: Resolver): boolean {
  const n = unwrap(resolve(node));
  return n.type === "MemberExpression" && memberName(n) === "modelContext";
}

function calleeMethod(call: ESTree.CallExpression): string | undefined {
  const callee = unwrap(call.callee as ESTree.Node);
  if (callee.type === "MemberExpression") return memberName(callee);
  return callee.type === "Identifier" ? callee.name : undefined;
}

const REMOVED_METHODS: Record<string, string> = {
  provideContext: "registerTool() once per tool; it was removed from the specification in March 2026",
  clearContext: "an AbortSignal passed to registerTool(); abort it to unregister",
  unregisterTool: "an AbortSignal passed to registerTool(); abort it to unregister",
  requestUserInteraction: "nothing yet; it is not in the specification",
};

export const noLegacyApi: ESLintRule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Entry points and methods that are no longer in the WebMCP specification: navigator.modelContext, window.agent, provideContext, clearContext, unregisterTool.",
      url: DOCS,
    },
    schema: [],
    messages: {
      entry: "{{written}} is not where WebMCP lives; use document.modelContext.",
      method: "{{method}}() is not in the WebMCP specification; use {{instead}}.",
    },
  },
  create(context) {
    const resolve = makeResolver(context.sourceCode);
    return {
      MemberExpression(node) {
        const name = memberName(node);
        const object = unwrap(node.object as ESTree.Node);
        if (name === "modelContext" && object.type !== "Identifier" && object.type !== "MemberExpression") return;
        if (name === "modelContext") {
          const owner = object.type === "Identifier" ? object.name : object.type === "MemberExpression" ? memberName(object) : undefined;
          if (owner === "navigator") context.report({ node: node as ESLintRule.Node, messageId: "entry", data: { written: "navigator.modelContext" } });
          return;
        }
        if (name === "agent" && object.type === "Identifier" && (object.name === "window" || object.name === "self" || object.name === "globalThis")) {
          context.report({ node: node as ESLintRule.Node, messageId: "entry", data: { written: `${object.name}.agent` } });
          return;
        }
        if (name && name in REMOVED_METHODS && isModelContext(node.object as ESTree.Node, resolve)) {
          context.report({ node: node.property as ESLintRule.Node, messageId: "method", data: { method: name, instead: REMOVED_METHODS[name] } });
        }
      },
    } as ESLintRule.RuleListener;
  },
};

const TOOL_PROPERTIES = new Set(["name", "title", "description", "inputSchema", "execute", "annotations"]);

/** What a stray key most likely meant. */
const TOOL_PROPERTY_HINTS: Record<string, string> = {
  exposedTo: "it belongs in the options argument: registerTool(tool, { exposedTo })",
  signal: "it belongs in the options argument: registerTool(tool, { signal })",
  parameters: 'write "inputSchema"',
  input_schema: 'write "inputSchema"',
  inputschema: 'write "inputSchema"',
  schema: 'write "inputSchema"',
  arguments: 'write "inputSchema"',
  handler: 'write "execute"',
  run: 'write "execute"',
  call: 'write "execute"',
  fn: 'write "execute"',
  callback: 'write "execute"',
  desc: 'write "description"',
  label: 'write "title"',
  hints: 'write "annotations"',
  readOnlyHint: "hints go under annotations: { readOnlyHint }",
  consequentialHint: "hints go under annotations: { consequentialHint }",
  untrustedContentHint: "hints go under annotations: { untrustedContentHint }",
  outputSchema: "the specification has no output schema yet; the API drops it",
};

export const noUnknownToolProperties: ESLintRule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "A tool definition has name, title, description, inputSchema, execute and annotations; the API silently drops anything else.",
      url: DOCS,
    },
    schema: [{ type: "object", properties: { allow: { type: "array", items: { type: "string" } } }, additionalProperties: false }],
    messages: { unknown: 'Tool definitions have no "{{name}}" property; the API drops it{{hint}}.' },
  },
  create(context) {
    const allow = new Set(((context.options[0] as { allow?: string[] } | undefined)?.allow ?? []) as string[]);
    const sites = definitionSites(context.settings);
    const resolve = makeResolver(context.sourceCode);
    return {
      CallExpression(node) {
        for (const { node: obj } of toolObjectsFromCall(node as ESTree.CallExpression, sites, resolve)) {
          for (const prop of obj.properties) {
            if (prop.type !== "Property") continue;
            const name = propertyName(prop);
            if (name === undefined || TOOL_PROPERTIES.has(name) || allow.has(name)) continue;
            const hint = TOOL_PROPERTY_HINTS[name];
            context.report({ node: prop.key as ESLintRule.Node, messageId: "unknown", data: { name, hint: hint ? `; ${hint}` : "" } });
          }
        }
      },
    } as ESLintRule.RuleListener;
  },
};

const OPTIONS: Record<string, { argument: number; keys: string[] }> = {
  registerTool: { argument: 1, keys: ["signal", "exposedTo"] },
  getTools: { argument: 0, keys: ["fromOrigins"] },
  executeTool: { argument: 2, keys: ["signal"] },
};

export const noUnknownOptions: ESLintRule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "registerTool() options are signal and exposedTo, getTools() takes fromOrigins, executeTool() takes signal; the API silently drops anything else.",
      url: DOCS,
    },
    schema: [],
    messages: { unknown: '{{method}}() has no "{{name}}" option; it takes {{keys}}.' },
  },
  create(context) {
    const resolve = makeResolver(context.sourceCode);
    return {
      CallExpression(node) {
        const method = calleeMethod(node as ESTree.CallExpression);
        if (!method || !(method in OPTIONS)) return;
        const callee = unwrap((node as ESTree.CallExpression).callee as ESTree.Node);
        if (callee.type !== "MemberExpression") return;
        const spec = OPTIONS[method];
        const arg = (node as ESTree.CallExpression).arguments[spec.argument];
        if (!arg || arg.type === "SpreadElement") return;
        const obj = unwrap(resolve(arg));
        if (obj.type !== "ObjectExpression") return;
        for (const prop of obj.properties) {
          if (prop.type !== "Property") continue;
          const name = propertyName(prop);
          if (name === undefined || spec.keys.includes(name)) continue;
          context.report({ node: prop.key as ESLintRule.Node, messageId: "unknown", data: { method, name, keys: spec.keys.join(" and ") } });
        }
      },
    } as ESLintRule.RuleListener;
  },
};

const NOT_CALLABLE = new Set(["Literal", "ObjectExpression", "ArrayExpression", "TemplateLiteral"]);

export const requireExecute: ESLintRule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "registerTool() needs an execute callback; a definition without one, or with a value that cannot be called, is rejected.", url: DOCS },
    schema: [],
    messages: {
      missing: 'Tool "{{name}}" has no execute callback; registerTool() rejects it.',
      notCallable: "execute must be a function; this value cannot be called.",
    },
  },
  create(context) {
    const resolve = makeResolver(context.sourceCode);
    // The API itself, not wrappers: a wrapper may supply execute on the tool's behalf.
    const sites = definitionSites(context.settings).filter((site) => site.call === "registerTool");
    return {
      CallExpression(node) {
        for (const { node: obj } of toolObjectsFromCall(node as ESTree.CallExpression, sites, resolve)) {
          if (obj.properties.some((p) => p.type === "SpreadElement")) continue;
          const execute = findProperty(obj, "execute");
          if (!execute) {
            const nameProp = findProperty(obj, "name");
            const name = nameProp && nameProp.value.type === "Literal" ? String(nameProp.value.value) : "?";
            context.report({ node: obj as ESLintRule.Node, messageId: "missing", data: { name } });
            continue;
          }
          if (execute.method || execute.kind !== "init" || execute.value.type === "AssignmentPattern") continue;
          const value = unwrap(resolve(execute.value as ESTree.Node));
          if (NOT_CALLABLE.has(value.type) || (value.type === "Identifier" && value.name === "undefined")) {
            context.report({ node: execute.value as ESLintRule.Node, messageId: "notCallable" });
          }
        }
      },
    } as ESLintRule.RuleListener;
  },
};

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

const METHODS = new Set(["registerTool", "getTools", "executeTool", "addEventListener", "removeEventListener", "dispatchEvent"]);

export const noUnboundMethod: ESLintRule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "ModelContext methods need their receiver; a destructured or detached registerTool() throws an illegal-invocation TypeError.",
      url: DOCS,
    },
    schema: [],
    messages: { unbound: "{{method}}() loses its ModelContext receiver here and throws when called; call document.modelContext.{{method}}() or bind it." },
  },
  create(context) {
    const resolve = makeResolver(context.sourceCode);
    return {
      MemberExpression(node) {
        const name = memberName(node);
        if (!name || !METHODS.has(name) || !isModelContext(node.object as ESTree.Node, resolve)) return;
        const parent = (node as WithParent).parent;
        if (!parent) return;
        if (parent.type === "CallExpression" && parent.callee === node) return;
        // `.bind(mc)`, `.call(mc, ...)`, `.apply(mc, ...)` keep the receiver.
        if (parent.type === "MemberExpression" && parent.object === node) {
          const next = memberName(parent);
          if (next === "bind" || next === "call" || next === "apply") return;
        }
        context.report({ node: node as ESLintRule.Node, messageId: "unbound", data: { method: name } });
      },
      VariableDeclarator(node) {
        const declarator = node as ESTree.VariableDeclarator;
        if (declarator.id.type !== "ObjectPattern" || !declarator.init || !isModelContext(declarator.init as ESTree.Node, resolve)) return;
        for (const prop of declarator.id.properties) {
          if (prop.type !== "Property") continue;
          const name = propertyName(prop);
          if (name && METHODS.has(name)) context.report({ node: prop as ESLintRule.Node, messageId: "unbound", data: { method: name } });
        }
      },
    } as ESLintRule.RuleListener;
  },
};
