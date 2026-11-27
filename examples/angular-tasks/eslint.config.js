// The WebMCP rules run statically on Angular's provideExperimentalWebMcpTools(), declareExperimentalWebMcpTool()
// and Signal Forms' experimentalWebMcpTool option, out of the box, before a browser ever loads the app.
import tseslint from "typescript-eslint";
import webmcp from "@swissspidy/eslint-plugin-webmcp";

export default [
  { ignores: ["dist/**", ".angular/**", "test-results/**", "playwright-report/**", ".webmcp-report/**"] },
  { files: ["**/*.ts"], languageOptions: { parser: tseslint.parser } },
  webmcp.configs.recommended,
  {
    rules: {
      // Off by default. Asked of list_tasks and complete_task; not of the add_task form, whose option takes no title.
      "webmcp/tool-title-missing": "warn",
    },
  },
];
