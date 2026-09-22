/**
 * Helpers for the tests that drive `document.modelContext` directly rather
 * than through the `webmcp` fixture, because what they are testing is what
 * page script sees.
 */
import type { Page } from "@playwright/test";
import type { WebMCP } from "webmcp-types";
import { executeToolInputShape } from "../src/input-shape.js";

/**
 * Execute a tool the way page script would. The input goes as the object the
 * specification describes, or as the JSON string Chrome 154 and earlier
 * required, decided from the browser version the way `WebMCP.call()` and the
 * Prompt API harness decide it.
 */
export function executeToolInPage(
  page: Page,
  name: string,
  args: Record<string, unknown>,
  getToolsOptions?: WebMCP.ModelContextGetToolOptions,
): Promise<unknown> {
  const shape = executeToolInputShape(page.context().browser()?.version());
  return page.evaluate(
    async ([toolName, toolArgs, listOptions, inputShape]) => {
      const mc = document.modelContext!;
      const tools = await (listOptions ? mc.getTools(listOptions) : mc.getTools());
      const tool = tools.find((t) => t.name === toolName)!;
      const input = inputShape === "string" ? JSON.stringify(toolArgs) : toolArgs;
      return mc.executeTool(tool, input as object);
    },
    [name, args, getToolsOptions, shape] as const,
  );
}
