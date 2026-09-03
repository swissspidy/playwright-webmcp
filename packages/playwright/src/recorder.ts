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
  function wrapExecute(name, execute) {
    const wrapped = async function (args, options) {
      const startedAt = Date.now();
      if (suppress > 0) return execute.call(this, args, options);
      try {
        const result = await execute.call(this, args, options);
        report({ name, args: safe(args), result: safe(result), startedAt, durationMs: Date.now() - startedAt, via: "api" });
        return result;
      } catch (err) {
        report({ name, args: safe(args), error: String((err && err.message) || err), startedAt, durationMs: Date.now() - startedAt, via: "api" });
        throw err;
      }
    };
    wrapped.__webmcpWrapped = true;
    return wrapped;
  }
  function wrapTool(tool) {
    if (tool && typeof tool.execute === "function" && !tool.execute.__webmcpWrapped) {
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
    if (origRegister) mc.registerTool = (tool, options) => origRegister(wrapTool(tool), options);
    if (origProvide) mc.provideContext = (ctx) => origProvide(ctx && Array.isArray(ctx.tools) ? Object.assign({}, ctx, { tools: ctx.tools.map(wrapTool) }) : ctx);
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
          if (!fromFixture) report({ name, args: safe(parsedArgs), result: safe(result), startedAt, durationMs: Date.now() - startedAt, via: "api" });
          return result;
        } catch (err) {
          suppress--;
          if (!fromFixture) report({ name, args: safe(parsedArgs), error: String((err && err.message) || err), startedAt, durationMs: Date.now() - startedAt, via: "api" });
          throw err;
        }
      };
    }
  }
  const tryInstall = () => {
    install(document.modelContext);
    if (navigator.modelContext && navigator.modelContext !== document.modelContext) install(navigator.modelContext);
  };
  tryInstall();
  document.addEventListener("DOMContentLoaded", tryInstall, { once: true });
})();`;
