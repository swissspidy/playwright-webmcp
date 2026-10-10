import type { Page, Request } from "@playwright/test";
import {
  SAFE_METHODS,
  generateArguments,
  isReadOnlyTool,
  judgeRuns,
  type GenerateOptions,
  type SmokeBudgets,
  type SmokeReport,
  type SmokeRequest,
  type SmokeRun,
  type ToolSnapshot,
} from "@swissspidy/webmcp-lint";

export interface SmokeOptions extends GenerateOptions, SmokeBudgets {
  /** Tools to exercise, by name or predicate. */
  tools?: string[] | ((tool: ToolSnapshot) => boolean);
  /** Exercise every tool, including ones that may have side effects. */
  all?: boolean;
  /** Which argument kinds to run. Default: all four. */
  kinds?: Array<SmokeRun["kind"]>;
  /**
   * Requests the page sends on its own, such as analytics beacons, that
   * `result-writes` should not blame on the tool being called. A string is a
   * URL glob: `**` matches anything, `*` anything but `/`.
   */
  ignoreRequests?: Array<string | RegExp> | ((request: SmokeRequest) => boolean);
}

function globToRegExp(glob: string): RegExp {
  const source = glob
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${source}$`);
}

/** The predicate `ignoreRequests` describes, or undefined when it ignores nothing. */
export function requestFilter(ignore: SmokeOptions["ignoreRequests"]): ((request: SmokeRequest) => boolean) | undefined {
  if (typeof ignore === "function") return ignore;
  if (!ignore?.length) return undefined;
  const patterns = ignore.map((p) => (typeof p === "string" ? globToRegExp(p) : p));
  return (request) => patterns.some((p) => p.test(request.url));
}

/** @deprecated Import `isReadOnlyTool` from `webmcp-lint` instead. */
export const isReadOnly = isReadOnlyTool;

/**
 * Decide which tools a smoke run may execute. Without an explicit list or
 * `all: true`, only tools annotated as read-only are considered safe.
 */
export function selectSmokeTools(tools: ToolSnapshot[], options: SmokeOptions): { selected: ToolSnapshot[]; skipped: ToolSnapshot[] } {
  let selected: ToolSnapshot[];
  if (typeof options.tools === "function") selected = tools.filter(options.tools);
  else if (Array.isArray(options.tools)) selected = tools.filter((t) => (options.tools as string[]).includes(t.name));
  else if (options.all) selected = tools;
  else selected = tools.filter(isReadOnlyTool);
  const chosen = new Set(selected);
  return { selected, skipped: tools.filter((t) => !chosen.has(t)) };
}

export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** What a smoke run watches around each call. */
export interface SmokeWatch {
  /** The current page URL; a call that changes it is reported as `result-navigates`. */
  url?: () => string;
  /**
   * Start recording the requests the page sends; the returned function stops
   * and resolves to what was seen. A read-only tool that sent anything but
   * GET, HEAD or OPTIONS is reported as `result-writes`.
   */
  requests?: () => () => Promise<SmokeRequest[]>;
}

/**
 * Watch a Playwright page for smoke: its URL, and the requests sent from its
 * browser context during each call (so a popup or service worker the tool
 * reaches counts too).
 */
export function watchPage(page: Page): SmokeWatch {
  return {
    url: () => page.url(),
    requests: () => {
      const seen: SmokeRequest[] = [];
      const onRequest = (request: Request) => seen.push({ method: request.method(), url: request.url() });
      const context = page.context();
      context.on("request", onRequest);
      return async () => {
        // A request the tool fired without awaiting can still be on its way to this process
        // when the call resolves; a round trip to the page lets it land.
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0))).catch(() => {});
        context.off("request", onRequest);
        return seen;
      };
    },
  };
}

/**
 * Runs generated inputs against the selected tools. Pass a `SmokeWatch` (for
 * a Playwright page, `watchPage(page)`) to have calls that change the page
 * URL reported as `result-navigates`, where a same-document route change
 * counts, and read-only calls that send a writing request as `result-writes`.
 * A bare function is taken as `{ url }`.
 */
export async function runSmoke(
  tools: ToolSnapshot[],
  call: ToolCaller,
  options: SmokeOptions = {},
  watch: SmokeWatch | (() => string) = {},
): Promise<SmokeReport & { skipped: string[] }> {
  const { url: currentUrl, requests } = typeof watch === "function" ? { url: watch, requests: undefined } : watch;
  const ignored = requestFilter(options.ignoreRequests);
  const { selected, skipped } = selectSmokeTools(tools, options);
  const kinds = new Set(options.kinds ?? ["valid-minimal", "valid-full", "boundary", "invalid"]);
  const runs: SmokeRun[] = [];
  for (const tool of selected) {
    for (const generated of generateArguments(tool.inputSchema, options)) {
      if (!kinds.has(generated.kind)) continue;
      const startedAt = Date.now();
      const before = currentUrl?.();
      const stopRequests = requests?.();
      const observed = async () => {
        const after = currentUrl?.();
        const writes = (await stopRequests?.())?.filter((r) => !SAFE_METHODS.has(r.method.toUpperCase()) && !ignored?.(r));
        return {
          ...(after !== undefined && after !== before ? { navigatedTo: after } : {}),
          ...(writes?.length ? { writes } : {}),
        };
      };
      try {
        const result = await call(tool.name, generated.args);
        const durationMs = Date.now() - startedAt;
        runs.push({
          tool: tool.name,
          kind: generated.kind,
          label: generated.label,
          args: generated.args,
          annotations: tool.annotations ?? null,
          ok: true,
          result,
          durationMs,
          ...(await observed()),
        });
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        runs.push({
          tool: tool.name,
          kind: generated.kind,
          label: generated.label,
          args: generated.args,
          annotations: tool.annotations ?? null,
          ok: false,
          error: String((err as Error)?.message ?? err),
          durationMs,
          ...(await observed()),
        });
      }
    }
  }
  return { ...judgeRuns(runs, options), skipped: skipped.map((t) => t.name) };
}
