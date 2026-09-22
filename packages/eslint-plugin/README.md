# @swissspidy/eslint-plugin-webmcp

ESLint rules for [WebMCP](https://github.com/webmachinelearning/webmcp) tool definitions. Every rule is one of the tool-scoped rules of [`webmcp-lint`](https://www.npmjs.com/package/webmcp-lint), run statically against the object literals passed to `registerTool()`, so problems show up in the editor and in `eslint` on CI before a browser ever loads the page.

```sh
npm install --save-dev @swissspidy/eslint-plugin-webmcp eslint
```

```js
// eslint.config.js
import webmcp from "@swissspidy/eslint-plugin-webmcp";

export default [
  webmcp.configs.recommended,
  // or pick rules yourself:
  {
    plugins: { webmcp },
    rules: {
      "webmcp/description-length": ["warn", { min: 30, max: 400 }],
      "webmcp/sensitive-params": "error",
    },
  },
];
```

```js
document.modelContext.registerTool({
  name: "add to cart", // webmcp/tool-name-valid: not a valid WebMCP tool name
  description: "Add.", // webmcp/description-length: 4 characters; aim for at least 20
  inputSchema: {
    type: "object",
    properties: { apiKey: { type: "string" } }, // webmcp/sensitive-params, webmcp/param-description-missing
    required: ["apiKey"],
  },
  async execute({ apiKey }) {},
});
```

## Rules

Definition rules judge what a tool declares. They are the tool-scoped rules of `webmcp-lint`, so a finding here is the same finding `playwright-webmcp` and `webmcp-audit` report from a live page.

| Rule                                      | Recommended | Checks                                                                                                                                          |
| ----------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `webmcp/tool-name-valid`                  | error       | Name is 1-128 chars of `[A-Za-z0-9_.-]`.                                                                                                        |
| `webmcp/tool-name-style`                  | off         | Name follows the project's `style` (`snake_case` by default) and `prefix`.                                                                      |
| `webmcp/tool-title-missing`               | off         | The tool has a `title` for clients to show people.                                                                                              |
| `webmcp/description-missing`              | error       | The tool has a description.                                                                                                                     |
| `webmcp/description-placeholder`          | error       | The description, title or a parameter description is not `TODO`, `lorem ipsum`, `...` and the like.                                             |
| `webmcp/description-length`               | warn        | Between `min` (20) and `max` (600) characters.                                                                                                  |
| `webmcp/param-description-missing`        | warn        | Every input property has a description.                                                                                                         |
| `webmcp/schema-shape`                     | error       | Object schema; `required` entries exist in `properties`.                                                                                        |
| `webmcp/schema-no-null-literals`          | error       | No `null` anywhere in the schema (Chrome's Prompt API rejects it).                                                                              |
| `webmcp/schema-depth`                     | warn        | Property nesting at most `max` (3) levels.                                                                                                      |
| `webmcp/schema-unsupported-keywords`      | warn        | Flags `$ref`, `allOf`, `oneOf`, `anyOf`, `not`, `if`/`then`/`else`, `patternProperties`.                                                        |
| `webmcp/sensitive-params`                 | warn        | Parameter names that look like credentials or payment data (`pattern` overrides).                                                               |
| `webmcp/description-injection`            | error       | Instructions to the agent, role markers, or hidden characters in any tool text.                                                                 |
| `webmcp/annotations-valid`                | error       | Hints are `readOnlyHint`, `untrustedContentHint`, `consequentialHint`, `debugging`, with boolean values; MCP hints and CDP spellings are named. |
| `webmcp/annotations-explicit`             | off         | The hints listed in `fields` (`readOnlyHint`, `consequentialHint`) are declared on every tool.                                                  |
| `webmcp/exposed-to-secure-origins`        | error       | `registerTool(tool, { exposedTo })` lists something the API rejects: an insecure origin, or `"*"`.                                              |
| `webmcp/exposed-to-origin-only`           | warn        | An `exposedTo` entry carries a path, query, fragment or credentials, which the API ignores.                                                     |
| `webmcp/declarative-description`          | error       | JSX `<form toolname>` also has `tooldescription`.                                                                                               |
| `webmcp/declarative-field-description`    | warn        | Each named field in the form has a `<label>`, `aria-label` or `toolparamdescription`.                                                           |
| `webmcp/declarative-autosubmit-sensitive` | error       | `toolautosubmit` on a form with a password field or a payment/one-time-code `autocomplete`.                                                     |

Source rules judge the code that calls the API. They have no `webmcp-lint` counterpart because nothing they catch survives to runtime: a misspelt dictionary member is silently dropped, an unbound method throws before any tool exists.

| Rule                                | Recommended | Checks                                                                                                                        |
| ----------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `webmcp/no-legacy-api`              | error       | `navigator.modelContext`, `window.agent`, `provideContext()`, `clearContext()`, `unregisterTool()`: not in the specification. |
| `webmcp/no-unknown-tool-properties` | error       | A key the tool dictionary does not have (`parameters`, `handler`, `exposedTo` in the tool, ...); `allow` lists your own.      |
| `webmcp/no-unknown-options`         | error       | An option `registerTool()`, `getTools()` or `executeTool()` does not take.                                                    |
| `webmcp/require-execute`            | error       | `registerTool()` gets an `execute` callback, and not a string or object.                                                      |
| `webmcp/valid-event-name`           | error       | Listeners for `tool*` events name `toolchange`, `toolactivated` or `toolcancel`.                                              |
| `webmcp/no-unbound-method`          | error       | `registerTool` and friends are called on their `ModelContext`, not destructured or detached.                                  |
| `webmcp/no-interpolated-text`       | warn        | Tool text assembled at runtime from values the author cannot name the source of.                                              |

Rule options are the same objects `webmcp-lint` accepts. `webmcp.configs.recommended` turns on every rule marked above except the `off` ones; `webmcp.configs.all` turns every rule, the opt-in ones included, into an error.

## Where definitions are found

Out of the box the plugin looks at the argument of `registerTool()` and the argument of `useWebMCP()` from [`use-webmcp-tool`](https://www.npmjs.com/package/use-webmcp-tool), whose object has the same shape. Bare calls and member calls both match, so `useWebMCP({...})` and `document.modelContext.registerTool({...})` are found the same way.

Wrappers of your own are declared once in ESLint's shared `settings`, and every rule picks them up:

```js
// eslint.config.js
export default [
  webmcp.configs.recommended,
  {
    settings: {
      webmcp: {
        definitions: [
          "defineAgentTool", // defineAgentTool({ name, description, inputSchema, ... })
          { call: "register", argument: 1 }, // register("scope", { name, ... })
          { call: "addTools", tools: "items" }, // addTools({ items: [{ name, ... }, ...] })
        ],
      },
    },
  },
];
```

An entry is a call name, or `{ call, argument = 0, tools?, options? }`: `argument` is the index of the definition, `tools` names the property holding an array of definitions, and `options` is the index of an argument that may carry `exposedTo`. Entries add to the defaults.

The definition does not have to be inline. An identifier is followed to its initialiser when it is a `const` or `let` declared once in the same file and never reassigned, so this is linted too, with findings pointing into the literal:

```js
const searchTool = { name: "search", description: "...", inputSchema: {...}, execute };
useWebMCP(searchTool);
```

## Declarative tools in JSX

A `<form toolname="...">` in a React component is a declarative tool, and the three `declarative-*` rules judge it the way the browser collector would: the form needs a `tooldescription`, every named `<input>`, `<select>` and `<textarea>` needs a `<label htmlFor>`, a wrapping `<label>`, an `aria-label` or a `toolparamdescription`, and `toolautosubmit` must not sit on a form with a password field or a field whose `autocomplete` names a payment card or a one-time code. Findings point at the form or the field. Attributes are matched case-insensitively, so `toolName` works too. A form with a computed `tooldescription` gets no description findings, and a field with a spread (`{...props}`) or a computed label attribute gets no field findings: what cannot be read is not reported.

## What it can and cannot see

The plugin reads literals: strings, numbers, booleans, arrays and nested objects, including values wrapped in `as const` or `satisfies` when a TypeScript parser is used. A field whose value is computed (an import, a function call, a template with expressions, a spread, a getter) is treated as unknown, and findings about that field are dropped for that tool rather than guessed at; `description-injection` still checks a literal description when only the schema is computed, and reports separately on `title` and on annotation values. A tool whose `name` is not a literal has no definition to judge, so the rules that need one skip it; `no-interpolated-text` still reports on it, because a name assembled at runtime is what that rule is looking for. When a key is written twice the last one counts, as at runtime. A binding that is visibly mutated in place (`tool.name = ...`, `delete tool.x`, `Object.assign(tool, ...)`) is not followed; one passed to another function is assumed to come back unchanged. Definitions built by a helper in another module are out of reach; lint those with `lintTools()` from `webmcp-lint` in a unit test, or at runtime with `playwright-webmcp`.

Rules that need the whole page are not here on purpose: duplicate names, near-identical descriptions, tool count and cross-origin frames depend on what the page actually registers at runtime. Run those with [`playwright-webmcp`](https://www.npmjs.com/package/playwright-webmcp) in a test, or with [`webmcp-audit`](https://www.npmjs.com/package/webmcp-audit) against a URL. The rule list and severities are documented in the [repository README](https://github.com/swissspidy/playwright-webmcp#readme).

## oxlint

The rules use only the ESLint rule contract (a `CallExpression` visitor, `context.sourceCode.getScope`, `context.settings`, `context.report`), so [oxlint](https://oxc.rs/docs/guide/usage/linter/js-plugins.html) loads the package as a JS plugin. The test suite runs the real oxlint binary against it, including `settings` and rule options.

```jsonc
// .oxlintrc.json
{
  "jsPlugins": ["@swissspidy/eslint-plugin-webmcp"],
  "settings": { "webmcp": { "definitions": ["defineAgentTool"] } },
  "rules": {
    "webmcp/tool-name-valid": "error",
    "webmcp/description-missing": "error",
    "webmcp/description-injection": "error",
    "webmcp/schema-shape": "error",
    "webmcp/schema-no-null-literals": "error",
    "webmcp/exposed-to-secure-origins": "error",
    "webmcp/annotations-valid": "error",
    "webmcp/description-placeholder": "error",
    "webmcp/no-legacy-api": "error",
    "webmcp/no-unknown-tool-properties": "error",
    "webmcp/no-unknown-options": "error",
    "webmcp/require-execute": "error",
    "webmcp/valid-event-name": "error",
    "webmcp/no-unbound-method": "error",
    "webmcp/no-interpolated-text": "warn",
    "webmcp/description-length": "warn",
    "webmcp/param-description-missing": "warn",
    "webmcp/schema-depth": "warn",
    "webmcp/schema-unsupported-keywords": "warn",
    "webmcp/sensitive-params": "warn",
  },
}
```

oxlint has no equivalent of `configs.recommended`, so rules are listed individually. Its JS plugin support is marked alpha upstream.
