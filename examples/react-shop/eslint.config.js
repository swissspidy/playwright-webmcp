// The WebMCP rules run statically on every registerTool(), useWebMCP() and
// <form toolname> in the source, before a browser ever loads the app.
import webmcp from "@swissspidy/eslint-plugin-webmcp";

export default [
  { ignores: ["dist/**", "test-results/**", "playwright-report/**"] },
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } },
  },
  webmcp.configs.recommended,
  {
    // Project-specific wrappers are declared once; defineShopTool({ name, ... }) is linted like registerTool.
    settings: { webmcp: { definitions: ["defineShopTool"] } },
    rules: { "webmcp/description-length": ["warn", { min: 30 }] },
  },
];
