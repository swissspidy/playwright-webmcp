/**
 * In-page snapshot collector. This function is serialised and evaluated
 * inside every frame by the Playwright fixture, so it must be self contained:
 * no imports, no closures over module state.
 */
import type { DeclarativeField, FrameSnapshot, ToolSnapshot } from "./types.js";

export interface FrameCollectResult {
  frame: Omit<FrameSnapshot, "allow" | "crossOriginFromTop">;
  tools: Omit<ToolSnapshot, "frame">[];
}

export async function collectFrame(): Promise<FrameCollectResult> {
  const w = window as unknown as Record<string, any>;
  const d = document as unknown as Record<string, any>;
  const api = d.modelContext ?? w.navigator?.modelContext ?? null;
  const shim = Boolean(api && api.__webmcpShim);
  const frame = {
    url: location.href,
    origin: location.origin,
    isTop: window === window.top,
    api: (api ? (shim ? "shim" : "native") : "none") as FrameSnapshot["api"],
  };

  const declarativeByName = new Map<string, ReturnType<typeof describeForm>>();
  document.querySelectorAll("form[toolname]").forEach((form, index) => {
    const info = describeForm(form as HTMLFormElement, index);
    declarativeByName.set(info.name, info);
  });

  const tools: Omit<ToolSnapshot, "frame">[] = [];
  let listed: any[] = [];
  if (api && typeof api.getTools === "function") {
    try {
      listed = (await api.getTools()) ?? [];
    } catch {
      listed = [];
    }
  }
  const seen = new Set<string>();
  for (const t of listed) {
    // Only report tools owned by this frame; parent/child tools are collected in their own frames.
    if (t && t.window && t.window !== window) continue;
    const decl = declarativeByName.get(t.name);
    seen.add(t.name);
    tools.push({
      name: String(t.name ?? ""),
      description: String(t.description ?? ""),
      inputSchema: safeJson(t.inputSchema),
      annotations: safeJson(t.annotations) ?? undefined,
      origin: String(t.origin ?? location.origin),
      source: decl ? "declarative" : "imperative",
      hasExecute: typeof t.execute === "function" || typeof t._execute === "function" ? true : decl ? true : undefined,
      declarative: decl ? decl.info : undefined,
    });
  }
  // Declarative forms the API implementation did not surface (no API at all, or native support missing).
  for (const [name, decl] of declarativeByName) {
    if (seen.has(name)) continue;
    tools.push({
      name,
      description: decl.description,
      inputSchema: decl.schema,
      origin: location.origin,
      source: "declarative",
      hasExecute: true,
      declarative: decl.info,
    });
  }
  return { frame, tools };

  function safeJson(v: unknown): Record<string, unknown> | null {
    if (v === undefined || v === null) return null;
    try {
      return JSON.parse(JSON.stringify(v));
    } catch {
      return null;
    }
  }

  function hasLabel(el: Element): boolean {
    if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")) return true;
    if (el.closest("label")) return true;
    const id = el.getAttribute("id");
    if (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) return true;
    return false;
  }

  function describeForm(form: HTMLFormElement, index: number) {
    const name = form.getAttribute("toolname") ?? "";
    const description = form.getAttribute("tooldescription") ?? "";
    const fields: DeclarativeField[] = [];
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];
    const elements = Array.from(form.elements) as Element[];
    for (const el of elements) {
      const tag = el.tagName.toLowerCase();
      const fieldName = el.getAttribute("name");
      if (!fieldName) continue;
      const type = tag === "input" ? (el.getAttribute("type") ?? "text").toLowerCase() : tag;
      if (type === "submit" || type === "button" || type === "reset" || type === "hidden" || tag === "button" || tag === "fieldset") continue;
      const paramDescription = el.getAttribute("toolparamdescription") ?? undefined;
      const options = tag === "select" ? Array.from((el as HTMLSelectElement).options).map((o) => o.value) : undefined;
      const isRequired = el.hasAttribute("required");
      fields.push({ name: fieldName, type, required: isRequired, hasLabel: hasLabel(el), paramDescription, options });
      const prop: Record<string, unknown> = {};
      if (type === "number" || type === "range") prop.type = "number";
      else if (type === "checkbox") prop.type = "boolean";
      else prop.type = "string";
      if (paramDescription) prop.description = paramDescription;
      if (options) prop.enum = options;
      const min = el.getAttribute("min");
      const max = el.getAttribute("max");
      const pattern = el.getAttribute("pattern");
      if (min !== null && prop.type === "number") prop.minimum = Number(min);
      if (max !== null && prop.type === "number") prop.maximum = Number(max);
      if (pattern) prop.pattern = pattern;
      properties[fieldName] = prop;
      if (isRequired) required.push(fieldName);
    }
    const schema: Record<string, unknown> = { type: "object", properties };
    if (required.length) schema.required = required;
    const id = form.getAttribute("id");
    return {
      name,
      description,
      schema,
      info: {
        formLocator: id ? `form#${id}` : `form[toolname="${name}"]:nth-of-type(${index + 1})`,
        autosubmit: form.hasAttribute("toolautosubmit"),
        hasDescription: Boolean(description.trim()),
        fields,
      },
    };
  }
}
