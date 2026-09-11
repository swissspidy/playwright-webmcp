/**
 * Test-time implementation of the WebMCP API for browsers without native
 * support. Installed via page.addInitScript, so it is shipped as a string.
 *
 * Covers: document.modelContext / navigator.modelContext with registerTool,
 * unregisterTool, provideContext, clearContext, getTools, executeTool,
 * `toolchange` events, and declarative <form toolname> tools including
 * SubmitEvent.respondWith / agentInvoked and toolautosubmit.
 *
 * It is not a polyfill for production use; it exists so tests can run on any
 * Chromium build. When native support is present the shim does nothing.
 */
export interface ShimSourceOptions {
  /** Install even when the browser already has a native modelContext. Default false. */
  force?: boolean;
}

/** Source of the shim as an init script. */
export function shimSource(options: ShimSourceOptions = {}): string {
  return SHIM_TEMPLATE.replace("__WEBMCP_FORCE_SHIM__", options.force ? "true" : "false");
}

const SHIM_TEMPLATE = String.raw`(() => {
  const FORCE = __WEBMCP_FORCE_SHIM__;
  if (!FORCE && (document.modelContext || (navigator && navigator.modelContext))) return;
  const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
  const tools = new Map();
  const target = new EventTarget();

  function fire() {
    const ev = new Event("toolchange");
    target.dispatchEvent(ev);
    if (typeof mc.ontoolchange === "function") mc.ontoolchange(ev);
  }

  function publicTool(t) {
    return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations, window: t.window, origin: t.origin, execute: t.execute, exposedTo: t.exposedTo };
  }
  function remoteTool(t, win, origin) {
    return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations, window: win, origin, _isRemote: true };
  }
  function exposedToOrigin(t, origin) {
    return Array.isArray(t.exposedTo) && (t.exposedTo.includes("*") || t.exposedTo.includes(origin));
  }

  function normalize(tool) {
    if (!tool || typeof tool !== "object") throw new TypeError("registerTool: tool must be an object");
    if (typeof tool.name !== "string" || !NAME_RE.test(tool.name)) throw new TypeError("registerTool: invalid tool name " + JSON.stringify(tool.name));
    return {
      name: tool.name,
      title: typeof tool.title === "string" ? tool.title : "",
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: tool.inputSchema === undefined ? null : tool.inputSchema,
      annotations: tool.annotations,
      execute: typeof tool.execute === "function" ? tool.execute : undefined,
      window,
      origin: location.origin,
    };
  }

  function sameOriginChildContexts() {
    const out = [];
    for (const f of document.querySelectorAll("iframe")) {
      try {
        const doc = f.contentDocument;
        if (doc && doc.modelContext) out.push(doc.modelContext);
      } catch {}
    }
    return out;
  }

  const mc = {
    __webmcpShim: true,
    ontoolchange: null,
    addEventListener: (...a) => target.addEventListener(...a),
    removeEventListener: (...a) => target.removeEventListener(...a),
    dispatchEvent: (e) => target.dispatchEvent(e),
    async registerTool(tool, options = {}) {
      const t = normalize(tool);
      if (Array.isArray(options.exposedTo)) {
        for (const o of options.exposedTo) {
          if (o !== "*" && !/^https:\/\//.test(o) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) throw new DOMException("exposedTo origins must be secure: " + o, "NotAllowedError");
        }
        t.exposedTo = options.exposedTo.slice();
      }
      tools.set(t.name, t);
      if (options.signal) options.signal.addEventListener("abort", () => mc.unregisterTool(t.name), { once: true });
      fire();
    },
    unregisterTool(name) {
      if (tools.delete(name)) fire();
    },
    async provideContext(ctx = {}) {
      tools.clear();
      for (const tool of ctx.tools || []) tools.set(tool.name, normalize(tool));
      fire();
    },
    clearContext() {
      tools.clear();
      fire();
    },
    async getTools(options = {}) {
      const own = [...tools.values()].map(publicTool);
      const nested = [];
      for (const child of sameOriginChildContexts()) {
        try { nested.push(...(await child.getTools())); } catch {}
      }
      const wanted = Array.isArray(options.fromOrigins) ? options.fromOrigins : [];
      if (wanted.length) {
        for (const f of crossOriginFrames()) {
          if (!wanted.includes("*") && !wanted.includes(f.origin)) continue;
          if (!allowsTools(f.element)) continue;
          try {
            const list = await bridgeRequest(f.element.contentWindow, f.origin, { type: "webmcp:list" });
            for (const t of list) nested.push(remoteTool(t, f.element.contentWindow, f.origin));
          } catch {}
        }
      }
      return own.concat(nested);
    },
    async executeTool(toolOrName, args, options = {}) {
      const name = typeof toolOrName === "string" ? toolOrName : toolOrName && toolOrName.name;
      if (toolOrName && toolOrName._isRemote) {
        const parsedRemote = typeof args === "string" ? JSON.parse(args) : (args || {});
        const reply = await bridgeRequest(toolOrName.window, toolOrName.origin, { type: "webmcp:execute", name, args: parsedRemote });
        if (reply && reply.__error) throw new DOMException(reply.__error, "OperationError");
        return reply;
      }
      let t = tools.get(name);
      if (!t) {
        for (const child of sameOriginChildContexts()) {
          const list = await child.getTools();
          if (list.some((x) => x.name === name)) return child.executeTool(name, args, options);
        }
        throw new DOMException("No tool named " + name, "NotFoundError");
      }
      const parsed = typeof args === "string" ? JSON.parse(args) : (args || {});
      if (!t.execute) throw new DOMException("Tool " + name + " has no execute callback", "InvalidStateError");
      return await t.execute(parsed, { signal: options.signal });
    },
  };

  // Cross-origin bridge. The embedder gates access with allow="tools" on the
  // <iframe>; the embedded frame only answers for tools whose exposedTo
  // includes the requesting origin.
  function crossOriginFrames() {
    const out = [];
    for (const element of document.querySelectorAll("iframe")) {
      let same = true;
      try { void element.contentDocument; same = Boolean(element.contentDocument); } catch { same = false; }
      if (same) continue;
      let origin = null;
      try { origin = new URL(element.src, location.href).origin; } catch {}
      if (origin && element.contentWindow) out.push({ element, origin });
    }
    return out;
  }
  function allowsTools(element) {
    const allow = element.getAttribute("allow") || "";
    return allow.split(/[;\s]+/).map((s) => s.trim()).includes("tools");
  }
  let bridgeSeq = 0;
  function bridgeRequest(win, origin, message, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const id = "webmcp-" + (++bridgeSeq) + "-" + Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { window.removeEventListener("message", onMessage); reject(new Error("WebMCP bridge timeout")); }, timeoutMs);
      function onMessage(event) {
        if (event.source !== win || !event.data || event.data.type !== "webmcp:reply" || event.data.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(event.data.payload);
      }
      window.addEventListener("message", onMessage);
      win.postMessage(Object.assign({ id }, message), origin);
    });
  }
  window.addEventListener("message", async (event) => {
    const data = event.data;
    if (!data || typeof data.type !== "string" || !data.type.startsWith("webmcp:") || data.type === "webmcp:reply") return;
    if (!event.source || event.origin === location.origin) return;
    const reply = (payload) => event.source.postMessage({ type: "webmcp:reply", id: data.id, payload }, event.origin);
    if (data.type === "webmcp:list") {
      reply([...tools.values()].filter((t) => exposedToOrigin(t, event.origin)).map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })));
    } else if (data.type === "webmcp:execute") {
      const t = tools.get(data.name);
      if (!t || !exposedToOrigin(t, event.origin)) return reply({ __error: "Tool " + data.name + " is not exposed to " + event.origin });
      try {
        const result = await mc.executeTool(data.name, data.args || {}, {});
        reply(result === undefined ? null : JSON.parse(JSON.stringify(result)));
      } catch (err) {
        reply({ __error: String((err && err.message) || err) });
      }
    }
  });

  // Declarative forms.
  const formTools = new Map();
  function fieldType(el) {
    const tag = el.tagName.toLowerCase();
    return tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : tag;
  }
  function schemaFor(form) {
    const properties = {};
    const required = [];
    for (const el of form.elements) {
      const name = el.getAttribute && el.getAttribute("name");
      if (!name) continue;
      const type = fieldType(el);
      if (["submit", "button", "reset", "hidden", "fieldset"].includes(type)) continue;
      const prop = { type: type === "number" || type === "range" ? "number" : type === "checkbox" ? "boolean" : "string" };
      const d = el.getAttribute("toolparamdescription");
      if (d) prop.description = d;
      if (el.tagName.toLowerCase() === "select") prop.enum = Array.from(el.options).map((o) => o.value);
      properties[name] = prop;
      if (el.hasAttribute("required")) required.push(name);
    }
    const schema = { type: "object", properties };
    if (required.length) schema.required = required;
    return schema;
  }
  function fill(form, args) {
    for (const [k, v] of Object.entries(args || {})) {
      const el = form.elements.namedItem(k);
      if (!el) continue;
      if (fieldType(el) === "checkbox") el.checked = Boolean(v);
      else el.value = String(v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  function submitAsAgent(form) {
    return new Promise((resolve) => {
      const submitter = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      const ev = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter });
      let responded = null;
      Object.defineProperty(ev, "agentInvoked", { value: true });
      Object.defineProperty(ev, "respondWith", { value: (p) => { responded = Promise.resolve(p); ev.preventDefault(); } });
      form.dispatchEvent(ev);
      if (responded) return resolve(responded);
      if (ev.defaultPrevented) return resolve({ status: "Completed" });
      form.submit();
      resolve({ status: "Navigating" });
    });
  }
  function registerForm(form) {
    const name = form.getAttribute("toolname");
    if (!name || !NAME_RE.test(name)) return;
    const entry = {
      name,
      description: form.getAttribute("tooldescription") || "",
      inputSchema: schemaFor(form),
      window,
      origin: location.origin,
      execute: async (args) => {
        fill(form, args);
        form.dispatchEvent(new Event("toolactivated", { bubbles: true }));
        if (form.hasAttribute("toolautosubmit")) return submitAsAgent(form);
        return { status: "Pending", message: "Form filled; awaiting user submission." };
      },
    };
    formTools.set(form, name);
    tools.set(name, entry);
  }
  function scan() {
    let changed = false;
    for (const form of document.querySelectorAll("form[toolname]")) {
      if (!formTools.has(form)) { registerForm(form); changed = true; }
    }
    for (const [form, name] of formTools) {
      if (!document.contains(form)) { formTools.delete(form); tools.delete(name); changed = true; }
    }
    if (changed) fire();
  }
  const start = () => {
    scan();
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["toolname", "tooldescription", "toolautosubmit"] });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();

  Object.defineProperty(document, "modelContext", { value: mc, configurable: true, enumerable: true });
  try { Object.defineProperty(navigator, "modelContext", { value: mc, configurable: true, enumerable: true }); } catch {}
})();`;

/** The shim source with default options, for callers that only need the auto-detecting variant. */
export const SHIM_SOURCE = shimSource();
