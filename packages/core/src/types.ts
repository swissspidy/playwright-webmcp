/**
 * Shared data model. Everything here is plain JSON so it can cross the
 * page/Node boundary and be attached to Playwright test results.
 */

export type JsonSchema = Record<string, unknown>;

export type ToolSource = "imperative" | "declarative";

export interface DeclarativeField {
  name: string;
  /** Input type (text, number, email, select, textarea, checkbox, ...). */
  type: string;
  required: boolean;
  /** True when a <label for>, wrapping <label>, aria-label or aria-labelledby exists. */
  hasLabel: boolean;
  paramDescription?: string;
  options?: string[];
}

export interface DeclarativeInfo {
  /** CSS-ish locator for the form, for messages only. */
  formLocator: string;
  autosubmit: boolean;
  hasDescription: boolean;
  fields: DeclarativeField[];
}

export interface ToolSnapshot {
  name: string;
  /** Human-readable label, when the tool declared one. */
  title?: string;
  description: string;
  inputSchema: JsonSchema | null;
  annotations?: Record<string, unknown>;
  origin: string;
  /** Index into PageSnapshot.frames. */
  frame: number;
  source: ToolSource;
  /** Present when the collector could tell whether an execute callback exists. */
  hasExecute?: boolean;
  declarative?: DeclarativeInfo;
  /** Registration site, when known (from the CDP collector). */
  location?: { url: string; line: number; column: number };
  /** Origins the tool was explicitly exposed to (from registerTool options), when the API surfaces it. */
  exposedTo?: string[];
}

/** A tool registration or removal observed in a frame, relative to navigation start. */
export interface RegistrationEvent {
  type: "registered" | "unregistered";
  name: string;
  /** Milliseconds since the frame's navigation start. */
  at: number;
  frameUrl: string;
}

export interface FrameSnapshot {
  url: string;
  origin: string;
  isTop: boolean;
  /** Which API implementation answered in this frame. */
  api: "native" | "shim" | "none";
  /** For child frames: the raw `allow` attribute of the owning <iframe>, if any. */
  allow?: string | null;
  crossOriginFromTop?: boolean;
}

export interface PageSnapshot {
  url: string;
  capturedAt: string;
  frames: FrameSnapshot[];
  tools: ToolSnapshot[];
}

export type Severity = "error" | "warning" | "info";

export interface Finding {
  ruleId: string;
  severity: Severity;
  message: string;
  /** Tool name the finding is about, if any. */
  tool?: string;
  /** Index into PageSnapshot.frames, if the finding is frame specific. */
  frame?: number;
  /** JSON pointer-ish path inside inputSchema, when relevant. */
  path?: string;
  help?: string;
}

export interface RuleContext {
  snapshot: PageSnapshot;
  options: Record<string, unknown>;
}

/**
 * What a rule needs to see. "tool" rules judge each tool from its own
 * definition (name, description, schema, annotations, form) and can run on a
 * single `registerTool()` literal; "page" rules need the whole page (every
 * tool, every frame). Rules without a scope are treated as "page".
 */
export type RuleScope = "tool" | "page";

export interface Rule {
  id: string;
  description: string;
  severity: Severity;
  /** Whether the rule is on by default. */
  enabled: boolean;
  scope?: RuleScope;
  /** Default options, merged with user options. */
  defaults?: Record<string, unknown>;
  check(ctx: RuleContext): Finding[];
}

export interface LintOptions {
  /** Per-rule config: false disables, an object overrides options, a severity string overrides severity. */
  rules?: Record<string, boolean | Severity | Record<string, unknown>>;
  /** Extra rules to run in addition to the built in ones. */
  extraRules?: Rule[];
  /**
   * "tool" runs only rules that judge a tool from its own definition, which is
   * what static analysis of one `registerTool()` call can support. Default "all".
   */
  scope?: RuleScope | "all";
}

export interface LintResult {
  findings: Finding[];
  counts: Record<Severity, number>;
  rulesRun: string[];
}

/** A recorded tool invocation, as captured by the Playwright fixture. */
export interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  startedAt: number;
  durationMs: number;
  /**
   * "api" = executed by page code through modelContext;
   * "fixture" = executed through webmcp.call();
   * "agent" = executed by an on-device model run through webmcp.promptApi.
   */
  via: "api" | "fixture" | "agent";
  /** Where the call was observed: page-side hooks or the CDP WebMCP domain. Default "page". */
  source?: "page" | "cdp";
}
