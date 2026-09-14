/**
 * Ways to obtain a PageSnapshot without the Playwright fixture, so the rules
 * run on tool definitions you already have in hand: an array of
 * `registerTool()`-style objects, a `tools.json` in the `webmcp-evals`
 * format, or the per-frame results of `collectFrame()` evaluated through
 * Puppeteer, WebDriver or any other browser driver.
 */
import type { FrameCollectResult } from "./collect.js";
import type { EvalToolsSchema } from "./evals-types.js";
import { lint } from "./lint.js";
import type { JsonSchema, LintOptions, LintResult, PageSnapshot, ToolSnapshot } from "./types.js";

/** The subset of a WebMCP tool definition the rules look at. Extra keys such as `execute` are ignored. */
export interface ToolDefinitionLike {
  name: string;
  title?: string;
  description?: string | null;
  inputSchema?: JsonSchema | null;
  annotations?: Record<string, unknown> | null;
  /** Origins passed as `registerTool(tool, { exposedTo })`. */
  exposedTo?: string[];
  [key: string]: unknown;
}

export interface SnapshotFromToolsOptions {
  /** Page URL to report in findings. Default "about:blank". */
  url?: string;
}

export interface SnapshotFromFramesOptions {
  /** Page URL. Default: the first frame's URL. */
  url?: string;
}

/** Anything `lintTools()` accepts. */
export type LintInput = PageSnapshot | ToolDefinitionLike[] | EvalToolsSchema;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

export function isPageSnapshot(value: unknown): value is PageSnapshot {
  return Boolean(value && typeof value === "object" && Array.isArray((value as PageSnapshot).frames) && Array.isArray((value as PageSnapshot).tools));
}

export function isToolsSchema(value: unknown): value is EvalToolsSchema {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as EvalToolsSchema).tools));
}

/**
 * Build a single-frame snapshot from plain tool definitions, or from a
 * `webmcp-evals` tools file (the shape `webmcp-evals local -t` reads and the
 * Playwright reporter writes as `tools.json`).
 */
export function snapshotFromTools(tools: ToolDefinitionLike[] | EvalToolsSchema, options: SnapshotFromToolsOptions = {}): PageSnapshot {
  const list: ToolDefinitionLike[] = Array.isArray(tools) ? tools : (tools.tools as unknown as ToolDefinitionLike[]);
  const url = options.url ?? "about:blank";
  const origin = originOf(url);
  return {
    url,
    capturedAt: new Date().toISOString(),
    frames: [{ url, origin, isTop: true, api: "none" }],
    tools: list.map((t) => {
      const tool: ToolSnapshot = {
        name: String(t?.name ?? ""),
        description: typeof t?.description === "string" ? t.description : "",
        inputSchema: t?.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : null,
        origin,
        frame: 0,
        source: "imperative",
      };
      if (typeof t?.title === "string" && t.title) tool.title = t.title;
      if (t?.annotations && typeof t.annotations === "object") tool.annotations = t.annotations;
      if (Array.isArray(t?.exposedTo)) tool.exposedTo = t.exposedTo.map(String);
      return tool;
    }),
  };
}

/**
 * Assemble a snapshot from `collectFrame()` results, one per frame, in the
 * order the driver lists them (top frame first). Pass the owning `<iframe>`'s
 * `allow` attribute alongside child frames when you have it so the
 * `iframe-allow-tools` rule can judge cross-origin exposure. This is what the
 * Playwright fixture does; use it with Puppeteer, WebDriver or jsdom.
 */
export function snapshotFromFrames(frames: Array<FrameCollectResult & { allow?: string | null }>, options: SnapshotFromFramesOptions = {}): PageSnapshot {
  const url = options.url ?? frames[0]?.frame.url ?? "about:blank";
  const topOrigin = originOf(url);
  const snapshot: PageSnapshot = { url, capturedAt: new Date().toISOString(), frames: [], tools: [] };
  frames.forEach((r, i) => {
    snapshot.frames.push({ ...r.frame, isTop: i === 0, allow: i > 0 ? r.allow : undefined, crossOriginFromTop: i > 0 && r.frame.origin !== topOrigin });
    for (const t of r.tools) snapshot.tools.push({ ...t, frame: i });
  });
  return snapshot;
}

/** Normalise any accepted input to a snapshot. */
export function toSnapshot(input: LintInput, options: SnapshotFromToolsOptions = {}): PageSnapshot {
  if (isPageSnapshot(input)) return input;
  if (Array.isArray(input) || isToolsSchema(input)) return snapshotFromTools(input, options);
  throw new TypeError("Expected a PageSnapshot, an array of tool definitions, or a { tools: [...] } object.");
}

/**
 * Lint tool definitions directly: the same rules as `lint()`, without a
 * browser. Accepts a snapshot, an array of `registerTool()`-style objects, or
 * a `webmcp-evals` tools file.
 */
export function lintTools(input: LintInput, options: LintOptions & SnapshotFromToolsOptions = {}): LintResult {
  const { url, ...lintOptions } = options;
  return lint(toSnapshot(input, { url }), lintOptions);
}
