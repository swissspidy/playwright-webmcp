# @swissspidy/webmcp-lint

## 0.5.0

### Minor Changes

- [#77](https://github.com/swissspidy/playwright-webmcp/pull/77) [`38d5c2a`](https://github.com/swissspidy/playwright-webmcp/commit/38d5c2a8527835c881e6f2d58437f88ba0ed298a) Thanks [@swissspidy](https://github.com/swissspidy)! - Breaking: `isReadOnly` is no longer exported from `@swissspidy/playwright-webmcp`; it was a deprecated alias of `isReadOnlyTool` from `@swissspidy/webmcp-lint`.
  
  A rule option that takes one of a fixed set of values now rejects anything else: `tool-name-style` with a `style` it does not know throws from `lint()`, is a usage error in the `webmcp-lint` CLI and fails ESLint's option validation, where it used to report nothing. Rules declare such options with `enums`.
  
  `@swissspidy/webmcp-lint` exports `findingsAtOrAbove()` (what `failOn` and `--fail-on` mean) and `UsageError`.

### Patch Changes

- [#77](https://github.com/swissspidy/playwright-webmcp/pull/77) [`38d5c2a`](https://github.com/swissspidy/playwright-webmcp/commit/38d5c2a8527835c881e6f2d58437f88ba0ed298a) Thanks [@swissspidy](https://github.com/swissspidy)! - Fixes from a pass over the whole repository.
  
  - `@swissspidy/webmcp-lint`: `lint()`, `diffContracts()`, `generateArguments()` and `renderToolDocs()` no longer throw on an `inputSchema` whose property is `null`. A clean page with full coverage scores 100 instead of 99. Lenient `reconcileCalls()` finds the assignment in an unordered group where a loose expectation could take a stricter one's call. Smoke inputs match their labels: no empty string under `minLength`, no "wrong type" that the declared types accept, no string of `maxLength` beyond 100,000 characters. `result-string-json` fires only for a string that encodes an object or an array. The `webmcp-lint` CLI exits 2 on an unknown `--rule` id and on a `tools` entry that is not a tool. Generated code keeps a quote inside an argument key, and `TOOLS.md` keeps a multi-line parameter description on one table row.
  - `@swissspidy/webmcp-audit`: with `--smoke`, links are read before tools are called, so a tool that navigates no longer sends the crawl to the wrong page's links. The browser is closed when setup fails. The CLI rejects a URL that is not http(s) and `--max-pages 0`, and creates `--out` before the crawl.
  - `@swissspidy/eslint-plugin-webmcp`: a tool-shaped literal that is changed after it is written (`tool.description = ...`) is left alone. `navigation-consequential` no longer takes `args.location.replace()`, a `location` or `history` parameter, or `state.location = ...` for navigation. In JSX forms, a spread on the `<form>` may carry the description, a `<label htmlFor>` outside the form counts, a radio group is one parameter, and an empty `aria-label` is not a label. A null `title` inside `inputSchema` is reported at the schema.
  - `@swissspidy/playwright-webmcp`: a `promptApi` run that times out says so in `reason`.
  - A declarative tool's `formLocator` no longer ends in an `:nth-of-type()` that did not identify the form. The ESLint plugin extracts each file's tools once instead of once per rule. The audit no longer installs the in-page recorder it never read, and its help says that `--header` requests each page twice.

## 0.4.0

### Minor Changes

- [#67](https://github.com/swissspidy/playwright-webmcp/pull/67) [`9e84ed5`](https://github.com/swissspidy/playwright-webmcp/commit/9e84ed50a6f9d8ca04488afbea672642a4f23af6) Thanks [@swissspidy](https://github.com/swissspidy)! - `toHaveTool` and `toPassLint` accept Playwright's own `page.webmcp` and `frame.webmcp` (Playwright 1.64 and later). The README compares the native API with the `webmcp` fixture.
  
  Breaking: Chrome and Chromium 154 and earlier are no longer supported. `executeTool()` input is always sent as an object, `inputSchema` and annotations returned as JSON strings are no longer parsed, and `webmcp.inputShape()`, `executeToolInputShape()`, `chromiumMajor()` and the `ExecuteToolInputShape` type are removed.

## 0.3.0

### Minor Changes

- [#46](https://github.com/swissspidy/playwright-webmcp/pull/46) [`fa14c0b`](https://github.com/swissspidy/playwright-webmcp/commit/fa14c0bf3f23b2c2079ec8f75aedcc80d5694672) Thanks [@swissspidy](https://github.com/swissspidy)! - Smoke reports `result-writes` (error) when a tool that declares `readOnlyHint` sends a request other than GET, HEAD or OPTIONS to the page's origin during the call, and `result-writes-cross-origin` (warning) when the request goes to another origin. `firstPartyOrigins` (`--first-party-origin` in the audit CLI) marks a backend on another host as the site's own. `runSmoke()` takes a `SmokeWatch` (`watchPage(page)` for a Playwright page) as its fourth argument; a bare URL getter still works. Requests the page sends on its own, such as analytics, can be left out with `ignoreRequests` (URL globs, regular expressions or a predicate that also gets the request body), or `--ignore-request <glob>` in the audit CLI.

- [#48](https://github.com/swissspidy/playwright-webmcp/pull/48) [`1476e1b`](https://github.com/swissspidy/playwright-webmcp/commit/1476e1b34c8901f94052fbd61846ee3242845388) Thanks [@swissspidy](https://github.com/swissspidy)! - The fixture records `toolactivated` and `toolcancel` events (`events()`, `waitForEvent()`, and `toolEvents` in `timeline()`), and can cancel calls: `call()` takes a `signal` and `cancelAfter` (milliseconds, or `"activated"`), and `cancel(name)` cancels pending calls, an agent's included when the browser has the CDP `WebMCP` domain. A canceled call rejects with `ToolCanceledError` and is recorded with `canceled: true`.
  
  New ESLint rule `webmcp/consequential-abort-signal` (warning, in `recommended`): a tool that declares `consequentialHint` and waits in its `execute` should read the abort signal it is given, so a canceled call stops instead of carrying out its side effect.

## 0.2.0

No changes in this release.

## 0.1.0

### Minor Changes

- [#16](https://github.com/swissspidy/playwright-webmcp/pull/16) [`7d0d42e`](https://github.com/swissspidy/playwright-webmcp/commit/7d0d42e4e662c9e84b3e683a4bbdf964fa7f1818) Thanks [@swissspidy](https://github.com/swissspidy)! - Initial release.
  
  - `@swissspidy/webmcp-lint`: the rule engine (tool and page rules, injection scanning, `capability-trifecta`, `tool-shadowing`, `third-party-registration`, and the opt-in `tool-name-style`, `tool-title-missing`, `description-when-to-use` and `annotations-explicit`), `lintTools()`, `snapshotFromFrames()`, a `webmcp-lint` CLI, schema-driven smoke checks, tool contracts, coverage, scoring, codegen, docs, and the `webmcp-evals` argument and trajectory matchers.
  - `@swissspidy/playwright-webmcp`: `test`/`expect` with the `webmcp` fixture (discovery in every frame, `call()`, recording, lint, smoke, contracts, mocks, timeline), the CDP `WebMCP` collector, the `promptApi` fixture on Chromium's Prompt API tool-use protocol, `toolsForAgent()`/`runAgent()`/`toPassEval` for agents you run from Node, and a reporter that writes `tools.json`, `coverage.json` and `TOOLS.md`.
  - `@swissspidy/webmcp-audit`: a crawler and CLI that lints every page, runs smoke calls, detects cross-page drift, compares with a baseline and scores agent readiness.
  - `@swissspidy/eslint-plugin-webmcp`: the tool-scoped rules as ESLint rules for `registerTool()`, `useWebMCP()`, your own wrappers, tool-shaped object literals exported for registration elsewhere, and `<form toolname>` in JSX, plus `valid-event-name`, `no-interpolated-text` and `navigation-consequential`; loads in oxlint.
  
  Every rule has a generated reference page under `docs/rules/`, which is also where a finding's `url` points from the ESLint plugin.
  
  Everything runs against the browser's own WebMCP implementation (`document.modelContext`): Playwright's Chromium with `--enable-features=WebMCP`, or Chrome Beta and Canary.
