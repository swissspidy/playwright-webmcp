---
"webmcp-lint": minor
"playwright-webmcp": minor
"webmcp-audit": minor
"eslint-plugin-webmcp": minor
---

Judge a tool surface by the trust boundary it declares, not only by the text it happens to contain.

- New `capability-trifecta` rule (page, warning): a tool that hands the agent content the page author did not write, on a page that also exposes tools which act on the user's behalf, means text inside that content can ask the agent to call them. The usual third leg of that chain, access to private data, is not something a page opts into — every tool already runs inside the user's session — so the rule judges the pair. A tool counts as a source when it declares `untrustedContent`, or when its name or description reads like third-party content and nothing contradicts that: a declarative `<form>` submits rather than returns, so it is never inferred to be one. Declaring the hint resolves the finding; `requireDeclaration: false` reports declared chains too.
- New `untrusted-content-unmarked` smoke rule (error): a tool whose result reads as an instruction to the agent, on a tool that declares no `untrustedContentHint`. `result-suspicious-content` stays as a warning for the tools that did declare it, where the boundary is marked and containing it is the client's job. `SmokeRun` carries the annotations the run saw, and `runSmoke()` fills them in.
- New `exposed-to-wildcard` rule (tool, error): `exposedTo: ["*"]` answers any embedder, so any page that iframes yours drives the tool with the user's live session. `exposed-to-secure-origins` skipped `"*"` outright. Available in ESLint as `webmcp/exposed-to-wildcard`, pointing at the `exposedTo` value.
- `description-injection` now covers every string an agent reads, not just descriptions: the `title` and the annotation values are scanned alongside the tool and parameter descriptions, and the finding's path says which field it came from. The ESLint plugin locates those findings on the `title` and annotation nodes, and suppresses them per field when that field is computed.
- The `safety` category of `computeScore()` counts the new rules.
