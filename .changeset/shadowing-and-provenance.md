---
"webmcp-lint": minor
"playwright-webmcp": minor
"webmcp-audit": minor
"eslint-plugin-webmcp": minor
---

Ask which tool an agent will pick, and whose code wrote it.

- New `tool-shadowing` rule (page, error): two tools whose names read alike — same letters under different case or separators, or one character apart — registered from different frames, origins or scripts. An agent picks a tool by reading its name, so `search_products` in the page and `searchProducts` in an embedded widget are one choice presented as two. Identical names stay `duplicate-tool-name`'s finding, and near names inside a single frame are a naming problem rather than a trust one, so the rule only fires across a boundary somebody else could own. `minLength` (4) keeps short names from reading as typosquats of each other.
- New `third-party-registration` rule (page, warning): a tool whose registering script came from another origin than the frame it runs in. Its definition is not in that origin's source, so `eslint-plugin-webmcp` will never see it. Needs the CDP collector, which is what records a registration site; `allow` lists your own bundle hosts. `confusableForm()`, `withinOneEdit()` and `registrationOrigin()` are exported.
- New `webmcp/no-interpolated-text` ESLint rule (warning), with no `webmcp-lint` counterpart: tool text assembled at runtime, in a name, title, description or parameter description, and in the matching JSX form attributes. By the time a page runs, an interpolated description is just a string; only the source shows that the author wrote half of it. A reference to text — `t("key")`, `STRINGS.search` — is not an interpolation and is left alone. `fields` narrows which text it judges, and `webmcp.configs.all` raises it to an error.
- `toolObjectsFromCall()` splits finding a definition literal from reading it, so a rule can judge a tool that has no readable definition: a tool whose `name` is computed has no snapshot to lint, but the computation is itself the finding.
- The `safety` category of `computeScore()` counts the two new page rules.
