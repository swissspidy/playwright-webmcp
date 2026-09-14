import { defineRule, finding, forEachTool, opt, walk } from "./helpers.js";

export const schemaShape = defineRule({
  id: "schema-shape",
  scope: "tool",
  description: "inputSchema must be an object schema whose `required` entries exist in `properties`.",
  severity: "error",
  check: (ctx) =>
    forEachTool(ctx, (tool) => {
      const s = tool.inputSchema;
      if (s === null || s === undefined) return [];
      if (typeof s !== "object" || Array.isArray(s))
        return [finding(schemaShape, `inputSchema of "${tool.name}" is not an object.`, { tool: tool.name, frame: tool.frame })];
      const out = [];
      if (s.type !== undefined && s.type !== "object")
        out.push(
          finding(schemaShape, `inputSchema of "${tool.name}" has type "${String(s.type)}"; tool inputs must be an object.`, {
            tool: tool.name,
            frame: tool.frame,
            path: "/type",
          }),
        );
      const props = (s.properties && typeof s.properties === "object" ? s.properties : {}) as Record<string, unknown>;
      if (Array.isArray(s.required)) {
        for (const r of s.required) {
          if (typeof r !== "string" || !(r in props))
            out.push(
              finding(schemaShape, `"${String(r)}" is listed as required in "${tool.name}" but is not a property.`, {
                tool: tool.name,
                frame: tool.frame,
                path: "/required",
              }),
            );
        }
      }
      return out;
    }),
});

export const schemaNulls = defineRule({
  id: "schema-no-null-literals",
  scope: "tool",
  description: "Chrome's Prompt API rejects JSON null at any depth; avoid null literals in schemas.",
  severity: "error",
  check: (ctx) =>
    forEachTool(ctx, (tool) => {
      const out = [];
      for (const [path, value] of walk(tool.inputSchema)) {
        if (value === null && path !== "")
          out.push(
            finding(schemaNulls, `inputSchema of "${tool.name}" contains a null literal at ${path}.`, {
              tool: tool.name,
              frame: tool.frame,
              path,
            }),
          );
      }
      return out;
    }),
});

export const schemaDepth = defineRule({
  id: "schema-depth",
  scope: "tool",
  description: "Deeply nested input schemas are hard for small models to fill.",
  severity: "warning",
  defaults: { max: 3 },
  check: (ctx) => {
    const max = opt(ctx, "max", 3);
    return forEachTool(ctx, (tool) => {
      let deepest = 0;
      for (const [path] of walk(tool.inputSchema)) {
        const depth = path.split("/properties/").length - 1;
        if (depth > deepest) deepest = depth;
      }
      return deepest > max
        ? [
            finding(schemaDepth, `inputSchema of "${tool.name}" nests ${deepest} levels of properties; keep it to ${max}.`, {
              tool: tool.name,
              frame: tool.frame,
            }),
          ]
        : [];
    });
  },
});

const RISKY_KEYWORDS = ["$ref", "allOf", "oneOf", "anyOf", "not", "patternProperties", "if", "then", "else", "dependentSchemas"];

export const schemaKeywords = defineRule({
  id: "schema-unsupported-keywords",
  scope: "tool",
  description: "Composition keywords are unevenly supported across agents and model tool mappers.",
  severity: "warning",
  defaults: { keywords: RISKY_KEYWORDS },
  check: (ctx) => {
    const keywords = new Set(opt<string[]>(ctx, "keywords", RISKY_KEYWORDS));
    return forEachTool(ctx, (tool) => {
      const out = [];
      for (const [path, value] of walk(tool.inputSchema)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        for (const k of Object.keys(value as object)) {
          if (keywords.has(k))
            out.push(
              finding(schemaKeywords, `inputSchema of "${tool.name}" uses "${k}" at ${path || "/"}.`, {
                tool: tool.name,
                frame: tool.frame,
                path: `${path}/${k}`,
                help: "Prefer flat object schemas with explicit types and enums.",
              }),
            );
        }
      }
      return out;
    });
  },
});

const SENSITIVE_RE =
  /(password|passcode|secret|token|api[-_]?key|ssn|social[-_]?security|credit[-_]?card|card[-_]?number|cvv|cvc|iban|account[-_]?number|routing)/i;

export const sensitiveParams = defineRule({
  id: "sensitive-params",
  scope: "tool",
  description: "Tools should not ask agents for credentials or payment secrets; collect those through the page UI instead.",
  severity: "warning",
  defaults: { pattern: SENSITIVE_RE.source },
  check: (ctx) => {
    const re = new RegExp(opt(ctx, "pattern", SENSITIVE_RE.source), "i");
    return forEachTool(ctx, (tool) => {
      const props = (tool.inputSchema?.properties ?? {}) as Record<string, unknown>;
      return Object.keys(props)
        .filter((name) => re.test(name))
        .map((name) =>
          finding(sensitiveParams, `Parameter "${name}" of "${tool.name}" looks like sensitive data.`, {
            tool: tool.name,
            frame: tool.frame,
            path: `/properties/${name}`,
            help: "The WebMCP privacy questionnaire flags non-minimal data requests; let the user enter this in the page.",
          }),
        );
    });
  },
});
