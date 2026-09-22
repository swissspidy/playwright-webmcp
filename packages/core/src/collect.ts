/**
 * In-page snapshot collector. This function is serialised and evaluated
 * inside every frame by the Playwright fixture, so it must be self contained:
 * no imports, no closures over module state.
 */
import type { DeclarativeField, FrameSnapshot, ToolSnapshot } from "./types.js";

export interface FrameCollectResult {
  frame: Omit<FrameSnapshot, "crossOriginFromTop">;
  tools: Omit<ToolSnapshot, "frame">[];
}

export async function collectFrame(options: { getToolsTimeoutMs?: number } = {}): Promise<FrameCollectResult> {
  const getToolsTimeoutMs = options.getToolsTimeoutMs ?? 3000;
  const d = document as unknown as Record<string, any>;
  const api = d.modelContext ?? null;
  const frame: FrameCollectResult["frame"] = {
    url: location.href,
    origin: location.origin,
    isTop: window === window.top,
    api: (api ? "native" : "none") as FrameSnapshot["api"],
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`getTools() did not settle within ${getToolsTimeoutMs} ms`)), getToolsTimeoutMs);
      });
      try {
        listed = (await Promise.race([api.getTools(), timeout])) ?? [];
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      listed = [];
      frame.error = `getTools() failed: ${String((err as Error)?.message ?? err)}`;
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
      title: typeof t.title === "string" && t.title ? t.title : undefined,
      description: String(t.description ?? ""),
      inputSchema: safeJson(fromJsonString(t.inputSchema)),
      annotations: safeJson(fromJsonString(t.annotations)) ?? undefined,
      origin: String(t.origin ?? location.origin),
      source: decl ? "declarative" : "imperative",
      hasExecute: typeof t.execute === "function" || typeof t._execute === "function" ? true : decl ? true : undefined,
      declarative: decl ? decl.info : undefined,
      exposedTo: Array.isArray(t.exposedTo) ? t.exposedTo.map(String) : undefined,
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

  // Chrome 154 and earlier handed inputSchema back as a JSON string; the specification (and Chrome since) says object.
  function fromJsonString(v: unknown): unknown {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }

  function safeJson(v: unknown): Record<string, unknown> | null {
    if (v === undefined || v === null) return null;
    try {
      return JSON.parse(JSON.stringify(v));
    } catch {
      return null;
    }
  }

  /**
   * The text a person sees next to the control: `aria-label`, the text of the
   * elements `aria-labelledby` names, a `<label for>`, or the wrapping label.
   * Chrome uses it as the parameter description when `toolparamdescription`
   * is absent, so the derived schema does the same.
   */
  function labelText(el: Element): string | undefined {
    const aria = el.getAttribute("aria-label");
    if (aria?.trim()) return aria.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ");
      if (text) return text;
    }
    const labels = (el as HTMLInputElement).labels ? Array.from((el as HTMLInputElement).labels!) : [];
    for (const label of labels) {
      const text = label.textContent?.trim();
      if (text) return text;
    }
    return undefined;
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
      const autocomplete = el.getAttribute("autocomplete") ?? undefined;
      const selectOptions = tag === "select" ? Array.from((el as HTMLSelectElement).options) : undefined;
      const options = selectOptions?.map((o) => o.value);
      const isRequired = el.hasAttribute("required");
      fields.push({ name: fieldName, type, required: isRequired, hasLabel: hasLabel(el), paramDescription, autocomplete, options });
      const prop: Record<string, unknown> = {};
      if (type === "number" || type === "range") prop.type = "number";
      else if (type === "checkbox") prop.type = "boolean";
      else prop.type = "string";
      const description = paramDescription ?? labelText(el);
      if (description) prop.description = description;
      if (selectOptions && options) {
        // Chrome derives one const per option, titled with the option label, plus the enum.
        prop.anyOf = selectOptions.map((o) => ({ type: "string", const: o.value, title: o.label || o.textContent || o.value }));
        prop.enum = options;
      }
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
