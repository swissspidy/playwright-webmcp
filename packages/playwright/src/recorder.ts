/**
 * In-page recorder. Wraps registerTool / provideContext / executeTool on
 * whichever modelContext exists (native or shim) so tool executions triggered
 * from inside the page are reported to Playwright through the
 * `__webmcpReport` binding. Calls made through the fixture's `call()` are
 * recorded on the Node side instead and are skipped here.
 */
export const RECORDER_SOURCE = String.raw`(() => {
  const marker = "__webmcpRecorderInstalled";
  let suppress = 0;
  function report(entry) {
    try {
      const fn = window.__webmcpReport;
      if (typeof fn === "function") fn(JSON.stringify(entry));
    } catch {}
  }
  function safe(v) {
    try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); } catch { return String(v); }
  }
  // executeTool() resolves with the result serialized to a JSON string; record the value it encodes.
  function fromExecuteTool(v) {
    if (typeof v !== "string") return safe(v);
    if (v === "undefined") return undefined;
    try { return JSON.parse(v); } catch { return v; }
  }
  // Mocks installed from the test take over inside the execute wrapper, so no
  // re-registration is needed (native rejects duplicate names).
  const mocks = (window.__webmcpMocks = window.__webmcpMocks || Object.create(null));
  const wrappedNames = (window.__webmcpWrappedTools = window.__webmcpWrappedTools || new Set());
  async function runMock(name, args) {
    const reply = JSON.parse(await window.__webmcpMock(JSON.stringify({ name, args: args === undefined ? {} : args })));
    if (reply && reply.__error) throw new Error(reply.__error);
    return reply === null ? undefined : reply;
  }
  function wrapExecute(name, execute) {
    const wrapped = async function (args, options) {
      const startedAt = Date.now();
      const impl = mocks[name] ? runMock.bind(null, name) : execute;
      if (suppress > 0) return impl.call(this, args, options);
      try {
        const result = await impl.call(this, args, options);
        report({ kind: "call", name, args: safe(args), result: safe(result), startedAt, durationMs: Date.now() - startedAt, via: "api" });
        return result;
      } catch (err) {
        report({ kind: "call", name, args: safe(args), error: String((err && err.message) || err), startedAt, durationMs: Date.now() - startedAt, via: "api" });
        throw err;
      }
    };
    wrapped.__webmcpWrapped = true;
    return wrapped;
  }
  function nowMs() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }
  function reportRegistration(type, name) {
    report({ kind: "registration", type, name, at: nowMs(), frameUrl: location.href });
  }
  function wrapTool(tool) {
    if (tool && typeof tool.execute === "function" && !tool.execute.__webmcpWrapped) {
      wrappedNames.add(tool.name);
      return Object.assign({}, tool, { execute: wrapExecute(tool.name, tool.execute) });
    }
    return tool;
  }
  function install(mc) {
    if (!mc || mc[marker]) return;
    Object.defineProperty(mc, marker, { value: true });
    const origRegister = typeof mc.registerTool === "function" ? mc.registerTool.bind(mc) : null;
    const origProvide = typeof mc.provideContext === "function" ? mc.provideContext.bind(mc) : null;
    const origExecuteTool = typeof mc.executeTool === "function" ? mc.executeTool.bind(mc) : null;
    const origUnregister = typeof mc.unregisterTool === "function" ? mc.unregisterTool.bind(mc) : null;
    const origClear = typeof mc.clearContext === "function" ? mc.clearContext.bind(mc) : null;
    if (origRegister) mc.registerTool = async (tool, options) => {
      if (options && options.signal) options.signal.addEventListener("abort", () => reportRegistration("unregistered", tool && tool.name), { once: true });
      const r = await origRegister(wrapTool(tool), options);
      reportRegistration("registered", tool && tool.name);
      return r;
    };
    if (origProvide) mc.provideContext = async (ctx) => {
      const r = await origProvide(ctx && Array.isArray(ctx.tools) ? Object.assign({}, ctx, { tools: ctx.tools.map(wrapTool) }) : ctx);
      for (const t of (ctx && ctx.tools) || []) reportRegistration("registered", t && t.name);
      return r;
    };
    if (origUnregister) mc.unregisterTool = (name) => { const r = origUnregister(name); reportRegistration("unregistered", name); return r; };
    if (origClear) mc.clearContext = () => { const r = origClear(); reportRegistration("unregistered", "*"); return r; };
    if (origExecuteTool) {
      mc.executeTool = async (tool, args, options) => {
        const fromFixture = Boolean(options && options.__playwrightWebmcp);
        const name = typeof tool === "string" ? tool : tool && tool.name;
        const parsedArgs = typeof args === "string" ? JSON.parse(args) : args;
        const startedAt = Date.now();
        suppress++;
        try {
          const result = await origExecuteTool(tool, args, options);
          suppress--;
          if (!fromFixture) report({ kind: "call", name, args: safe(parsedArgs), result: fromExecuteTool(result), startedAt, durationMs: Date.now() - startedAt, via: "api" });
          return result;
        } catch (err) {
          suppress--;
          if (!fromFixture) report({ kind: "call", name, args: safe(parsedArgs), error: String((err && err.message) || err), startedAt, durationMs: Date.now() - startedAt, via: "api" });
          throw err;
        }
      };
    }
  }
  window.__webmcpInstallMock = async function (name) {
    const mc = document.modelContext || navigator.modelContext;
    if (!mc) throw new Error("No modelContext to mock on");
    const listed = await mc.getTools();
    if (!listed.some((t) => t.name === name)) throw new Error("No tool named " + name + " to mock");
    if (!wrappedNames.has(name)) throw new Error("Tool " + name + " cannot be mocked: it was not registered through modelContext.registerTool() in this frame");
    mocks[name] = true;
  };
  window.__webmcpRestoreMock = async function (name) {
    const had = Boolean(mocks[name]);
    delete mocks[name];
    return had;
  };
  const tryInstall = () => {
    install(document.modelContext);
    if (navigator.modelContext && navigator.modelContext !== document.modelContext) install(navigator.modelContext);
  };
  tryInstall();
  document.addEventListener("DOMContentLoaded", tryInstall, { once: true });
})();`;
