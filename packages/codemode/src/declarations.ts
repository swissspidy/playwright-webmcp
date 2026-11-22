/**
 * TypeScript declarations for the sandbox API, generated from the tools a
 * page has registered right now. The model reads these, not a compiler, so
 * the goal is a faithful, compact description rather than perfect typing.
 */
import type { ToolInfo } from "./registry.js";

const IDENT = /^[A-Za-z_$][\w$]*$/;

type Schema = Record<string, any>;

export function schemaToTs(schema: unknown, indent = ""): string {
  if (!schema || typeof schema !== "object") return "unknown";
  const s = schema as Schema;
  if ("const" in s) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ") || "never";
  const union = s.anyOf ?? s.oneOf;
  if (Array.isArray(union)) return union.map((u: unknown) => schemaToTs(u, indent)).join(" | ") || "unknown";
  if (Array.isArray(s.allOf)) return s.allOf.map((u: unknown) => schemaToTs(u, indent)).join(" & ") || "unknown";
  if (Array.isArray(s.type)) return s.type.map((t: string) => schemaToTs({ ...s, type: t }, indent)).join(" | ");
  switch (s.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const item = schemaToTs(s.items, indent);
      return /[|&]/.test(item) ? `Array<${item}>` : `${item}[]`;
    }
    case "object":
    case undefined:
      if (s.type === undefined && !s.properties) return "unknown";
      return objectToTs(s, indent);
    default:
      return "unknown";
  }
}

function objectToTs(s: Schema, indent: string): string {
  const props = s.properties && typeof s.properties === "object" ? Object.entries(s.properties as Record<string, Schema>) : [];
  const extra = s.additionalProperties;
  if (!props.length) {
    // An explicit empty property list means "no arguments" unless extra properties are allowed.
    if (extra === false || (s.properties && !extra)) return "{}";
    return `Record<string, ${extra && typeof extra === "object" ? schemaToTs(extra, indent) : "unknown"}>`;
  }
  const required = new Set<string>(Array.isArray(s.required) ? s.required : []);
  const inner = indent + "  ";
  const lines = ["{"];
  for (const [name, prop] of props) {
    const doc = docComment(prop, inner);
    if (doc) lines.push(doc);
    lines.push(`${inner}${propName(name)}${required.has(name) ? "" : "?"}: ${schemaToTs(prop, inner)};`);
  }
  if (extra && typeof extra === "object") lines.push(`${inner}[key: string]: ${schemaToTs(extra, inner)};`);
  lines.push(`${indent}}`);
  return lines.join("\n");
}

function docComment(prop: Schema, indent: string): string {
  const parts: string[] = [];
  if (typeof prop?.description === "string" && prop.description.trim()) parts.push(prop.description.trim());
  if (prop?.default !== undefined) parts.push(`@default ${JSON.stringify(prop.default)}`);
  for (const k of ["minimum", "maximum", "minLength", "maxLength", "pattern", "format"]) {
    if (prop?.[k] !== undefined) parts.push(`@${k} ${typeof prop[k] === "string" ? prop[k] : JSON.stringify(prop[k])}`);
  }
  if (!parts.length) return "";
  const text = parts.join("\n").replaceAll("*/", "*\\/");
  if (!text.includes("\n")) return `${indent}/** ${text} */`;
  return [`${indent}/**`, ...text.split("\n").map((l) => `${indent} * ${l}`), `${indent} */`].join("\n");
}

function propName(name: string): string {
  return IDENT.test(name) ? name : JSON.stringify(name);
}

function toolHints(tool: PageTool): string[] {
  const a = tool.annotations ?? {};
  const hints: string[] = [];
  if (a.readOnly) hints.push("read-only");
  if (a.consequential) hints.push("consequential: may need approval");
  if (a.untrustedContent) hints.push("returns untrusted content");
  return hints;
}

/**
 * Each tool's declaration-relevant fields by name (the first registration of a name wins, as in the
 * declarations), as comparable strings. Two tool lists with the same map produce the same API.
 */
export function toolDefinitions(tools: ToolInfo[]): Map<string, string> {
  const defs = new Map<string, string>();
  for (const t of tools) {
    if (defs.has(t.name)) continue;
    defs.set(t.name, JSON.stringify([t.description, t.inputSchema ?? null, t.outputSchema ?? null, t.annotations ?? null]));
  }
  return defs;
}

/** A tool as a page registered it, without the browser's ids. */
export type PageTool = Pick<ToolInfo, "name" | "description" | "inputSchema" | "outputSchema" | "annotations">;

/** A page code mode has seen, and the tools it registered then. */
export interface KnownPage {
  /** The page's key: origin, path and hash route, without the query string (see `pageKey`). */
  page: string;
  /** The URL it was last seen at. */
  url: string;
  /** Every tool seen on the page, with its latest definition: a page's tools can depend on its state. */
  tools: PageTool[];
  /** Tool calls that navigated here, and the page they were made on. */
  via: Array<{ tool: string; from: string }>;
}

/**
 * The key pages are remembered under: origin, path and hash route (`#/search`), without the query
 * string, so `product?id=2` and `product?id=3` count as one page.
 */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    const route = u.hash.split("?")[0];
    return u.origin + u.pathname + (route.startsWith("#/") ? route : "");
  } catch {
    return url;
  }
}

export interface DeclarationOptions {
  url: string;
  toolWaitMs: number;
  /** Only the page URL and the `tools` declaration. */
  compact?: boolean;
  /** Other pages seen before, listed after the API (not in compact declarations). */
  knownPages?: KnownPage[];
}

function toolMembers(tools: PageTool[], indent: string): string[] {
  const seen = new Set<string>();
  const members: string[] = [];
  for (const tool of tools) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    const doc = [tool.description.trim(), ...toolHints(tool).map((h) => `(${h})`)].filter(Boolean).join("\n");
    if (doc) members.push(docComment({ description: doc }, indent));
    const schema = tool.inputSchema ?? { type: "object", properties: {} };
    const args = schemaToTs(schema, indent);
    const optional = !(Array.isArray(schema.required) && schema.required.length);
    const output = tool.outputSchema ? schemaToTs(tool.outputSchema, indent) : "unknown";
    members.push(`${indent}${propName(tool.name)}(args${optional ? "?" : ""}: ${args}): Promise<${output}>;`);
  }
  return members;
}

function knownPagesDeclaration(pages: KnownPage[]): string {
  if (!pages.length) return "";
  const entries = pages.map((p) => {
    const via = p.via.map((v) => `tools.${v.tool}() on ${v.from}`).join(", ");
    return [
      docComment({ description: `Seen at ${p.url}${via ? `\nReached by ${via}` : ""}` }, "  "),
      `  ${JSON.stringify(p.page)}: {`,
      ...toolMembers(p.tools, "    "),
      "  };",
    ].join("\n");
  });
  return `
// Other pages seen before, with every tool they registered while seen (some may appear only once another
// has been used). Their tools are not on \`tools\` yet, but
// once a call navigates to one of these pages, keep going in the same script and call that page's tools
// as tools.<name>(). Pages can change: a tool that is gone throws ToolUnavailableError.
type KnownPages = {
${entries.join("\n")}
};
`;
}

export function declarations(tools: ToolInfo[], { url, toolWaitMs, compact, knownPages }: DeclarationOptions): string {
  const members = toolMembers(tools, "  ");
  if (compact)
    return `// Page: ${url}\ndeclare const tools: {\n${members.join("\n")}${members.length ? "\n" : ""}  [name: string]: (args?: Record<string, unknown>) => Promise<unknown>;\n};\n`;
  return `// Page: ${url}
// Tools are the page's WebMCP tools, called by name. A call waits up to ${toolWaitMs} ms for its tool to be
// registered, so it works right after a navigation. Results are the tool's output; text content that holds
// JSON is parsed. A call cut short because the page navigated away resolves to { navigated: true, url }.
// Errors: ToolUnavailableError (not registered; .available lists what is), ToolError, ToolDeniedError.
declare const tools: {
${members.join("\n")}${members.length ? "\n" : ""}  /** Tools the next page registers are callable by name too. */
  [name: string]: (args?: Record<string, unknown>) => Promise<unknown>;
};

/** Alias of \`tools\`, for scripts written for Cloudflare's codemode. */
declare const codemode: typeof tools;

declare const browser: {
  /** Current page URL. */
  url(): Promise<string>;
  /** Tools registered right now, with descriptions and input schemas. */
  tools(): Promise<Array<{ name: string; description: string; inputSchema?: object; annotations?: object }>>;
  /** Navigate (relative URLs resolve against the current page) and wait for the load event. */
  goto(url: string): Promise<void>;
  back(): Promise<boolean>;
  reload(): Promise<void>;
  /** Wait for a tool to be registered; resolves false on timeout. */
  waitForTool(name: string, options?: { timeoutMs?: number }): Promise<boolean>;
  sleep(ms: number): Promise<void>;
};

// console.log/info/warn/error output is returned alongside the result. Return a value to hand it back.
${knownPagesDeclaration(knownPages ?? [])}`;
}
