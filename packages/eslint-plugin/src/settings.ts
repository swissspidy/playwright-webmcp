/**
 * Where tool definitions come from. The plugin recognises the WebMCP API
 * itself plus common wrappers, and projects add their own through ESLint's
 * shared `settings`:
 *
 *   // eslint.config.js
 *   { settings: { webmcp: { definitions: ["useMyTool", { call: "defineTools", tools: "items" }] } } }
 */

export interface DefinitionSite {
  /**
   * Name of the function or method that receives the definition: matches a
   * bare call `useWebMCP(...)` and a member call `x.registerTool(...)`.
   */
  call: string;
  /** Index of the argument holding the definition. Default 0. */
  argument?: number;
  /**
   * When set, the argument is a context object and this property holds an
   * array of tool definitions, like `provideContext({ tools: [...] })`.
   */
  tools?: string;
  /** Index of an options argument that may carry `exposedTo`. */
  options?: number;
}

/** A settings entry: a call name, or a full site description. */
export type DefinitionSiteSetting = string | DefinitionSite;

export interface WebMCPSettings {
  /** Extra definition sites, added to the defaults. */
  definitions?: DefinitionSiteSetting[];
}

export const DEFAULT_DEFINITION_SITES: DefinitionSite[] = [
  // The API itself.
  { call: "registerTool", argument: 0, options: 1 },
  { call: "provideContext", argument: 0, tools: "tools" },
  // The React hook from `use-webmcp-tool`; same object shape as registerTool.
  { call: "useWebMCP", argument: 0 },
];

export function normalizeSite(entry: DefinitionSiteSetting): DefinitionSite | undefined {
  if (typeof entry === "string") return entry ? { call: entry, argument: 0 } : undefined;
  if (!entry || typeof entry !== "object" || typeof entry.call !== "string" || !entry.call) return undefined;
  return {
    call: entry.call,
    argument: typeof entry.argument === "number" ? entry.argument : 0,
    tools: typeof entry.tools === "string" && entry.tools ? entry.tools : undefined,
    options: typeof entry.options === "number" ? entry.options : undefined,
  };
}

/** Definition sites for a lint run: the defaults plus whatever `settings.webmcp.definitions` adds. */
export function definitionSites(settings: unknown): DefinitionSite[] {
  const extra = ((settings as { webmcp?: WebMCPSettings } | undefined)?.webmcp?.definitions ?? []) as DefinitionSiteSetting[];
  const out = [...DEFAULT_DEFINITION_SITES];
  for (const entry of Array.isArray(extra) ? extra : []) {
    const site = normalizeSite(entry);
    if (site) out.push(site);
  }
  return out;
}
