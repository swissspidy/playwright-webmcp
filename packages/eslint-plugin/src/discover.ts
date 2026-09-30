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

/** True when the literal is written as a `ModelContextTool`: `x satisfies T`, `x as T`, or `const x: T = ...`. */
function typedAsTool(obj: ESTree.ObjectExpression): boolean {
  const parent = (obj as WithParent).parent as (WithParent & { typeAnnotation?: unknown; id?: { typeAnnotation?: { typeAnnotation?: unknown } } }) | undefined;
  if (!parent) return false;
  if (parent.type === ("TSSatisfiesExpression" as string) || parent.type === ("TSAsExpression" as string))
    return TOOL_TYPES.has(typeName(parent.typeAnnotation) ?? "");
  if (parent.type === "VariableDeclarator") return TOOL_TYPES.has(typeName(parent.id?.typeAnnotation?.typeAnnotation) ?? "");
  return false;
}

export function isToolShaped(obj: ESTree.ObjectExpression, resolve: Resolver): boolean {
  const name = findProperty(obj, "name");
  if (!name || typeof staticValue(name.value as ESTree.Node, resolve) !== "string") return false;
  if (typedAsTool(obj)) return true;
  return !!findProperty(obj, "execute") && !!findProperty(obj, "inputSchema");
}

/**
 * Listener entries that call `onTool` once for every tool definition literal
 * in the file. Merge them into a rule's own listener.
 */
export function discoverTools(
  context: ESLintRule.RuleContext,
  resolve: Resolver,
  onTool: (tool: ToolObject) => void,
): Required<Pick<ESLintRule.RuleListener, "CallExpression" | "ObjectExpression" | "Program:exit">> {
  const sites = definitionSites(context.settings);
  const shaped = toolObjectsEnabled(context.settings);
  const seen = new Set<ESTree.ObjectExpression>();
  const candidates: ESTree.ObjectExpression[] = [];
  return {
    CallExpression(node) {
      for (const tool of toolObjectsFromCall(node as ESTree.CallExpression, sites, resolve)) {
        if (seen.has(tool.node)) continue;
        seen.add(tool.node);
        onTool(tool);
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
        onTool({ node: obj, exposedTo: { value: undefined } });
      }
    },
  };
}
