# codemode-bench

Measures whether code mode saves tokens, turns and time compared with classic tool calling, on the same tasks and the same model. It drives the multi-page test shop in [`packages/codemode/tests/site`](../../packages/codemode/tests/site) and calls the Claude API.

## Arms

Both use the same model (Claude Opus 5.5 by default) and effort (`medium`), the same system prompt preamble, and a plain Messages API loop with no prompt caching. Only the tools differ:

| Arm        | Tools the model sees                                                                                                                                                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `classic`  | One tool per page tool, rebuilt after every navigation, the way Playwright MCP exposes WebMCP tools, plus a `navigate` tool.                                                                                                                                                 |
| `codemode` | The package's MCP tools as its server lists them: `webmcp_execute` with the current page's API in its description (relisted every turn, as a client does on `tools/list_changed`), and `webmcp_api`. Results carry only the new page's tool declarations after a navigation. |

Tool calls in every arm go through the same `CodeMode` machinery, so registration waits, navigation handling and result unwrapping are identical. The classic arm runs one tool per script.

## Tasks

| Task       | Shape                                                                           | Checked by                                                         |
| ---------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `lookup`   | One page, read-only: a search, then arithmetic.                                 | The answer contains the right total.                               |
| `purchase` | Three pages: find, open, add two, read the cart.                                | The cart holds exactly two grinders, and the answer has the total. |
| `fan-out`  | Many pages: add every product of a category.                                    | The cart holds one of each kitchen product.                        |
| `orders`   | One page, one large result: 200 orders (about 67 KB of JSON) to filter and sum. | The answer has the right amount, computed from the same data.      |

Each run starts in a fresh browser context with an empty cart. A run counts as a success only if the model ends its turn and the check passes.

## Running

It needs an Anthropic API key in `TEST_API_KEY` (or `ANTHROPIC_API_KEY`), and Node 24 or later.

```sh
pnpm install
pnpm --filter codemode-bench exec playwright install chromium
pnpm --filter @swissspidy/webmcp-codemode build
pnpm --filter codemode-bench bench                    # 3 runs of every task and arm
pnpm --filter codemode-bench bench -- --runs 1 --tasks purchase --arms classic,codemode
```

Options: `--runs`, `--tasks`, `--arms`, `--model`, `--effort`, `--max-turns` (default 25), `--out` (default `results/`). Each run writes `results/<timestamp>.json` with every run's numbers, and a Markdown summary of the medians.

**It costs money.** A full run is 27 model loops of a few turns each. Expect a few dollars at Claude Opus 5.5 list prices. Start with `--runs 1`.

CI only typechecks this script; it never runs it.

Results from before the code mode fixes (3e8a10e and earlier) used three arms: `codemode` then meant the two tools without the API inlined, and a third arm, `codemode-inline`, inlined it.

## The webmcp-tools eval suites

`--webmcp-tools <checkout>` runs the eval suites from a checkout of [GoogleChromeLabs/webmcp-tools](https://github.com/GoogleChromeLabs/webmcp-tools) (`webmcp-evals/examples`) instead of the shop tasks. It runs them against the deployed demos, or another copy given with `--demos-url`.

It uses the suites with several expected calls per case and a deployed demo:

| Suite                | Demo                               |
| -------------------- | ---------------------------------- |
| `spreadsheet`        | 27 tools, one page                 |
| `pixel-art-studio`   | 25 tools, one page                 |
| `doors`              | Tools that appear after navigating |
| `hotel-chain`        | Tools that appear after navigating |
| `sport-shop-angular` | Tools that appear after navigating |

Each case is one user request and the calls an agent should make for it. A run passes when the page tool calls it made match those calls. Matching uses `reconcileCalls` from `@swissspidy/webmcp-lint` in `evals` mode, the `webmcp-evals` CLI's own rules: calls must come in order, and any extra call fails the case. The report also gives a lenient score that allows extra calls, such as a read before a write.

```sh
git clone --depth 1 https://github.com/GoogleChromeLabs/webmcp-tools ../webmcp-tools
pnpm --filter codemode-bench bench -- --webmcp-tools ../webmcp-tools --runs 1
pnpm --filter codemode-bench bench -- --webmcp-tools ../webmcp-tools --suites doors,hotel-chain
```

## Results

- [2026-11-22, webmcp-tools eval suites, 1 run per case and arm, harness at efa10ce](results/2026-11-22T15-34-58-330Z.md)
- [2026-11-21, 3 runs per task and arm, harness at a247612 (description nudges)](results/2026-11-21T22-37-16-925Z.md)
- [2026-11-21, 3 runs per task and arm, harness at 9e9a9d9 (after the code mode fixes)](results/2026-11-21T21-59-20-690Z.md)
- [2026-11-21, 3 runs per task and arm, harness at 3e8a10e](results/2026-11-21T19-55-40-463Z.md)
