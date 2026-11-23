# codemode-bench

Measures whether code mode saves tokens, turns and time compared with classic tool calling, on the same tasks and the same model. It drives the multi-page test shop in [`packages/codemode/tests/site`](../../packages/codemode/tests/site) and calls the Claude API.

## Arms

All arms use the same model (Claude Opus 5.5 by default) and effort (`medium`), the same system prompt preamble, and a plain Messages API loop with no prompt caching. Only the tools differ:

| Arm        | Tools the model sees                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `classic`  | One tool per page tool, rebuilt after every navigation, the way Playwright MCP exposes WebMCP tools, plus a `navigate` tool.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `codemode` | The package's MCP tools as its server lists them: `webmcp_execute` with the current page's API in its description (relisted every turn, as a client does on `tools/list_changed`), and `webmcp_api`. Results carry only the new page's tool declarations after a navigation.                                                                                                                                                                                                                                                                                                                     |
| `ptc`      | Anthropic's [programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling): the code execution tool, plus the classic arm's tools marked callable only from code (`allowed_callers`). Claude writes Python in the API's container; each call from that code comes back to the loop to run on the page, so this arm's turns count those round trips. The container knows only the tools listed in the request, so a script can't call tools that appear after a navigation until the next request. Container time isn't in the cost column. |

Tool calls in every arm go through the same `CodeMode` machinery, so registration waits, navigation handling and result unwrapping are identical. The classic and ptc arms run one tool per script. Use `--arms` to run a subset, for example `--arms classic,ptc`.

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
pnpm --filter @swissspidy/webmcp-codemode --filter @swissspidy/webmcp-lint build
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

Relative paths in `--webmcp-tools` and `--out` resolve against the directory you run `pnpm` from, so run these from the repository root.

`--remember-pages` starts each code mode case with the pages it saw in the earlier cases of the same suite (`knownPages`), as an agent that has used the site before would have them. The cases then depend on their order, so compare it with a run without the flag.

## Bigger tasks on the demos

The eval suites' cases are small: 1 to 3 calls with small results. `--big` runs bigger tasks on the same deployed demos instead: many dependent calls, or tool results too large to be worth reading in full. Each task seeds its starting state through the page's own tools, the same for both arms. The check reads the page's end state, or computes the answer from the live demo.

| Task              | What it takes                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `sheet-analyze`   | Spreadsheet seeded with 240 rows of sales: the best region in Q2 and its revenue. Reads come back a page at a time. |
| `sheet-summarize` | Same seed: a new Summary sheet with each region's revenue for the year, sorted.                                     |
| `sheet-band`      | Same seed: label all 240 rows High or Normal by revenue.                                                            |
| `pixel-count`     | Canvas seeded with overlapping shapes: count one colour's pixels over 64×64.                                        |
| `pixel-mirror`    | Left half seeded: mirror it onto the right half.                                                                    |
| `shop-gifts`      | Sport shop: a total over about 8 KB of search results, filtered.                                                    |
| `shop-cart`       | Sport shop: add every product that matches a price and a stock level to the cart.                                   |

`--dry-run` needs no API key. For every task it seeds the page, checks that the check fails, runs the task's reference solution through code mode, and checks that the check then passes.

```sh
pnpm --filter codemode-bench bench -- --big --dry-run
pnpm --filter codemode-bench bench -- --big --runs 3
```

## Results

- [2026-11-22, bigger tasks (--big), ptc arm only, 3 runs per task, harness at e16e6f9](results/2026-11-22T22-28-14-646Z.md)
- [2026-11-22, bigger tasks (--big), classic and codemode arms, 3 runs per task and arm, harness at c01f090](results/2026-11-22T21-50-00-281Z.md)
- [2026-11-22, webmcp-tools eval suites, 1 run per case and arm, harness at efa10ce](results/2026-11-22T15-34-58-330Z.md)
- [2026-11-21, 3 runs per task and arm, harness at a247612 (description nudges)](results/2026-11-21T22-37-16-925Z.md)
- [2026-11-21, 3 runs per task and arm, harness at 9e9a9d9 (after the code mode fixes)](results/2026-11-21T21-59-20-690Z.md)
- [2026-11-21, 3 runs per task and arm, harness at 3e8a10e](results/2026-11-21T19-55-40-463Z.md)
