/**
 * Finds WebMCP tool definitions in a file and turns the static parts into
 * plain data the webmcp-lint rules can judge. Which calls count as
 * definition sites comes from ./settings.ts; by default:
 *
 *   x.registerTool({ name, description, inputSchema, annotations, execute }, { exposedTo })
 *   x.provideContext({ tools: [ { ... }, { ... } ] })
 *   useWebMCP({ name, description, inputSchema, execute })
 *
 * Only literal values are read. An identifier that refers to a `const` or
 * `let` initialised with a literal in the same file is followed (`const tool =
 * {...}; mc.registerTool(tool)`). A field whose value is computed (a call, a
 * spread, a template with expressions) is reported as dynamic so the rules
 * that depend on it can be skipped for that tool rather than produce false
 * findings.
 */
import type * as ESTree from "estree";
import type { ToolDefinitionLike } from "webmcp-lint";
import type { DefinitionSite } from "./settings.js";

type Node = ESTree.Node;

/** Marker for values that cannot be evaluated statically. */
export const DYNAMIC: unique symbol = Symbol("dynamic");
export type Static = unknown | typeof DYNAMIC;

/** Follows an expression to the node that holds its value, e.g. an identifier to its initialiser. Returns the input when it cannot. */
export type Resolver = (node: Node) => Node;

export interface ExtractedTool {
  /** The object literal that defines the tool. */
  node: ESTree.ObjectExpression;
  definition: ToolDefinitionLike;
  /** Top-level fields whose value was not a literal (the definition omits them). */
  dynamic: Set<string>;
  /** The `exposedTo` value in the options argument, when one was written. */
  exposedToNode?: Node;
}

const TS_WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion"]);

/** Unwrap TypeScript-only wrappers (`x as T`, `x satisfies T`, `x!`). */
export function unwrap(node: Node): Node {
  let n = node as { type: string; expression?: Node };
  while (TS_WRAPPERS.has(n.type) && n.expression) n = n.expression as typeof n;
  return n as Node;
}

const identity: Resolver = (node) => node;

function propertyKey(prop: ESTree.Property): string | undefined {
  if (prop.computed) {
    const key = prop.key;
    if (key.type === "Literal" && typeof key.value === "string") return key.value;
    if (key.type === "TemplateLiteral" && key.expressions.length === 0) return key.quasis[0]?.value.cooked ?? undefined;
    return undefined;
  }
  if (prop.key.type === "Identifier") return prop.key.name;
  if (prop.key.type === "Literal") return String(prop.key.value);
  return undefined;
}

/** Evaluate a literal expression tree to JSON-like data, or DYNAMIC. Functions become DYNAMIC. */
export function staticValue(input: Node, resolve: Resolver = identity): Static {
  const node = unwrap(resolve(input));
  switch (node.type) {
    case "Literal":
      if ("regex" in node && node.regex) return DYNAMIC;
      if ("bigint" in node && node.bigint) return DYNAMIC;
      return node.value;
    case "TemplateLiteral":
      return node.expressions.length === 0 ? (node.quasis[0]?.value.cooked ?? "") : DYNAMIC;
    case "Identifier":
      return node.name === "undefined" ? undefined : DYNAMIC;
    case "UnaryExpression": {
      const v = staticValue(node.argument, resolve);
      if (v === DYNAMIC) return DYNAMIC;
      if (node.operator === "-" && typeof v === "number") return -v;
      if (node.operator === "+" && typeof v === "number") return v;
      if (node.operator === "!") return !v;
      return DYNAMIC;
    }
    case "ArrayExpression": {
      const out: unknown[] = [];
      for (const el of node.elements) {
        if (!el || el.type === "SpreadElement") return DYNAMIC;
        const v = staticValue(el, resolve);
        if (v === DYNAMIC) return DYNAMIC;
        out.push(v);
      }
      return out;
    }
    case "ObjectExpression": {
      // Null-prototype so a literal `__proto__` key is data, not a prototype swap.
      const out: Record<string, unknown> = Object.create(null);
      for (const prop of node.properties) {
        if (prop.type !== "Property") return DYNAMIC;
        const key = propertyKey(prop);
        if (key === undefined) return DYNAMIC;
        // A method or accessor is code, not data; the object cannot be judged.
        if (prop.method || prop.kind !== "init") return DYNAMIC;
        const v = staticValue(prop.value as Node, resolve);
        if (v === DYNAMIC) return DYNAMIC;
        if (v !== undefined) out[key] = v;
      }
      return out;
    }
    default:
      return DYNAMIC;
  }
}

/** Find the property node for a key on an object literal. The last one wins, as it does at runtime. */
export function findProperty(obj: ESTree.ObjectExpression, key: string): ESTree.Property | undefined {
  for (let i = obj.properties.length - 1; i >= 0; i--) {
    const prop = obj.properties[i];
    if (prop.type === "Property" && propertyKey(prop) === key) return prop;
  }
  return undefined;
}

/** Follow a JSON-pointer-ish path ("/properties/query/description") through nested literals. */
export function nodeAtPath(obj: ESTree.ObjectExpression, path: string, resolve: Resolver = identity): Node | undefined {
  let current: Node = obj;
  for (const segment of path.split("/").filter(Boolean)) {
    const n = unwrap(resolve(current));
    if (n.type === "ObjectExpression") {
      const prop = findProperty(n, segment);
      if (!prop) return undefined;
      current = prop.value as Node;
    } else if (n.type === "ArrayExpression") {
      const el = n.elements[Number(segment)];
      if (!el || el.type === "SpreadElement") return undefined;
      current = el;
    } else return undefined;
  }
  return current;
}

const TOOL_FIELDS = ["name", "title", "description", "inputSchema", "annotations"] as const;

export interface ExposedTo {
  value: Static;
  node?: Node;
}

/** One tool definition literal found at a definition site, before it is read. */
export interface ToolObject {
  node: ESTree.ObjectExpression;
  exposedTo: ExposedTo;
}

function toolFromObject(obj: ESTree.ObjectExpression, exposedTo: ExposedTo, resolve: Resolver): ExtractedTool | undefined {
  const definition: ToolDefinitionLike = Object.assign(Object.create(null), { name: "" });
  const record = definition as Record<string, unknown>;
  const dynamic = new Set<string>();
  // Later properties override earlier ones, as they do at runtime.
  for (const prop of obj.properties) {
    if (prop.type !== "Property") {
      dynamic.add("*");
      continue;
    }
    const key = propertyKey(prop);
    if (key === undefined) {
      dynamic.add("*");
      continue;
    }
    if (!(TOOL_FIELDS as readonly string[]).includes(key)) continue;
    const v = prop.method || prop.kind !== "init" ? DYNAMIC : staticValue(prop.value as Node, resolve);
    if (v === DYNAMIC) {
      dynamic.add(key);
      delete record[key];
    } else {
      dynamic.delete(key);
      if (v === undefined) delete record[key];
      else record[key] = v;
    }
  }
  if (dynamic.has("name") || typeof definition.name !== "string") return undefined;
  if (exposedTo.value === DYNAMIC) dynamic.add("exposedTo");
  else if (Array.isArray(exposedTo.value)) definition.exposedTo = exposedTo.value.map(String);
  return { node: obj, definition, dynamic, exposedToNode: exposedTo.node };
}

function calleeName(callee: Node): string | undefined {
  const c = unwrap(callee);
  if (c.type === "Identifier") return c.name;
  if (c.type !== "MemberExpression") return undefined;
  if (c.computed) return c.property.type === "Literal" && typeof c.property.value === "string" ? c.property.value : undefined;
  return c.property.type === "Identifier" ? c.property.name : undefined;
}

function argumentAt(call: ESTree.CallExpression, index: number): Node | undefined {
  const arg = call.arguments[index];
  return arg && arg.type !== "SpreadElement" ? arg : undefined;
}

/**
 * The tool definition literals passed to one call expression, if it matches a
 * definition site, paired with the `exposedTo` written alongside them.
 *
 * Separate from `toolsFromCall` because a rule can care about a definition
 * that rule cannot read: a tool whose `name` is computed has no snapshot to
 * lint, but the computation itself may be the finding.
 */
export function toolObjectsFromCall(call: ESTree.CallExpression, sites: DefinitionSite[], resolve: Resolver = identity): ToolObject[] {
  const method = calleeName(call.callee as Node);
  if (!method) return [];
  const out: ToolObject[] = [];
  for (const site of sites) {
    if (site.call !== method) continue;
    const arg = argumentAt(call, site.argument ?? 0);
    if (!arg) continue;
    const exposedTo: ExposedTo = { value: undefined };
    if (site.options !== undefined) {
      const options = argumentAt(call, site.options);
      if (options) {
        const opts = unwrap(resolve(options));
        if (opts.type === "ObjectExpression") {
          const prop = findProperty(opts, "exposedTo");
          if (prop) {
            exposedTo.node = prop.value as Node;
            exposedTo.value = staticValue(exposedTo.node, resolve);
          }
        } else exposedTo.value = DYNAMIC;
      }
    }
    if (site.tools) {
      const ctx = unwrap(resolve(arg));
      if (ctx.type !== "ObjectExpression") continue;
      const tools = findProperty(ctx, site.tools);
      if (!tools) continue;
      const arr = unwrap(resolve(tools.value as Node));
      if (arr.type !== "ArrayExpression") continue;
      for (const el of arr.elements) {
        if (!el || el.type === "SpreadElement") continue;
        const item = unwrap(resolve(el));
        if (item.type === "ObjectExpression") out.push({ node: item, exposedTo });
      }
    } else {
      const obj = unwrap(resolve(arg));
      if (obj.type === "ObjectExpression") out.push({ node: obj, exposedTo });
    }
  }
  return out;
}

/** Tool definitions passed to one call expression, as data the lint rules can judge. */
export function toolsFromCall(call: ESTree.CallExpression, sites: DefinitionSite[], resolve: Resolver = identity): ExtractedTool[] {
  const out: ExtractedTool[] = [];
  for (const { node, exposedTo } of toolObjectsFromCall(call, sites, resolve)) {
    const extracted = toolFromObject(node, exposedTo, resolve);
    if (extracted) out.push(extracted);
  }
  return out;
}
