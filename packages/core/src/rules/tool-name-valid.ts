import { defineRule, finding, forEachTool } from "./helpers.js";

const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export const toolNameValid = defineRule({
  id: "tool-name-valid",
  scope: "tool",
  description: "Tool names must be 1-128 characters of letters, digits, '_', '-' or '.'.",
  severity: "error",
  check: (ctx) =>
    forEachTool(ctx, (tool) =>
      NAME_RE.test(tool.name)
        ? []
        : [finding(toolNameValid, `Tool name "${tool.name}" is not a valid WebMCP tool name.`, { tool: tool.name, frame: tool.frame })],
    ),
});

export default toolNameValid;
