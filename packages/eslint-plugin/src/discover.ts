/**
 * Which object literals in a file are tool definitions. Two ways in:
 *
 * - Passed to a definition site (`registerTool()`, `useWebMCP()`, the calls
 *   named in settings), directly or through a `const`.
 * - Shaped like one anywhere else: a literal string `name`, an `execute` and an
 *   `inputSchema`, or any object typed as `ModelContextTool`. This is how a
 *   tool reads when it is defined in one module and registered in another:
 *
 *     export const searchFlightsTool = { name: "searchFlights", inputSchema: {...}, execute };
 *
 *   `name`, `description` and `execute` alone also describe CLI commands and
 *   chat commands, so `inputSchema` (or the type) is what tips it. Projects
 *   whose own objects match can turn this off with
 *   `settings.webmcp.toolObjects: false`.
 *
 * Each literal is handed over once, whichever way it was found.
 */
import type { Rule as ESLintRule } from "eslint";
import type * as ESTree from "estree";
import { findProperty, staticValue, toolObjectsFromCall, type Resolver, type ToolObject } from "./extract.js";
import { definitionSites, toolObjectsEnabled } from "./settings.js";

type WithParent = ESTree.Node & { parent?: WithParent };

const TOOL_TYPES = new Set(["ModelContextTool"]);

/** The name of a TypeScript type reference, `ModelContextTool` or `WebMCP.ModelContextTool`. */
function typeName(annotation: unknown): string | undefined {
  const t = annotation as { type?: string; typeName?: { type: string; name?: string; right?: { name?: string } } } | undefined;
  if (t?.type !== "TSTypeReference" || !t.typeName) return undefined;
  return t.typeName.type === "TSQualifiedName" ? t.typeName.right?.name : t.typeName.name;
}

const TS_WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion"]);

/**
 * True when the literal is written as a `ModelContextTool`: `x satisfies T`,
 * `x as T`, or `const x: T = ...`, through any other wrappers on the way
 * (`{...} as const satisfies T`, `const x: T = {...} as const`).
 */
function typedAsTool(obj: ESTree.ObjectExpression): boolean {
  type Wrapper = WithParent & { typeAnnotation?: unknown; init?: unknown; id?: { typeAnnotation?: { typeAnnotation?: unknown } } };
  let node = obj as WithParent;
  let parent = node.parent as Wrapper | undefined;
  while (parent && TS_WRAPPERS.has(parent.type)) {
    if (TOOL_TYPES.has(typeName(parent.typeAnnotation) ?? "")) return true;
    node = parent;
    parent = node.parent as Wrapper | undefined;
  }
  return parent?.type === "VariableDeclarator" && parent.init === node && TOOL_TYPES.has(typeName(parent.id?.typeAnnotation?.typeAnnotation) ?? "");
}

/**
 * A literal typed `ModelContextTool` is a tool whatever its name holds (a
 * computed name is what no-interpolated-text is for). Otherwise it takes a
 * literal `name`, an `execute` and an `inputSchema`.
 */
export function isToolShaped(obj: ESTree.ObjectExpression, resolve: Resolver): boolean {
  if (typedAsTool(obj)) return true;
  const name = findProperty(obj, "name");
  if (!name || typeof staticValue(name.value as ESTree.Node, resolve) !== "string") return false;
  return !!findProperty(obj, "execute") && !!findProperty(obj, "inputSchema");
}

/**
 * Listener entries that call `onTool` once for every tool definition literal
 * in the file. Merge them into a rule's own listener.
 *
 * A literal registered again, with options of its own, comes back with
 * `repeat` set when `repeats` is on: its definition was already judged, but
 * that call's `exposedTo` was not.
 */
export function discoverTools(
  context: ESLintRule.RuleContext,
  resolve: Resolver,
  onTool: (tool: ToolObject, repeat: boolean) => void,
  { repeats = false }: { repeats?: boolean } = {},
): Required<Pick<ESLintRule.RuleListener, "CallExpression" | "ObjectExpression" | "Program:exit">> {
  const sites = definitionSites(context.settings);
  const shaped = toolObjectsEnabled(context.settings);
  const seen = new Set<ESTree.ObjectExpression>();
  const candidates: ESTree.ObjectExpression[] = [];
  return {
    CallExpression(node) {
      for (const tool of toolObjectsFromCall(node as ESTree.CallExpression, sites, resolve)) {
        if (seen.has(tool.node)) {
          if (repeats && tool.exposedTo.node) onTool(tool, true);
          continue;
        }
        seen.add(tool.node);
        onTool(tool, false);
      }
    },
    ObjectExpression(node) {
      if (shaped) candidates.push(node as ESTree.ObjectExpression);
    },
    // A literal defined above the call that registers it is only known to be a
    // definition site's argument once that call has been visited.
    "Program:exit"() {
      for (const obj of candidates) {
        if (seen.has(obj) || !isToolShaped(obj, resolve)) continue;
        seen.add(obj);
        onTool({ node: obj, exposedTo: { value: undefined } }, false);
      }
    },
  };
}
