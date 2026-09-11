/**
 * Render a Markdown reference of a page's tools for humans and agents.
 */
import { toolHints } from "./annotations.js";
import type { ToolContract } from "./contract.js";
import type { RecordedCall } from "./types.js";

export interface DocsOptions {
  title?: string;
  /** Recorded calls used to pick example invocations. */
  calls?: RecordedCall[];
  /** Page URL, mentioned in the intro. */
  url?: string;
}

function typeOf(prop: Record<string, unknown>): string {
  if (Array.isArray(prop.enum)) return prop.enum.map((e) => JSON.stringify(e)).join(" \\| ");
  const t = prop.type;
  return Array.isArray(t) ? t.join(" \\| ") : typeof t === "string" ? t : "any";
}

export function renderToolDocs(contract: ToolContract, options: DocsOptions = {}): string {
  const lines: string[] = [];
  lines.push(`# ${options.title ?? "WebMCP tools"}`, "");
  if (options.url) lines.push(`Tools exposed at ${options.url}. ${contract.tools.length} tool(s).`, "");
  for (const tool of contract.tools) {
    lines.push(`## \`${tool.name}\``, "");
    if (tool.title) lines.push(`**${tool.title}**`, "");
    if (tool.description) lines.push(tool.description, "");
    const meta: string[] = [`Registered ${tool.source === "declarative" ? "declaratively (form)" : "imperatively"}`];
    const hints = toolHints(tool.annotations);
    if (hints.readOnly) meta.push("read-only");
    if (hints.consequential) meta.push("consequential");
    if (hints.untrustedContent) meta.push("returns untrusted content");
    if (hints.autosubmit) meta.push("auto-submits");
    lines.push(`_${meta.join(", ")}._`, "");
    const props = (tool.inputSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set((tool.inputSchema?.required as string[] | undefined) ?? []);
    const names = Object.keys(props);
    if (names.length) {
      lines.push("| Parameter | Type | Required | Description |", "| --- | --- | --- | --- |");
      for (const name of names) {
        const p = props[name];
        lines.push(
          `| \`${name}\` | ${typeOf(p)} | ${required.has(name) ? "yes" : "no"} | ${typeof p.description === "string" ? p.description.replace(/\|/g, "\\|") : ""} |`,
        );
      }
      lines.push("");
    } else {
      lines.push("No parameters.", "");
    }
    const example = options.calls?.find((c) => c.name === tool.name && !c.error);
    if (example) {
      lines.push("Example:", "", "```json", JSON.stringify({ tool: example.name, arguments: example.args, result: example.result }, null, 2), "```", "");
    }
  }
  return lines.join("\n");
}
