/**
 * The executor contract of `@cloudflare/codemode`, so executors can be swapped
 * both ways: `QuickJSExecutor` works wherever a Cloudflare codemode executor
 * is expected, and `CodeMode` accepts other executors (for example
 * Cloudflare's `IframeSandboxExecutor` or `DynamicWorkerExecutor`).
 *
 * The types mirror `@cloudflare/codemode` 0.5.x structurally; they are copied
 * rather than imported because that package's types pull in
 * `cloudflare:workers`, `ai` and `zod`.
 */
import { runInSandbox, type SandboxLimits, type SandboxResult } from "./sandbox.js";

export interface ExecuteResult {
  result: unknown;
  error?: string;
  logs?: string[];
}

export type ToolFn = (...args: unknown[]) => Promise<unknown>;

/** Tool functions exposed in the sandbox as `name.<tool>(...)`. */
export interface ResolvedProvider {
  name: string;
  fns: Record<string, ToolFn>;
  /** Sandbox-side JavaScript run after the provider's namespace exists. */
  prelude?: string;
}

export interface Executor {
  execute(code: string, providersOrFns: ResolvedProvider[] | Record<string, ToolFn>, options?: unknown): Promise<ExecuteResult>;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

export function normalizeProviders(providersOrFns: ResolvedProvider[] | Record<string, ToolFn>): ResolvedProvider[] {
  return Array.isArray(providersOrFns) ? providersOrFns : [{ name: "codemode", fns: providersOrFns }];
}

function providerPrelude(providers: ResolvedProvider[]): string {
  const parts = [
    `const __call = globalThis.__rpc;`,
    `const __reserved = new Set(["then", "toJSON", "constructor", "valueOf", "toString"]);`,
    `const __ns = (provider) => new Proxy(Object.create(null), {
      get(target, name) {
        if (typeof name !== "string" || __reserved.has(name)) return undefined;
        if (Object.prototype.hasOwnProperty.call(target, name)) return target[name];
        return (...args) => __call("provider", { provider, name, args });
      },
      set(target, name, value) { target[name] = value; return true; },
      has: () => true,
    });`,
  ];
  for (const p of providers) {
    if (!IDENT.test(p.name)) throw new TypeError(`Provider name "${p.name}" is not a valid identifier`);
    parts.push(`globalThis.${p.name} = __ns(${JSON.stringify(p.name)});`);
  }
  // Provider preludes run last, each in its own scope, and may add real functions to their namespace.
  for (const p of providers) if (p.prelude) parts.push(`{\n${p.prelude}\n}`);
  return `(() => {\n${parts.join("\n")}\ndelete globalThis.__rpc;\n})();`;
}

export interface QuickJSExecutorOptions extends SandboxLimits {}

/**
 * Runs code in a fresh QuickJS context per execution, with memory, stack, wall-clock and
 * CPU-slice limits. Unlike a browser iframe or worker, its timeout also stops tight
 * synchronous loops.
 */
export class QuickJSExecutor implements Executor {
  constructor(private readonly options: QuickJSExecutorOptions = {}) {}

  async execute(code: string, providersOrFns: ResolvedProvider[] | Record<string, ToolFn>): Promise<ExecuteResult> {
    try {
      const r = await this.run(code, normalizeProviders(providersOrFns));
      const logs = r.logs.map((l) => (l.level === "log" || l.level === "info" ? l.text : `[${l.level}] ${l.text}`));
      return r.ok ? { result: r.value, logs } : { result: undefined, error: r.error.message, logs };
    } catch (err) {
      return { result: undefined, error: err instanceof Error ? err.message : String(err), logs: [] };
    }
  }

  /** Like execute(), but keeps error names, extra error properties and log levels. */
  run(code: string, providers: ResolvedProvider[]): Promise<SandboxResult> {
    const byName = new Map(providers.map((p) => [p.name, p]));
    return runInSandbox(
      code,
      async (op, payload) => {
        if (op !== "provider") throw new TypeError(`Unknown operation ${op}`);
        const provider = byName.get(payload?.provider);
        const fn = provider?.fns[payload?.name];
        if (typeof fn !== "function") throw new Error(`Tool "${payload?.name}" not found`);
        return fn(...(Array.isArray(payload.args) ? payload.args : []));
      },
      providerPrelude(providers),
      this.options,
    );
  }
}
