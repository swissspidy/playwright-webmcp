/**
 * Declarative tools written as JSX: `<form toolname="..." tooldescription="...">`
 * with named fields, as React and other JSX frameworks render them. The form
 * is turned into the same declarative snapshot the browser collector
 * produces, so the `declarative-*` rules judge it statically.
 */
import type * as ESTree from "estree";
import type { DeclarativeField, DeclarativeInfo, JsonSchema, ToolDefinitionLike } from "webmcp-lint";
import { DYNAMIC, staticValue, type Resolver } from "./extract.js";

// ESTree has no JSX node types; these are the parts read here (espree, @typescript-eslint and oxc agree on them).
export interface JSXIdentifierNode {
  type: "JSXIdentifier";
  name: string;
}
export interface JSXAttributeNode {
  type: "JSXAttribute";
  name: JSXIdentifierNode | { type: "JSXNamespacedName"; namespace: JSXIdentifierNode; name: JSXIdentifierNode };
  value: null | ESTree.Literal | { type: "JSXExpressionContainer"; expression: ESTree.Node | { type: "JSXEmptyExpression" } } | JSXElementNode;
}
export interface JSXOpeningElementNode {
  type: "JSXOpeningElement";
  name: JSXIdentifierNode | { type: string };
  attributes: Array<JSXAttributeNode | { type: "JSXSpreadAttribute" }>;
}
export interface JSXElementNode {
  type: "JSXElement";
  openingElement: JSXOpeningElementNode;
  children: unknown[];
}

export interface ExtractedForm {
  node: JSXElementNode;
  definition: ToolDefinitionLike;
  /** Opening elements of the fields, by field name, for locating findings. */
  fieldNodes: Map<string, JSXOpeningElementNode>;
  /**
   * What could not be read statically: "description" for a computed
   * `tooldescription`, and "/properties/<field>" for a field with a spread or
   * a computed `toolparamdescription`. Findings about these are not reported.
   */
  dynamic: Set<string>;
}

function tagName(el: JSXElementNode): string | undefined {
  const name = el.openingElement.name;
  return name.type === "JSXIdentifier" ? (name as JSXIdentifierNode).name : undefined;
}

function attributeName(attr: JSXAttributeNode): string {
  return attr.name.type === "JSXIdentifier" ? attr.name.name.toLowerCase() : `${attr.name.namespace.name}:${attr.name.name.name}`.toLowerCase();
}

/** Attribute value as static data: `true` for a bare attribute, DYNAMIC when computed, undefined when absent. */
function attribute(el: JSXOpeningElementNode, name: string, resolve: Resolver): unknown {
  for (const attr of el.attributes) {
    if (attr.type !== "JSXAttribute" || attributeName(attr) !== name.toLowerCase()) continue;
    if (attr.value === null) return true;
    if (attr.value.type === "Literal") return attr.value.value;
    if (attr.value.type === "JSXExpressionContainer") {
      const expression = attr.value.expression;
      if (expression.type === "JSXEmptyExpression") return undefined;
      return staticValue(expression as ESTree.Node, resolve);
    }
    return DYNAMIC;
  }
  return undefined;
}

/** Whether a boolean-ish attribute was written with a static value: bare, or any string. */
function isPresent(value: unknown): boolean {
  return value === true || typeof value === "string";
}

function hasSpread(el: JSXOpeningElementNode): boolean {
  return el.attributes.some((a) => a.type === "JSXSpreadAttribute");
}

/** JSX elements inside a node, in document order, not descending into nested forms. */
export function* elementsWithin(node: unknown, seen = new Set<unknown>()): Generator<JSXElementNode> {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) yield* elementsWithin(item, seen);
    return;
  }
  const record = node as Record<string, unknown>;
  if (record.type === "JSXElement") {
    const el = record as unknown as JSXElementNode;
    yield el;
    if (tagName(el) === "form") return;
    yield* elementsWithin(el.children, seen);
    return;
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    if (value && typeof value === "object") yield* elementsWithin(value, seen);
  }
}

const SKIPPED_TYPES = new Set(["submit", "button", "reset", "hidden", "image"]);

/** Extract a declarative tool from a `<form toolname>` element, or undefined when it is not one. */
export function formTool(el: JSXElementNode, resolve: Resolver): ExtractedForm | undefined {
  if (tagName(el) !== "form") return undefined;
  const opening = el.openingElement;
  const name = attribute(opening, "toolname", resolve);
  if (typeof name !== "string") return undefined;
  const description = attribute(opening, "tooldescription", resolve);
  const autosubmit = attribute(opening, "toolautosubmit", resolve);

  const fields: DeclarativeField[] = [];
  const fieldNodes = new Map<string, JSXOpeningElementNode>();
  const dynamic = new Set<string>();
  if (description === DYNAMIC) dynamic.add("description");
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const labelledIds = new Set<string>();
  const labelledNames = new Set<string>();

  // First pass: labels. <label htmlFor="id"> and fields wrapped in <label>.
  for (const child of elementsWithin(el.children)) {
    if (tagName(child) !== "label") continue;
    const htmlFor = attribute(child.openingElement, "htmlFor", resolve) ?? attribute(child.openingElement, "for", resolve);
    if (typeof htmlFor === "string") labelledIds.add(htmlFor);
    for (const inner of elementsWithin(child.children)) {
      const innerName = attribute(inner.openingElement, "name", resolve);
      if (typeof innerName === "string") labelledNames.add(innerName);
    }
  }

  for (const child of elementsWithin(el.children)) {
    const tag = tagName(child);
    if (tag !== "input" && tag !== "select" && tag !== "textarea") continue;
    const fieldName = attribute(child.openingElement, "name", resolve);
    if (typeof fieldName !== "string" || !fieldName) continue;
    const typeAttr = tag === "input" ? attribute(child.openingElement, "type", resolve) : undefined;
    const type = tag === "input" ? (typeof typeAttr === "string" ? typeAttr.toLowerCase() : typeAttr === DYNAMIC ? "text" : "text") : tag;
    if (SKIPPED_TYPES.has(type)) continue;
    const id = attribute(child.openingElement, "id", resolve);
    const paramDescriptionValue = attribute(child.openingElement, "toolparamdescription", resolve);
    const paramDescription = typeof paramDescriptionValue === "string" ? paramDescriptionValue : undefined;
    const ariaLabel = attribute(child.openingElement, "aria-label", resolve);
    const ariaLabelledBy = attribute(child.openingElement, "aria-labelledby", resolve);
    const requiredValue = attribute(child.openingElement, "required", resolve);
    // Anything computed or spread onto the element may carry a label; findings about the field are dropped.
    if (hasSpread(child.openingElement) || paramDescriptionValue === DYNAMIC || ariaLabel === DYNAMIC || ariaLabelledBy === DYNAMIC) {
      dynamic.add(`/properties/${fieldName}`);
    }
    const hasLabel = isPresent(ariaLabel) || isPresent(ariaLabelledBy) || (typeof id === "string" && labelledIds.has(id)) || labelledNames.has(fieldName);
    // A boolean attribute is present whatever its value, as in HTML (`required="false"` still requires).
    const isRequired = isPresent(requiredValue) || requiredValue === DYNAMIC;
    fields.push({ name: fieldName, type, required: isRequired, hasLabel, paramDescription });
    fieldNodes.set(fieldName, child.openingElement);
    const prop: JsonSchema = { type: type === "number" || type === "range" ? "number" : type === "checkbox" ? "boolean" : "string" };
    if (paramDescription) prop.description = paramDescription;
    properties[fieldName] = prop;
    if (isRequired) required.push(fieldName);
  }

  const schema: JsonSchema = { type: "object", properties };
  if (required.length) schema.required = required;
  const info: DeclarativeInfo = {
    formLocator: `form[toolname="${name}"]`,
    autosubmit: isPresent(autosubmit),
    hasDescription: typeof description === "string" && description.trim().length > 0,
    fields,
  };
  return {
    node: el,
    definition: {
      name,
      description: typeof description === "string" ? description : "",
      inputSchema: schema,
      source: "declarative",
      declarative: info,
    },
    fieldNodes,
    dynamic,
  };
}
