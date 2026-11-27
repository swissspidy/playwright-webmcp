# angular-tasks

A small Angular 22 task board that exposes one WebMCP tool through each of Angular's own WebMCP APIs, with the toolchain from this repository attached:

- `src/app/app.config.ts` registers `list_tasks`, a read-only tool, with `provideExperimentalWebMcpTools([...])`. Its `execute` runs in the injection context, so it can `inject()` the task store.
- `src/app/tasks.ts` declares `complete_task` with `declareExperimentalWebMcpTool()` in the constructor of a root service, so the tool lives as long as the app.
- `src/app/app.ts` exposes the "add a task" Signal Form as `add_task` through its `experimentalWebMcpTool` option. Angular builds the tool's input schema from the form model and submits the form when an agent calls it, so `required()` and `validate()` errors reach the agent the way they would reach a person. `provideExperimentalWebMcpForms()` in `app.config.ts` turns that on.
- `eslint.config.js` runs `@swissspidy/eslint-plugin-webmcp` on the TypeScript sources through the `typescript-eslint` parser. All three APIs are recognised without any settings. `tool-title-missing` is turned on: it asks `list_tasks` and `complete_task` for a title, and not `add_task`, because the form option takes none.
- `tests/tasks.spec.js` uses the `@swissspidy/playwright-webmcp` fixture against the dev server: the three tools and their schemas, page-level lint, real calls from an agent, validation errors, and a smoke run of the read-only tool.

```sh
pnpm install
pnpm run build                       # from the repository root: ESLint and Playwright load the workspace packages from dist/
pnpm --filter angular-tasks lint     # static rules, in the editor and on CI
pnpm --filter angular-tasks test     # starts the dev server, then runs the Playwright suite
pnpm --filter angular-tasks dev      # open it in a browser at http://localhost:4175
```

To see the plugin at work, rename `add_task` to `add task` in `src/app/app.ts` or remove the `title` from `list_tasks`, and run `lint` again.

The runtime lint in the Playwright suite finds what ESLint cannot: the schema Angular generates for the form has no parameter descriptions (`param-description-missing` on `add_task`), and Angular 22 has no way to add them to a form yet. The suite asserts exactly those two findings, so a new one fails it. That is also why the form's description spells out the allowed priorities: the generated schema only says `"type": "string"`.

The suite runs on Playwright's Chromium with `--enable-features=WebMCP`. To run it on another Chrome build:

```sh
PW_CHROMIUM=/opt/google/chrome-unstable/chrome pnpm --filter angular-tasks test
```
