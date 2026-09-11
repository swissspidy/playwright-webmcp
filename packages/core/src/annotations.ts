/**
 * Tool annotations arrive under two spellings. The WebMCP specification and
 * `webmcp-types` use MCP-style hints (`readOnlyHint`, `consequentialHint`,
 * `untrustedContentHint`); the CDP `WebMCP` domain reports the same facts as
 * `readOnly`, `consequential`, `untrustedContent` and adds `autosubmit` for
 * declarative tools. Everything in this repository reads annotations through
 * `toolHints()` so both spellings behave the same.
 */

export interface ToolHints {
  readOnly?: boolean;
  consequential?: boolean;
  untrustedContent?: boolean;
  /** Declarative tools only: the form carries `toolautosubmit`. */
  autosubmit?: boolean;
}

const HINT_KEYS: Record<keyof ToolHints, string[]> = {
  readOnly: ["readOnlyHint", "readOnly"],
  consequential: ["consequentialHint", "consequential"],
  untrustedContent: ["untrustedContentHint", "untrustedContent"],
  autosubmit: ["autosubmit"],
};

export function toolHints(annotations: Record<string, unknown> | null | undefined): ToolHints {
  const out: ToolHints = {};
  if (!annotations || typeof annotations !== "object") return out;
  for (const [hint, keys] of Object.entries(HINT_KEYS) as Array<[keyof ToolHints, string[]]>) {
    for (const key of keys) {
      const value = annotations[key];
      if (typeof value === "boolean") {
        out[hint] = value;
        break;
      }
    }
  }
  return out;
}

/** True when the tool declares itself read-only under either spelling. */
export function isReadOnlyTool(tool: { annotations?: Record<string, unknown> | null }): boolean {
  return toolHints(tool.annotations).readOnly === true;
}
