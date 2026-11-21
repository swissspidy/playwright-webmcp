# codemode-bench

Measures whether code mode saves tokens, turns and time compared with classic tool calling, on the same tasks and the same model. It drives the multi-page test shop in [`packages/codemode/tests/site`](../../packages/codemode/tests/site) and calls the Claude API.

## Arms

All three use the same model (Claude Opus 5.5 by default) and effort (`medium`), the same system prompt preamble, and a plain Messages API loop with no prompt caching. Only the tools differ:

| Arm               | Tools the model sees                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `classic`         | One tool per page tool, rebuilt after every navigation, the way Playwright MCP exposes WebMCP tools, plus a `navigate` tool. |
| `codemode`        | The package's two MCP tools, `webmcp_api` and `webmcp_execute`.                                                              |
| `codemode-inline` | `webmcp_execute` alone, with the current page's API in its description, which saves the `webmcp_api` round trip.             |

Tool calls in every arm go through the same `CodeMode` machinery, so registration waits, navigation handling and result unwrapping are identical. The classic arm runs one tool per script.

## Tasks

| Task       | Shape                                            | Checked by                                                         |
| ---------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| `lookup`   | One page, read-only: a search, then arithmetic.  | The answer contains the right total.                               |
| `purchase` | Three pages: find, open, add two, read the cart. | The cart holds exactly two grinders, and the answer has the total. |
| `fan-out`  | Many pages: add every product of a category.     | The cart holds one of each kitchen product.                        |

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

## Results

- [2026-11-21, 3 runs per task and arm, harness at 3e8a10e](results/2026-11-21T19-55-40-463Z.md)
