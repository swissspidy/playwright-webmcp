/**
 * The `webmcp-lint` command, separated from the bin entry so it can be unit
 * tested. Lints a JSON file holding a page snapshot, an array of tool
 * definitions, or a `webmcp-evals` tools file such as the `tools.json` the
 * Playwright reporter writes.
 */
import { parseArgs } from "node:util";
import { formatFindings, lint } from "./lint.js";
import { toSnapshot } from "./from-tools.js";
import { severityRank } from "./rules/helpers.js";
import type { LintOptions, Severity } from "./types.js";

export const HELP = `Usage: webmcp-lint <file.json> [options]

Lints WebMCP tool definitions from a JSON file without a browser. The file may be
a page snapshot written by the playwright-webmcp fixture, an array of tool
definitions ({ name, description, inputSchema, annotations }), or a webmcp-evals
tools file ({ tools: [...] }) such as .webmcp-report/tools.json. Use "-" for stdin.

Options:
  --fail-on <severity>  Exit 1 when a finding of this severity or worse exists:
                        error (default), warning, info, or never
  --format <format>     text (default) or json
  --rule <id=value>     Configure a rule; repeatable. Value is off, error, warning,
                        info, or a JSON object of options, e.g.
                        --rule too-many-tools='{"max":40}' --rule no-tools=off
  --scope <scope>       all (default) or tool: skip rules that need the whole page
  --url <url>           Page URL to report for inputs that have none
  -h, --help            Show this help
`;

export class UsageError extends Error {}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readFile: (path: string) => string;
  readStdin: () => string;
}

const SEVERITIES: Severity[] = ["error", "warning", "info"];

type RuleConfig = NonNullable<LintOptions["rules"]>[string];

function parseRule(spec: string): [string, RuleConfig] {
  const eq = spec.indexOf("=");
  if (eq <= 0) throw new UsageError(`--rule expects id=value, got ${JSON.stringify(spec)}`);
  const id = spec.slice(0, eq).trim();
  const raw = spec.slice(eq + 1).trim();
  if (raw === "off" || raw === "false") return [id, false];
  if (raw === "on" || raw === "true") return [id, {}];
  if (SEVERITIES.includes(raw as Severity)) return [id, raw as Severity];
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return [id, parsed as Record<string, unknown>];
  } catch {
    /* fall through */
  }
  throw new UsageError(`--rule ${id}: expected off, error, warning, info or a JSON object, got ${JSON.stringify(raw)}`);
}

export function parseCliArgs(argv: string[]) {
  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "fail-on": { type: "string", default: "error" },
        format: { type: "string", default: "text" },
        rule: { type: "string", multiple: true, default: [] as string[] },
        scope: { type: "string", default: "all" },
        url: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values, positionals } = parsed;
  const failOn = String(values["fail-on"]);
  if (!["error", "warning", "info", "never"].includes(failOn))
    throw new UsageError(`--fail-on expects error, warning, info or never, got ${JSON.stringify(failOn)}`);
  const format = String(values.format);
  if (format !== "text" && format !== "json") throw new UsageError(`--format expects text or json, got ${JSON.stringify(format)}`);
  const scope = String(values.scope);
  if (scope !== "all" && scope !== "tool") throw new UsageError(`--scope expects all or tool, got ${JSON.stringify(scope)}`);
  const rules: Record<string, RuleConfig> = {};
  for (const spec of (values.rule as string[]) ?? []) {
    const [id, cfg] = parseRule(spec);
    rules[id] = cfg;
  }
  return {
    help: Boolean(values.help),
    file: positionals[0],
    extra: positionals.slice(1),
    failOn: failOn as Severity | "never",
    format: format as "text" | "json",
    scope: scope as "all" | "tool",
    url: values.url as string | undefined,
    rules,
  };
}

export async function runLintCli(argv: string[], io: CliIo): Promise<number> {
  try {
    const args = parseCliArgs(argv);
    if (args.help) {
      io.stdout(HELP);
      return 0;
    }
    if (!args.file) throw new UsageError("missing <file.json>");
    if (args.extra.length) throw new UsageError(`unexpected argument ${JSON.stringify(args.extra[0])}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.file === "-" ? io.readStdin() : io.readFile(args.file));
    } catch (err) {
      throw new UsageError(`could not read ${args.file}: ${(err as Error).message}`);
    }
    let snapshot;
    try {
      snapshot = toSnapshot(parsed as Parameters<typeof toSnapshot>[0], { url: args.url });
    } catch (err) {
      throw new UsageError(`${args.file}: ${(err as Error).message}`);
    }
    const result = lint(snapshot, { rules: args.rules, scope: args.scope });
    if (args.format === "json") io.stdout(JSON.stringify({ url: snapshot.url, ...result }, null, 2) + "\n");
    else {
      io.stdout(formatFindings(result) + "\n");
      io.stdout(`\n${result.counts.error} error(s), ${result.counts.warning} warning(s), ${result.counts.info} info in ${snapshot.tools.length} tool(s).\n`);
    }
    if (args.failOn === "never") return 0;
    const threshold = severityRank(args.failOn);
    return result.findings.some((f) => severityRank(f.severity) >= threshold) ? 1 : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`webmcp-lint: ${err.message}\n\n${HELP}`);
      return 2;
    }
    throw err;
  }
}
