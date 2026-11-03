/**
 * Helpers for the tests that drive `document.modelContext` directly rather
 * than through the `webmcp` fixture, because what they are testing is what
 * page script sees.
 */
import type { Page } from "@playwright/test";
import type { WebMCP } from "webmcp-types";

/** Execute a tool the way page script would, with the input as an object. */
export function executeToolInPage(
  page: Page,
  name: string,
  args: Record<string, unknown>,
  getToolsOptions?: WebMCP.ModelContextGetToolOptions,
): Promise<unknown> {
  return page.evaluate(
    async ([toolName, toolArgs, listOptions]) => {
      const mc = document.modelContext!;
      const tools = await (listOptions ? mc.getTools(listOptions) : mc.getTools());
      const tool = tools.find((t) => t.name === toolName)!;
      return mc.executeTool(tool, toolArgs);
    },
    [name, args, getToolsOptions] as const,
  );
}
