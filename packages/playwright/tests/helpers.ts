/**
 * Helpers for the tests that drive `modelContext` directly rather than through
 * the `webmcp` fixture, because what they are testing is what page script sees.
 */
import "../src/webmcp-types.js";
import type { Page } from "@playwright/test";

/**
 * Execute a tool the way page script would, trying both input shapes Chrome
 * has accepted: an object (Chrome 155 and later) and a JSON string (Chrome
 * 154). Whichever is wrong is rejected while arguments are validated, before
 * the tool runs, so the retry cannot execute anything twice.
 *
 * `WebMCP.call()` and the Prompt API harness do the same thing inside the
 * library; this is the page-script equivalent, kept here because these tests
 * deliberately bypass both.
 */
export function executeToolInPage(page: Page, name: string, args: Record<string, unknown>, getToolsOptions?: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(
    async ([toolName, toolArgs, listOptions]) => {
      const mc = (document.modelContext ?? navigator.modelContext)!;
      const tools = await (listOptions ? mc.getTools(listOptions as Parameters<typeof mc.getTools>[0]) : mc.getTools());
      const tool = tools.find((t) => t.name === toolName)!;
      try {
        return await mc.executeTool(tool, toolArgs);
      } catch (err) {
        if (!/parse input|input object|not an object/i.test(String((err as Error)?.message))) throw err;
        return await mc.executeTool(tool, JSON.stringify(toolArgs));
      }
    },
    [name, args, getToolsOptions] as const,
  );
}
