/**
 * Runs untrusted script source in a fresh QuickJS context with no globals
 * beyond the language itself, a captured console, and whatever the host
 * exposes through one async bridge function.
 *
 * Uses the synchronous QuickJS build with host functions that return guest
 * promises, rather than the asyncify build: guest code gets real `await` and
 * `Promise.all` runs host calls concurrently. Everything crosses the boundary
 * as JSON strings, so no guest object ever reaches the host.
 */
import { getQuickJS, type QuickJSContext, type QuickJSDeferredPromise } from "quickjs-emscripten";

export interface SandboxLimits {
  /** Wall-clock budget for the whole script, including time spent waiting on the host. */
  timeoutMs?: number;
  /** Budget for one uninterrupted stretch of guest computation (catches busy loops early). */
  cpuSliceMs?: number;
  memoryLimitBytes?: number;
  maxStackBytes?: number;
}

export interface LogEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
}

export interface SandboxError {
  name: string;
  message: string;
  stack?: string;
}

export type SandboxResult = { ok: true; value: unknown; logs: LogEntry[] } | { ok: false; error: SandboxError; logs: LogEntry[] };

/** Errors thrown by `host` reach the guest as Error objects with this name, message and extra own properties. */
export type HostHandler = (op: string, payload: any) => Promise<unknown>;

const MAX_LOG_ENTRIES = 500;
const MAX_LOG_TEXT = 4000;

/** Guest-side prelude. `__host(op, json)` and `__log(level, text)` are injected before it runs. */
export function prelude(extra: string): string {
  return String.raw`
(() => {
  const host = __host, log = __log;
  delete globalThis.__host; delete globalThis.__log;
  const rpc = async (op, payload) => {
    const r = JSON.parse(await host(op, JSON.stringify(payload === undefined ? null : payload)));
    if (r.ok) return r.value;
    const e = new Error(r.error.message);
    e.name = r.error.name || "Error";
    if (r.error.data) Object.assign(e, r.error.data);
    throw e;
  };
  const fmt = (v) => {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.name + ": " + v.message;
    try { return JSON.stringify(v, null, 2) ?? String(v); } catch { return String(v); }
  };
  const mk = (level) => (...args) => log(level, args.map(fmt).join(" "));
  globalThis.console = { log: mk("log"), info: mk("info"), warn: mk("warn"), error: mk("error"), debug: mk("debug") };
  Object.defineProperty(globalThis, "__rpc", { value: rpc, configurable: true });
})();
${extra}
`;
}

/** Wrap user code: either an async function expression, or a function body that may `return`. */
export function wrapUserCode(code: string): string {
  const trimmed = code.trim().replace(/;+\s*$/, "");
  const isFunction = /^async\s*(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(trimmed) || /^async\s+function\b/.test(trimmed);
  const body = isFunction ? `return await (${trimmed})();` : code;
  return `(async () => {\n${body}\n})()`;
}

export async function runInSandbox(code: string, host: HostHandler, extraPrelude = "", limits: SandboxLimits = {}): Promise<SandboxResult> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryLimitBytes ?? 64 * 1024 * 1024);
  runtime.setMaxStackSize(limits.maxStackBytes ?? 1024 * 1024);
  const timeoutMs = limits.timeoutMs ?? 60_000;
  const cpuSliceMs = limits.cpuSliceMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let sliceStart = Date.now();
  let interruptedBy: "deadline" | "cpu" | undefined;
  runtime.setInterruptHandler(() => {
    const now = Date.now();
    if (now > deadline) interruptedBy = "deadline";
    else if (now - sliceStart > cpuSliceMs) interruptedBy = "cpu";
    return interruptedBy !== undefined;
  });

  const ctx = runtime.newContext();
  const logs: LogEntry[] = [];
  const deferreds = new Set<QuickJSDeferredPromise>();
  let disposed = false;
  let finish!: (r: SandboxResult) => void;
  const finished = new Promise<SandboxResult>((resolve) => (finish = resolve));
  let settled = false;
  const settle = (r: SandboxResult) => {
    if (settled) return;
    settled = true;
    finish(r);
  };

  const pump = () => {
    if (disposed || settled) return;
    sliceStart = Date.now();
    const res = runtime.executePendingJobs();
    if (res.error) {
      const err = dumpError(ctx, res.error);
      res.error.dispose();
      settle({ ok: false, error: interruptError(interruptedBy, timeoutMs, cpuSliceMs) ?? err, logs });
    }
  };

  try {
    const log = ctx.newFunction("__log", (levelH, textH) => {
      if (logs.length >= MAX_LOG_ENTRIES) return;
      const level = ctx.getString(levelH) as LogEntry["level"];
      let text = ctx.getString(textH);
      if (text.length > MAX_LOG_TEXT) text = text.slice(0, MAX_LOG_TEXT) + `… (${text.length - MAX_LOG_TEXT} more characters)`;
      logs.push({ level, text });
      if (logs.length === MAX_LOG_ENTRIES) logs.push({ level: "warn", text: "[further console output dropped]" });
    });
    ctx.setProp(ctx.global, "__log", log);
    log.dispose();

    const hostFn = ctx.newFunction("__host", (opH, payloadH) => {
      const op = ctx.getString(opH);
      const payloadText = ctx.getString(payloadH);
      const deferred = ctx.newPromise();
      deferreds.add(deferred);
      Promise.resolve()
        .then(() => host(op, JSON.parse(payloadText)))
        .then(
          (value) => JSON.stringify({ ok: true, value: value === undefined ? null : value }),
          (err) => JSON.stringify({ ok: false, error: serializeHostError(err) }),
        )
        .catch((err) => JSON.stringify({ ok: false, error: { name: "Error", message: `Host result could not be serialized: ${err}` } }))
        .then((json) => {
          if (disposed || settled) return;
          const s = ctx.newString(json);
          deferred.resolve(s);
          s.dispose();
          deferreds.delete(deferred);
          deferred.dispose();
          pump();
        });
      return deferred.handle;
    });
    ctx.setProp(ctx.global, "__host", hostFn);
    hostFn.dispose();

    const done = ctx.newFunction("__done", (jsonH) => {
      const r = JSON.parse(ctx.getString(jsonH));
      // An interrupt inside an async function surfaces as a rejection; report it as the timeout it is.
      const interrupted = interruptError(interruptedBy, timeoutMs, cpuSliceMs);
      settle(r.ok && !interrupted ? { ok: true, value: r.value, logs } : { ok: false, error: interrupted ?? r.error, logs });
    });
    ctx.setProp(ctx.global, "__done", done);
    done.dispose();

    sliceStart = Date.now();
    const pre = ctx.evalCode(prelude(extraPrelude), "prelude.js");
    if (pre.error) {
      const err = dumpError(ctx, pre.error);
      pre.error.dispose();
      throw new Error(`Sandbox prelude failed: ${err.message}`);
    }
    pre.value.dispose();

    const program = `
(() => {
  const done = __done; delete globalThis.__done;
  const safe = (v) => { try { return JSON.stringify({ ok: true, value: v === undefined ? null : v }); }
    catch (e) { return JSON.stringify({ ok: false, error: { name: "TypeError", message: "Script result is not JSON-serializable: " + e.message } }); } };
  ${wrapUserCode(code)}.then(
    (v) => done(safe(v)),
    (e) => done(JSON.stringify({ ok: false, error: { name: (e && e.name) || "Error", message: String(e && e.message !== undefined ? e.message : e), stack: e && e.stack } })),
  );
})();`;
    sliceStart = Date.now();
    const evaluated = ctx.evalCode(program, "script.js");
    if (evaluated.error) {
      const err = dumpError(ctx, evaluated.error);
      evaluated.error.dispose();
      settle({ ok: false, error: interruptError(interruptedBy, timeoutMs, cpuSliceMs) ?? err, logs });
    } else {
      evaluated.value.dispose();
      pump();
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<SandboxResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, error: { name: "TimeoutError", message: `Script did not finish within ${timeoutMs} ms` }, logs }),
        Math.max(0, deadline - Date.now()),
      );
    });
    const result = await Promise.race([finished, timedOut]);
    clearTimeout(timer);
    settled = true;
    return result;
  } finally {
    disposed = true;
    for (const d of deferreds) {
      try {
        d.dispose();
      } catch {
        /* already gone */
      }
    }
    try {
      ctx.dispose();
      runtime.dispose();
    } catch {
      // A script that was cut off mid-flight can leave objects QuickJS considers leaked; the
      // runtime is discarded either way.
    }
  }
}

function interruptError(by: "deadline" | "cpu" | undefined, timeoutMs: number, cpuSliceMs: number): SandboxError | undefined {
  if (by === "deadline") return { name: "TimeoutError", message: `Script did not finish within ${timeoutMs} ms` };
  if (by === "cpu") return { name: "TimeoutError", message: `Script computed for more than ${cpuSliceMs} ms without yielding` };
  return undefined;
}

function dumpError(ctx: QuickJSContext, handle: Parameters<QuickJSContext["dump"]>[0]): SandboxError {
  const v = ctx.dump(handle);
  if (v && typeof v === "object") return { name: v.name ?? "Error", message: String(v.message ?? v), stack: v.stack };
  return { name: "Error", message: String(v) };
}

function serializeHostError(err: unknown): { name: string; message: string; data?: Record<string, unknown> } {
  if (err instanceof Error) {
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(err)) if (k !== "name" && k !== "message" && k !== "stack") data[k] = v;
    return { name: err.name, message: err.message, ...(Object.keys(data).length ? { data } : {}) };
  }
  return { name: "Error", message: String(err) };
}
