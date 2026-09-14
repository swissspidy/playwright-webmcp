import { defineRule, finding, forEachTool } from "./helpers.js";

export const declarativeDescription = defineRule({
  id: "declarative-description",
  scope: "tool",
  description: "Forms with toolname should also carry tooldescription.",
  severity: "error",
  check: (ctx) =>
    forEachTool(ctx, (tool) =>
      tool.source === "declarative" && tool.declarative && !tool.declarative.hasDescription
        ? [
            finding(declarativeDescription, `Form tool "${tool.name}" (${tool.declarative.formLocator}) has no tooldescription attribute.`, {
              tool: tool.name,
              frame: tool.frame,
            }),
          ]
        : [],
    ),
});

export const declarativeFieldLabels = defineRule({
  id: "declarative-field-description",
  scope: "tool",
  description: "Form fields that become tool parameters need a label or toolparamdescription so the agent understands them.",
  severity: "warning",
  check: (ctx) =>
    forEachTool(ctx, (tool) =>
      tool.source !== "declarative" || !tool.declarative
        ? []
        : tool.declarative.fields
            .filter((f) => !f.hasLabel && !f.paramDescription)
            .map((f) =>
              finding(declarativeFieldLabels, `Field "${f.name}" of form tool "${tool.name}" has neither a label nor toolparamdescription.`, {
                tool: tool.name,
                frame: tool.frame,
                path: `/properties/${f.name}`,
              }),
            ),
    ),
});

const SENSITIVE_TYPES = new Set(["password"]);
const SENSITIVE_AUTOCOMPLETE = /^(cc-|new-password|current-password|one-time-code)/;

export const declarativeAutosubmit = defineRule({
  id: "declarative-autosubmit-sensitive",
  scope: "tool",
  description: "toolautosubmit on forms with credential or payment fields lets an agent submit them without a human in the loop.",
  severity: "error",
  check: (ctx) =>
    forEachTool(ctx, (tool) => {
      const d = tool.declarative;
      if (tool.source !== "declarative" || !d || !d.autosubmit) return [];
      const risky = d.fields.filter((f) => SENSITIVE_TYPES.has(f.type) || SENSITIVE_AUTOCOMPLETE.test(f.paramDescription ?? ""));
      return risky.length
        ? [
            finding(declarativeAutosubmit, `Form tool "${tool.name}" auto-submits but contains ${risky.map((f) => `"${f.name}"`).join(", ")}.`, {
              tool: tool.name,
              frame: tool.frame,
              help: "Drop toolautosubmit so the user confirms the submission.",
            }),
          ]
        : [];
    }),
});
