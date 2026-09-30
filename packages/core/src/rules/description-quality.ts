import type { JsonSchema } from "../types.js";
import { defineRule, finding, forEachTool, opt, schemaProperties } from "./helpers.js";

export const descriptionMissing = defineRule({
  id: "description-missing",
  scope: "tool",
  description: "Every tool needs a non-empty description; agents select tools by it.",
  severity: "error",
  check: (ctx) =>
    forEachTool(ctx, (tool) =>
      // Declarative forms are covered by declarative-description.
      tool.source === "declarative" || (tool.description && tool.description.trim())
        ? []
        : [finding(descriptionMissing, `Tool "${tool.name}" has no description.`, { tool: tool.name, frame: tool.frame })],
    ),
});

export const descriptionLength = defineRule({
  id: "description-length",
  scope: "tool",
  description: "Descriptions should be long enough to disambiguate and short enough to fit small model contexts.",
  severity: "warning",
  defaults: { min: 20, max: 600 },
  check: (ctx) => {
    const min = opt(ctx, "min", 20);
    const max = opt(ctx, "max", 600);
    return forEachTool(ctx, (tool) => {
      const len = (tool.description ?? "").trim().length;
      if (!len) return [];
      if (len < min)
        return [
          finding(descriptionLength, `Description of "${tool.name}" is ${len} characters; aim for at least ${min}.`, {
            tool: tool.name,
            frame: tool.frame,
            help: "Say what the tool does, when to use it, and what it returns.",
          }),
        ];
      if (len > max)
        return [
          finding(descriptionLength, `Description of "${tool.name}" is ${len} characters; keep it under ${max}.`, {
            tool: tool.name,
            frame: tool.frame,
          }),
        ];
      return [];
    });
  },
});

export const paramDescriptionMissing = defineRule({
  id: "param-description-missing",
  scope: "tool",
  description: "Each input property should carry a description so the model fills it correctly.",
  severity: "warning",
  check: (ctx) =>
    forEachTool(ctx, (tool) =>
      Object.entries(schemaProperties(tool.inputSchema)).flatMap(([name, prop]) =>
        typeof prop.description === "string" && prop.description.trim()
          ? []
          : [
              finding(paramDescriptionMissing, `Parameter "${name}" of "${tool.name}" has no description.`, {
                tool: tool.name,
                frame: tool.frame,
                path: `/properties/${name}`,
              }),
            ],
      ),
    ),
});

/** Each property schema under `properties` and `items`, at any depth, with its path. */
function* propertySchemas(schema: JsonSchema | null, base = ""): Generator<[string, string, JsonSchema]> {
  for (const [name, prop] of Object.entries(schemaProperties(schema))) {
    if (!prop || typeof prop !== "object") continue;
    const path = `${base}/properties/${name}`;
    yield [name, path, prop];
    yield* propertySchemas(prop, path);
    const items = prop.items;
    if (items && typeof items === "object" && !Array.isArray(items)) yield* propertySchemas(items as JsonSchema, `${path}/items`);
  }
}

export const paramDescriptionLength = defineRule({
  id: "param-description-length",
  scope: "tool",
  description: "A parameter description says what the value is and its format in one sentence; long ones cost tokens on every call and bury the constraint.",
  severity: "warning",
  defaults: { max: 150 },
  check: (ctx) => {
    const max = opt(ctx, "max", 150);
    return forEachTool(ctx, (tool) =>
      [...propertySchemas(tool.inputSchema)].flatMap(([name, path, prop]) => {
        const len = typeof prop.description === "string" ? prop.description.trim().length : 0;
        return len > max
          ? [
              finding(paramDescriptionLength, `Description of parameter "${name}" of "${tool.name}" is ${len} characters; keep it under ${max}.`, {
                tool: tool.name,
                frame: tool.frame,
                path,
                help: "State the value and its format; move usage guidance to the tool description and use enum, minimum or pattern for constraints.",
              }),
            ]
          : [];
      }),
    );
  },
});

/** Wording that tells a model when to pick a tool, not only what it does. */
const WHEN_TO_USE = /\b(?:when(?:ever)?|use (?:this|it)|call (?:this|it)|invoke|instead of|rather than|before|after|unless|if (?:the )?(?:user|you|a|an))\b/i;

export const descriptionWhenToUse = defineRule({
  id: "description-when-to-use",
  scope: "tool",
  description: "Descriptions say when to call the tool, not only what it does, so a model can choose between it and its neighbours.",
  severity: "info",
  enabled: false,
  check: (ctx) =>
    forEachTool(ctx, (tool) => {
      const text = (tool.description ?? "").trim();
      if (!text || WHEN_TO_USE.test(text)) return [];
      return [
        finding(descriptionWhenToUse, `Description of "${tool.name}" says what the tool does but not when to use it.`, {
          tool: tool.name,
          frame: tool.frame,
          help: 'Add a trigger, for example "Use when the user asks to ..." or "Call this before ...".',
        }),
      ];
    }),
});
