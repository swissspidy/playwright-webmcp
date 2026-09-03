import { defineRule, finding, forEachTool, opt, schemaProperties } from "./helpers.js";

export const descriptionMissing = defineRule({
  id: "description-missing",
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
