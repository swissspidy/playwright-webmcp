/**
 * Declarations the API accepts and a project may still want to tighten: a
 * missing title, a name that does not follow the project's convention, hints
 * left to their defaults, and `exposedTo` entries written as URLs rather than
 * origins.
 */
import { namingStyle, type NamingStyle } from "./naming.js";
import type { Finding } from "../types.js";
import { defineRule, finding, forEachTool, opt } from "./helpers.js";

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
          return []; // does not parse: exposed-to-secure-origins reports it
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
