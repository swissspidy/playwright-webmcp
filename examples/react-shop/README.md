# react-shop

A small Vite + React app that exposes WebMCP tools three ways, with the whole toolchain from this repository attached:

- `src/tools.js` defines `search_products` as a plain object and `add_to_cart` through a project wrapper, `defineShopTool()`.
- `src/App.jsx` registers them with [`useWebMCP`](https://www.npmjs.com/package/use-webmcp-tool) and renders `<form toolname="subscribe_newsletter">` as a declarative tool that answers agents through `SubmitEvent.respondWith`.
- `eslint.config.js` runs `@swissspidy/eslint-plugin-webmcp` on all of it. The wrapper is declared once under `settings.webmcp.definitions`; the plugin follows the `const` bindings and lints the JSX form with the declarative rules.
- `tests/shop.spec.js` uses the `@swissspidy/playwright-webmcp` fixture against the built app: tool shapes, page-level lint, real calls, the MCP `content` result shape `use-webmcp-tool` produces, smoke runs and coverage.

```sh
pnpm install
pnpm --filter react-shop lint     # static rules, in the editor and on CI
pnpm --filter react-shop test     # builds the app, then runs the Playwright suite
pnpm --filter react-shop dev      # open it in a browser
```

To see the plugin at work, shorten a description in `src/tools.js` or remove a `<label>` in `App.jsx` and run `lint` again. The Playwright suite runs on Playwright's Chromium with `--enable-features=WebMCP`; to run it on another Chrome build instead:

```sh
PW_CHROMIUM=/opt/google/chrome-beta/chrome pnpm --filter react-shop test
```
