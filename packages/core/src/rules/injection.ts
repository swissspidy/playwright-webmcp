import { detectInjection } from "../injection.js";
import { defineRule, finding, forEachTool, schemaProperties } from "./helpers.js";

export const descriptionInjection = defineRule({
  id: "description-injection",
  description: "Tool or parameter descriptions must not contain instructions aimed at the agent, role markers, or hidden characters.",
  severity: "error",
  check: (ctx) =>
    forEachTool(ctx, (tool) => {
      const out = [];
      const texts: Array<[string, string]> = [["description", tool.description ?? ""]];
      for (const [name, prop] of Object.entries(schemaProperties(tool.inputSchema))) {
        if (typeof prop.description === "string") texts.push([`/properties/${name}/description`, prop.description]);
      }
      for (const [path, text] of texts) {
        for (const hit of detectInjection(text)) {
          out.push(
            finding(descriptionInjection, `${path === "description" ? "Description" : `Parameter description at ${path}`} of "${tool.name}" contains ${hit.kind.replace(/-/g, " ")}: ${JSON.stringify(hit.match)}.`, {
              tool: tool.name,
              frame: tool.frame,
              path: path === "description" ? undefined : path,
              help: "Descriptions are read by every agent that visits the page; keep them to what the tool does.",
            }),
          );
        }
      }
      return out;
    }),
});
