import { generateArguments, judgeRuns, type GenerateOptions, type SmokeBudgets, type SmokeReport, type SmokeRun, type ToolSnapshot } from "webmcp-lint";

export interface SmokeOptions extends GenerateOptions, SmokeBudgets {
  /** Tools to exercise, by name or predicate. */
  tools?: string[] | ((tool: ToolSnapshot) => boolean);
  /** Exercise every tool, including ones that may have side effects. */
  all?: boolean;
  /** Which argument kinds to run. Default: all four. */
  kinds?: Array<SmokeRun["kind"]>;
}

const READ_ONLY_KEYS = ["readOnly", "readOnlyHint"];

export function isReadOnly(tool: ToolSnapshot): boolean {
  const a = tool.annotations ?? {};
  return READ_ONLY_KEYS.some((k) => a[k] === true);
}

/**
 * Decide which tools a smoke run may execute. Without an explicit list or
 * `all: true`, only tools annotated as read-only are considered safe.
 */
export function selectSmokeTools(tools: ToolSnapshot[], options: SmokeOptions): { selected: ToolSnapshot[]; skipped: ToolSnapshot[] } {
  let selected: ToolSnapshot[];
  if (typeof options.tools === "function") selected = tools.filter(options.tools);
  else if (Array.isArray(options.tools)) selected = tools.filter((t) => (options.tools as string[]).includes(t.name));
  else if (options.all) selected = tools;
  else selected = tools.filter(isReadOnly);
  const chosen = new Set(selected);
  return { selected, skipped: tools.filter((t) => !chosen.has(t)) };
}

export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export async function runSmoke(tools: ToolSnapshot[], call: ToolCaller, options: SmokeOptions = {}): Promise<SmokeReport & { skipped: string[] }> {
  const { selected, skipped } = selectSmokeTools(tools, options);
  const kinds = new Set(options.kinds ?? ["valid-minimal", "valid-full", "boundary", "invalid"]);
  const runs: SmokeRun[] = [];
  for (const tool of selected) {
    for (const generated of generateArguments(tool.inputSchema, options)) {
      if (!kinds.has(generated.kind)) continue;
      const startedAt = Date.now();
      try {
        const result = await call(tool.name, generated.args);
        runs.push({
          tool: tool.name,
          kind: generated.kind,
          label: generated.label,
          args: generated.args,
          ok: true,
          result,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        runs.push({
          tool: tool.name,
          kind: generated.kind,
          label: generated.label,
          args: generated.args,
          ok: false,
          error: String((err as Error)?.message ?? err),
          durationMs: Date.now() - startedAt,
        });
      }
    }
  }
  return { ...judgeRuns(runs, options), skipped: skipped.map((t) => t.name) };
}
