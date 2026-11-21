# codemode-agent

An agent that does a task on a web page through the page's WebMCP tools, in code mode. Claude reads the page's tools as a TypeScript API (`webmcp_api`), then writes scripts that call them (`webmcp_execute`). [`@swissspidy/webmcp-codemode`](../../packages/codemode) runs each script in a QuickJS sandbox in Node, across navigations, and asks you before any tool the page marks as consequential.

`agent.ts` is the whole agent, in one file:

- It launches Chromium with WebMCP enabled through Playwright and opens the page.
- It creates a `CodeMode` for the page. `browser.goto()` may only open pages on the starting site; navigations that a page tool triggers itself are not limited by this. Before each consequential call it asks for approval on stdin, one question at a time, and withdraws a question when its script ends.
- It wires the package's `TOOL_DEFINITIONS` to the Anthropic SDK's tool runner (`client.beta.messages.toolRunner`) with Claude Opus 5.5. If the model declines a request, server-side fallbacks retry it on another model.

## Run it

It needs Node 24 or later, which runs TypeScript directly, and Anthropic credentials: `ANTHROPIC_API_KEY`, or a profile from `ant auth login`.

```sh
pnpm install
pnpm --filter codemode-agent exec playwright install chromium
pnpm --filter @swissspidy/webmcp-codemode build
node examples/codemode-agent/agent.ts https://shop.example "Put two of the cheapest grinders in the cart"
```

Set `HEADED=1` to watch the browser. The scripts Claude writes, and the outcome of each tool call, are printed to stderr. The final summary goes to stdout.

To try it without a WebMCP site of your own, start the package's test shop and point the agent at it:

```sh
node packages/codemode/tests/site/server.mjs &
node examples/codemode-agent/agent.ts http://localhost:4175/ "Find the grinder, add two to the cart, then tell me the cart total"
```

This example calls the Claude API, so CI only typechecks it (`pnpm typecheck`) and never runs it.
