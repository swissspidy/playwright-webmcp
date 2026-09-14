# eslint-plugin-webmcp

ESLint rules for [WebMCP](https://github.com/webmachinelearning/webmcp) tool definitions. Every rule is one of the tool-scoped rules of [`webmcp-lint`](https://www.npmjs.com/package/webmcp-lint), run statically against the object literals passed to `registerTool()` and `provideContext({ tools })`, so problems show up in the editor and in `eslint` on CI before a browser ever loads the page.

```sh
npm install --save-dev eslint-plugin-webmcp eslint
```

```js
// eslint.config.js
import webmcp from "eslint-plugin-webmcp";

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
navigator.modelContext.registerTool({
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

| Rule                                 | Recommended | Checks                                                                                   |
| ------------------------------------ | ----------- | ---------------------------------------------------------------------------------------- |
| `webmcp/tool-name-valid`             | error       | Name is 1-128 chars of `[A-Za-z0-9_.-]`.                                                 |
| `webmcp/description-missing`         | error       | The tool has a description.                                                              |
| `webmcp/description-length`          | warn        | Between `min` (20) and `max` (600) characters.                                           |
| `webmcp/param-description-missing`   | warn        | Every input property has a description.                                                  |
| `webmcp/schema-shape`                | error       | Object schema; `required` entries exist in `properties`.                                 |
| `webmcp/schema-no-null-literals`     | error       | No `null` anywhere in the schema (Chrome's Prompt API rejects it).                       |
| `webmcp/schema-depth`                | warn        | Property nesting at most `max` (3) levels.                                               |
| `webmcp/schema-unsupported-keywords` | warn        | Flags `$ref`, `allOf`, `oneOf`, `anyOf`, `not`, `if`/`then`/`else`, `patternProperties`. |
| `webmcp/sensitive-params`            | warn        | Parameter names that look like credentials or payment data (`pattern` overrides).        |
| `webmcp/description-injection`       | error       | Instructions to the agent, role markers, or hidden characters in descriptions.           |
| `webmcp/exposed-to-secure-origins`   | error       | `registerTool(tool, { exposedTo })` lists an insecure origin.                            |

Rule options are the same objects `webmcp-lint` accepts. `webmcp.configs.all` turns every rule into an error.

## What it can and cannot see

The plugin reads literals: strings, numbers, booleans, arrays and nested objects, including values wrapped in `as const` or `satisfies` when a TypeScript parser is used. A field whose value is computed (a variable, a function call, a template with expressions, a spread) is treated as unknown, and the rules that depend on that field are skipped for that tool rather than guessed at. A tool whose `name` is not a literal is not linted at all.

Rules that need the whole page are not here on purpose: duplicate names, near-identical descriptions, tool count, cross-origin frames, and the declarative `<form toolname>` rules depend on what the page actually registers at runtime. Run those with [`playwright-webmcp`](https://www.npmjs.com/package/playwright-webmcp) in a test, or with [`webmcp-audit`](https://www.npmjs.com/package/webmcp-audit) against a URL. The rule list and severities are documented in the [repository README](https://github.com/swissspidy/playwright-webmcp#readme).

The plugin uses ESLint's flat-config plugin API and has no ESLint-specific dependencies beyond the AST, so it should load in other linters that run ESLint plugins; only ESLint itself is tested.
