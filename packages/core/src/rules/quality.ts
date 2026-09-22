/**
 * Declarations that are syntactically fine and still say nothing, or say it
 * in a way the API will not read: placeholder text, annotation keys the
 * specification does not know (an MCP hint, or the CDP domain's spelling),
 * a missing title, a name that does not follow the project's convention, and
 * `exposedTo` entries written as URLs rather than origins.
 */
import { namingStyle, type NamingStyle } from "./naming.js";
import type { Finding } from "../types.js";
import { defineRule, finding, forEachTool, opt, schemaProperties } from "./helpers.js";

const PLACEHOLDER =
  /^(?:todo|tbd|fixme|xxx|n\/a|none|null|undefined|description|tool description|placeholder|test|testing|example|sample|change me|replace me|insert description(?: here)?|lorem ipsum.*|\.{2,}|-+|_+|\?+)$/i;
const PLACEHOLDER_PREFIX = /^(?:todo|fixme|tbd|lorem ipsum)\b/i;

function isPlaceholder(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && (PLACEHOLDER.test(t) || PLACEHOLDER_PREFIX.test(t));
}

export const descriptionPlaceholder = defineRule({
  id: "description-placeholder",
  scope: "tool",
  description: "A description that is only a placeholder (TODO, lorem ipsum, ...) tells the agent nothing and reads as unfinished.",
  severity: "error",
  check: (ctx) =>
    forEachTool(ctx, (tool) => {
      const out: Finding[] = [];
      const texts: Array<[string | undefined, string, string]> = [[undefined, "Description", tool.description ?? ""]];
      if (typeof tool.title === "string") texts.push(["/title", "Title", tool.title]);
      for (const [name, prop] of Object.entries(schemaProperties(tool.inputSchema))) {
        if (typeof prop.description === "string") texts.push([`/properties/${name}/description`, `Description of parameter "${name}"`, prop.description]);
      }
      for (const [path, label, text] of texts) {
        if (isPlaceholder(text))
          out.push(
            finding(descriptionPlaceholder, `${label} of "${tool.name}" is a placeholder: ${JSON.stringify(text.trim())}.`, {
              tool: tool.name,
              frame: tool.frame,
              path,
              help: "Say what the tool does, when to use it, and what it returns.",
            }),
          );
      }
      return out;
    }),
});

/** The hints the specification's ToolAnnotations dictionary knows. */
export const KNOWN_ANNOTATIONS = ["readOnlyHint", "untrustedContentHint", "consequentialHint", "debugging"] as const;

/** Spellings that mean something elsewhere, with what to write instead. */
const ANNOTATION_ALIASES: Record<string, string> = {
  readOnly: "readOnlyHint",
  readonly: "readOnlyHint",
  readonlyHint: "readOnlyHint",
  consequential: "consequentialHint",
  untrustedContent: "untrustedContentHint",
  destructiveHint: "consequentialHint",
  idempotentHint: "",
  openWorldHint: "",
  title: "",
};

export const annotationsValid = defineRule({
  id: "annotations-valid",
  scope: "tool",
  description:
    "Annotations must use the specification's hint names (readOnlyHint, untrustedContentHint, consequentialHint, debugging) with boolean values; anything else is ignored by the API.",
  severity: "error",
  check: (ctx) =>
    forEachTool(ctx, (tool) => {
      const annotations = tool.annotations;
      if (!annotations || typeof annotations !== "object") return [];
      const known = new Set<string>(KNOWN_ANNOTATIONS);
      if (tool.source === "declarative") known.add("autosubmit");
      const out: Finding[] = [];
      for (const [key, value] of Object.entries(annotations)) {
        if (!known.has(key)) {
          const alias = ANNOTATION_ALIASES[key];
          const help =
            alias === undefined
              ? `The API knows ${KNOWN_ANNOTATIONS.join(", ")}; anything else is dropped.`
              : alias
                ? `Write "${alias}"; "${key}" is dropped by the API.`
                : `"${key}" is an MCP hint that WebMCP does not have; the API drops it.`;
          out.push(
            finding(annotationsValid, `Annotation "${key}" of "${tool.name}" is not a WebMCP hint.`, {
              tool: tool.name,
              frame: tool.frame,
              path: `/annotations/${key}`,
              help,
            }),
          );
        } else if (typeof value !== "boolean") {
          out.push(
            finding(annotationsValid, `Annotation "${key}" of "${tool.name}" is ${JSON.stringify(value)}; hints are booleans.`, {
              tool: tool.name,
              frame: tool.frame,
              path: `/annotations/${key}`,
              help: 'A non-boolean value is coerced, so a string like "false" reads as true.',
            }),
          );
        }
      }
      return out;
    }),
});

export const annotationsExplicit = defineRule({
  id: "annotations-explicit",
  scope: "tool",
  description: "Require the listed hints to be declared on every imperative tool, so nobody relies on a default they did not choose.",
  severity: "warning",
  enabled: false,
  defaults: { fields: ["readOnlyHint", "consequentialHint"] },
  check: (ctx) => {
    const fields = opt<string[]>(ctx, "fields", ["readOnlyHint", "consequentialHint"]);
    return forEachTool(ctx, (tool) => {
      if (tool.source === "declarative") return [];
      const annotations = (tool.annotations ?? {}) as Record<string, unknown>;
      return fields
        .filter((field) => typeof annotations[field] !== "boolean")
        .map((field) =>
          finding(annotationsExplicit, `Tool "${tool.name}" does not declare "${field}".`, {
            tool: tool.name,
            frame: tool.frame,
            path: "/annotations",
            help: `Set annotations.${field} to true or false; the default is false, which clients act on.`,
          }),
        );
    });
  },
});

export const toolTitleMissing = defineRule({
  id: "tool-title-missing",
  scope: "tool",
  description: "A title is what a client shows a person when it lists or confirms a tool; without one the name is shown as is.",
  severity: "info",
  enabled: false,
  check: (ctx) =>
    forEachTool(ctx, (tool) =>
      tool.source === "declarative" || (typeof tool.title === "string" && tool.title.trim())
        ? []
        : [finding(toolTitleMissing, `Tool "${tool.name}" has no title.`, { tool: tool.name, frame: tool.frame, path: "/title" })],
    ),
});

const STYLES: NamingStyle[] = ["snake_case", "camelCase", "kebab-case", "dot.separated", "PascalCase"];

export const toolNameStyle = defineRule({
  id: "tool-name-style",
  scope: "tool",
  description: "Tool names follow the project's naming convention: one style, optionally a prefix.",
  severity: "warning",
  enabled: false,
  defaults: { style: "snake_case", prefix: "" },
  check: (ctx) => {
    const style = opt<string>(ctx, "style", "snake_case");
    const prefix = opt<string>(ctx, "prefix", "");
    return forEachTool(ctx, (tool) => {
      const out: Finding[] = [];
      if (prefix && !tool.name.startsWith(prefix))
        out.push(finding(toolNameStyle, `Tool name "${tool.name}" does not start with "${prefix}".`, { tool: tool.name, frame: tool.frame }));
      const bare = prefix && tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name;
      const actual = namingStyle(bare);
      if (STYLES.includes(style as NamingStyle) && actual !== "single" && actual !== style)
        out.push(finding(toolNameStyle, `Tool name "${tool.name}" is ${actual}; the project uses ${style}.`, { tool: tool.name, frame: tool.frame }));
      return out;
    });
  },
});

export const exposedToOriginOnly = defineRule({
  id: "exposed-to-origin-only",
  scope: "tool",
  description: "exposedTo entries are origins; a path, query, fragment or credentials in the entry is ignored by the API, so it does not narrow anything.",
  severity: "warning",
  check: (ctx) =>
    ctx.snapshot.tools.flatMap((t) =>
      (t.exposedTo ?? []).flatMap((entry) => {
        let url: URL;
        try {
          url = new URL(entry);
        } catch {
          return []; // not a URL at all: exposed-to-secure-origins reports it
        }
        const extras: string[] = [];
        if (url.username || url.password) extras.push("credentials");
        if (url.pathname && url.pathname !== "/") extras.push(`the path ${url.pathname}`);
        if (url.search) extras.push("a query");
        if (url.hash) extras.push("a fragment");
        if (!extras.length) return [];
        return [
          finding(exposedToOriginOnly, `Tool "${t.name}" is exposed to ${entry}, which carries ${extras.join(", ")}; only the origin ${url.origin} counts.`, {
            tool: t.name,
            frame: t.frame,
            help: `Write ${url.origin}. An origin cannot be narrowed to a path.`,
          }),
        ];
      }),
    ),
});
