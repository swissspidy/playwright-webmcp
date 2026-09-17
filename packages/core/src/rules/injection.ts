import { detectInjection, scanValue } from "../injection.js";
import type { Finding } from "../types.js";
import { defineRule, finding, forEachTool, schemaProperties } from "./helpers.js";

/**
 * Every string a tool declares is read by every agent that visits the page,
 * not just the description: `title` is shown in tool pickers, and annotation
 * values are passed through to the model by clients that surface hints. All of
 * them are scanned.
 */
export const descriptionInjection = defineRule({
  id: "description-injection",
  scope: "tool",
  description:
    "Tool text -- description, title, parameter descriptions, annotations -- must not contain instructions aimed at the agent, role markers, or hidden characters.",
  severity: "error",
  check: (ctx) =>
    forEachTool(ctx, (tool) => {
      const out: Finding[] = [];
      const texts: Array<[string, string]> = [["description", tool.description ?? ""]];
      if (typeof tool.title === "string") texts.push(["/title", tool.title]);
      for (const [name, prop] of Object.entries(schemaProperties(tool.inputSchema))) {
        if (typeof prop.description === "string") texts.push([`/properties/${name}/description`, prop.description]);
      }
      // Annotations are an open record; scan every string leaf under it.
      for (const { path, hits } of scanValue(tool.annotations)) {
        for (const hit of hits) out.push(report(tool.name, tool.frame, `/annotations${path === "/" ? "" : path}`, hit));
      }
      for (const [path, text] of texts) {
        for (const hit of detectInjection(text)) out.push(report(tool.name, tool.frame, path, hit));
      }
      return out;
    }),
});

function label(path: string): string {
  if (path === "description") return "Description";
  if (path === "/title") return "Title";
  if (path.startsWith("/annotations")) return `Annotation at ${path}`;
  return `Parameter description at ${path}`;
}

function report(tool: string, frame: number, path: string, hit: { kind: string; match: string }): Finding {
  return finding(descriptionInjection, `${label(path)} of "${tool}" contains ${hit.kind.replace(/-/g, " ")}: ${JSON.stringify(hit.match)}.`, {
    tool,
    frame,
    path: path === "description" ? undefined : path,
    help: "Tool text is read by every agent that visits the page; keep it to what the tool does.",
  });
}
