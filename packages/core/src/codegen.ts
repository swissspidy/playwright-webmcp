/**
 * Turn recorded calls into Playwright test source using the fixture API.
 */
import type { RecordedCall } from "./types.js";
import { toExpectedCalls, type ArgumentsMode } from "./evals.js";

export interface CodegenOptions {
  name: string;
  /** Path passed to page.goto(). Default "/". */
  url?: string;
  calls: RecordedCall[];
  /** When set, agent-made calls are reproduced with the promptApi fixture's run(prompt) instead of call(). */
  prompt?: string;
  /** How arguments are asserted in toMatchCalls. Default "exact". */
  argumentsMode?: ArgumentsMode;
  /** Import specifier for the fixture. Default "playwright-webmcp". */
  importFrom?: string;
}

function literal(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/\n/g, "\n  ")
    .replace(/"([A-Za-z_$][A-Za-z0-9_$]*)":/g, "$1:");
}

export function toPlaywrightTest(options: CodegenOptions): string {
  const { name, url = "/", calls, prompt, argumentsMode = "exact", importFrom = "playwright-webmcp" } = options;
  const lines: string[] = [];
  lines.push(`import { test, expect } from ${JSON.stringify(importFrom)};`, "");
  lines.push(`test(${JSON.stringify(name)}, async ({ page, webmcp${prompt ? ", promptApi" : ""} }) => {`);
  lines.push(`  await page.goto(${JSON.stringify(url)});`);
  const agentCalls = calls.filter((c) => c.via === "agent");
  const directCalls = calls.filter((c) => c.via !== "agent");
  if (prompt && agentCalls.length) {
    lines.push(`  const run = await promptApi.run(${JSON.stringify(prompt)});`);
    lines.push(`  expect(run.status).toBe("ok");`);
  }
  for (const c of prompt ? directCalls : calls) {
    const comment = c.via === "agent" ? " // originally made by the agent" : "";
    lines.push(`  await webmcp.call(${JSON.stringify(c.name)}, ${literal(c.args)});${comment}`);
  }
  const expected = toExpectedCalls(calls, { argumentsMode });
  lines.push(`  expect(webmcp).toMatchCalls(${literal(expected)});`);
  lines.push("});", "");
  return lines.join("\n");
}
