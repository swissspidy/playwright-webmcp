/**
 * In-page recorder. Wraps registerTool / executeTool on `document.modelContext`
 * so tool executions triggered from inside the page are reported to
 * Playwright through the `__webmcpReport` binding. Calls made through the
 * fixture's `call()` are recorded on the Node side instead and are skipped
 * here.
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
  // re-registration is needed (the API rejects duplicate names).
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
  // Registrations are numbered per document, so a rejection can take back exactly the report it follows.
  const documentId = Math.random().toString(36).slice(2);
  let registrations = 0;
  function reportRegistration(type, name, id) {
    report({ kind: "registration", type, name, id, at: nowMs(), frameUrl: location.href });
  }
  function wrapTool(tool) {
    if (tool && typeof tool.execute === "function" && !tool.execute.__webmcpWrapped) {
      return Object.assign({}, tool, { execute: wrapExecute(tool.name, tool.execute) });
    }
    return tool;
  }
  function isWrapped(tool) {
    return Boolean(tool && typeof tool.execute === "function");
  }
  function install(mc) {
    if (!mc || mc[marker]) return;
    Object.defineProperty(mc, marker, { value: true });
    const origRegister = typeof mc.registerTool === "function" ? mc.registerTool.bind(mc) : null;
    const origExecuteTool = typeof mc.executeTool === "function" ? mc.executeTool.bind(mc) : null;
    if (origRegister) mc.registerTool = async (tool, options) => {
      const name = tool && tool.name;
      // The timeline hears about a registration when the page makes it, not when registerTool()
      // settles. The browser accepts it at once, but in a child frame under load the promise can take
      // seconds to resolve: reporting then would date the tool seconds late, flagging it as registered
      // after load, or leave it out of a timeline read in between. A rejection, such as a duplicate
      // name, takes the report back.
      const id = documentId + ":" + ++registrations;
      reportRegistration("registered", name, id);
      let rejected = false;
      if (options && options.signal) options.signal.addEventListener("abort", () => {
        if (!rejected) reportRegistration("unregistered", name, id);
      }, { once: true });
      let r;
      try {
        r = await origRegister(wrapTool(tool), options);
      } catch (err) {
        rejected = true;
        reportRegistration("rejected", name, id);
        throw err;
      }
      // Only a registration the browser accepted is mockable, and only its own abort signal removes it:
      // a rejected duplicate must neither mark the original nor unmark it later.
      if (isWrapped(tool)) wrappedNames.add(name);
      if (options && options.signal) options.signal.addEventListener("abort", () => wrappedNames.delete(name), { once: true });
      return r;
    };
    if (origExecuteTool) {
      mc.executeTool = async (tool, args, options) => {
        const fromFixture = Boolean(options && options.__playwrightWebmcp);
        const name = typeof tool === "string" ? tool : tool && tool.name;
        let parsedArgs = args;
        if (typeof args === "string") { try { parsedArgs = JSON.parse(args); } catch { parsedArgs = { raw: args }; } }
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
    const mc = document.modelContext;
    if (!mc) throw new Error("No modelContext to mock on");
    const listed = await mc.getTools();
    if (!listed.some((t) => t.name === name)) throw new Error("No tool named " + name + " to mock");
    if (!wrappedNames.has(name)) throw new Error("Tool " + name + " cannot be mocked: it was not registered through document.modelContext.registerTool() in this frame");
    mocks[name] = true;
  };
  window.__webmcpRestoreMock = async function (name) {
    const had = Boolean(mocks[name]);
    delete mocks[name];
    return had;
  };
  const tryInstall = () => install(document.modelContext);
  tryInstall();
  document.addEventListener("DOMContentLoaded", tryInstall, { once: true });
})();`;
