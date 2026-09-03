# webmcp-lint

Snapshot model, lint rules, and the evals-compatible argument matcher and trajectory reconciler behind `playwright-webmcp`. See the [repository README](../../README.md) for the rule list and matcher semantics.

```ts
import { lint, formatFindings, reconcileCalls, matchesArgument, defineRule } from "webmcp-lint";
```

`collectFrame` (from `webmcp-lint/collect`) is the self-contained function evaluated inside each frame to produce a snapshot.
