/**
 * The one place that talks to the page's WebMCP API (`document.modelContext`).
 *
 * `installPageApi` runs inside a frame and defines `window.__webmcpPage`, a
 * small facade over the browser's API: list tools, find one by name, execute
 * it, decode its result, cancel a call. Everything else in this package that
 * runs in the page goes through the facade, so a change to the API's shape
 * is a change to this file.
 *
 * `inPage()` is how Node-side code uses it: it installs the facade in the
 * frame if needed and runs a function against it, in one evaluation. The
 * recorder's init script installs it too, before the page's own scripts run.
 *
 * Like every function Playwright evaluates, `installPageApi` and the functions
 * passed to `inPage()` are serialised, so they must be self contained: no
 * imports, no closures over module scope.
 *
 * `collectFrame()` in `@swissspidy/webmcp-lint` reads the API on its own,
 * since it has to work without Playwright (Puppeteer, WebDriver, jsdom).
 */
import type { Frame, Page } from "@playwright/test";
import type { WebMCP as WebMCPTypes } from "webmcp-types";

/** A tool as the page's `getTools()` lists it. Opaque to callers beyond these fields; pass it back to `execute()`. */
export type PageTool = WebMCPTypes.RegisteredTool;

export interface PageExecuteOptions {
  signal?: AbortSignal;
  /**
   * Cancel handle: `abort(token)` from another evaluation aborts this call,
   * and an `abort(token)` that arrives before the call starts cancels it
   * up front.
   */
  abortToken?: string;
}

export type PageExecuteOutcome = { ok: true; result: unknown } | { ok: false; error: string; canceled?: boolean };

export interface PageApi {
  /** Whether this frame has a WebMCP API at all. */
  available(): boolean;
  /** Whether the API fires `toolactivated` and `toolcancel` (Chromium added them after the rest). */
  supportsToolEvents(): boolean;
  /** The tools `getTools()` lists in this frame; with `fromOrigins`, also those cross-origin frames expose to it. */
  listTools(options?: { fromOrigins?: string[] }): Promise<PageTool[]>;
  /** The listed tool with this name, if any. */
  findTool(name: string): Promise<PageTool | undefined>;
  /**
   * Execute a tool by name and settle with the decoded result or the error.
   * Never rejects. Calls made through here are marked so the recorder leaves
   * them to the fixture, which records them itself.
   */
  execute(name: string, args: Record<string, unknown>, options?: PageExecuteOptions): Promise<PageExecuteOutcome>;
  /** Cancel the call started with this `abortToken`, or the one about to start with it. */
  abort(token: string): void;
  /** The value an `executeTool()` result encodes: Chromium resolves with JSON for objects, String(value) for primitives, "undefined" for no result. */
  decodeResult(raw: unknown): unknown;
  /** A JSON-safe copy of a value (undefined becomes null; what JSON cannot hold becomes its string form). */
  toJson(value: unknown): unknown;
}

declare global {
  interface Window {
    __webmcpPage?: PageApi;
  }
}

/** Defines `window.__webmcpPage` in the current frame. Idempotent. Evaluated in the page: keep it self contained. */
export function installPageApi(): void {
  if (window.__webmcpPage) return;
  const modelContext = () => (document as unknown as { modelContext?: WebMCPTypes.ModelContext }).modelContext;
  const aborts: Record<string, AbortController | "aborted"> = Object.create(null);

  function toJson(value: unknown): unknown {
    try {
      return JSON.parse(JSON.stringify(value === undefined ? null : value));
    } catch {
      return String(value);
    }
  }

  function decodeResult(raw: unknown): unknown {
    if (typeof raw !== "string") return toJson(raw);
    if (raw === "undefined") return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  async function listTools(options?: { fromOrigins?: string[] }): Promise<PageTool[]> {
    const mc = modelContext();
    if (!mc) return [];
    const listed = options?.fromOrigins?.length ? await mc.getTools({ fromOrigins: options.fromOrigins } as never) : await mc.getTools();
    return listed ?? [];
  }

  async function findTool(name: string): Promise<PageTool | undefined> {
    return (await listTools()).find((t) => t.name === name);
  }

  async function execute(name: string, args: Record<string, unknown>, options: PageExecuteOptions = {}): Promise<PageExecuteOutcome> {
    const mc = modelContext();
    if (!mc) return { ok: false, error: "No WebMCP modelContext in this frame" };
    const { abortToken } = options;
    let controller: AbortController | undefined;
    try {
      const tool = await findTool(name);
      if (!tool) return { ok: false, error: `No WebMCP tool named "${name}" is registered` };
      let signal = options.signal;
      if (abortToken !== undefined) {
        if (aborts[abortToken] === "aborted") return { ok: false, error: "signal is aborted without reason", canceled: true };
        controller = new AbortController();
        aborts[abortToken] = controller;
        signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      }
      const raw: unknown = await mc.executeTool(tool, args, { __playwrightWebmcp: true, ...(signal ? { signal } : {}) } as never);
      return { ok: true, result: decodeResult(raw) };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err), canceled: (err as Error)?.name === "AbortError" };
    } finally {
      if (abortToken !== undefined) delete aborts[abortToken];
    }
  }

  function abort(token: string): void {
    const controller = aborts[token];
    if (controller instanceof AbortController) controller.abort();
    else aborts[token] = "aborted";
  }

  const api: PageApi = {
    available: () => Boolean(modelContext()),
    supportsToolEvents: () => {
      const mc = modelContext();
      return Boolean(mc && "ontoolactivated" in mc && "ontoolcancel" in mc);
    },
    listTools,
    findTool,
    execute,
    abort,
    decodeResult,
    toJson,
  };
  Object.defineProperty(window, "__webmcpPage", { value: api, configurable: true });
}

/** `installPageApi` as a script, for `addInitScript()` and for other in-page scripts to build on. */
export const PAGE_API_SOURCE = `(${installPageApi.toString()})();`;

/**
 * Run `fn` in the frame with the page API as its first argument. `fn` is
 * serialised like any function Playwright evaluates, and `arg` must be JSON.
 */
export function inPage<R, A = undefined>(target: Page | Frame, fn: (api: PageApi, arg: A) => R | Promise<R>, arg?: A): Promise<R> {
  // One string evaluation installs the facade if needed and runs fn; Playwright awaits the promise.
  return target.evaluate(`${PAGE_API_SOURCE}\n(${fn.toString()})(window.__webmcpPage, ${JSON.stringify(arg) ?? "undefined"})`) as Promise<R>;
}
