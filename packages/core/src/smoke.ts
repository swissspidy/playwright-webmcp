/**
 * Runtime checks over actual tool executions. These complement the static
 * rules in ./rules by judging what a tool returns, not just what it declares.
 */
import type { Finding, Severity } from "./types.js";
import type { ArgumentKind } from "./generate.js";
import { walk } from "./rules/helpers.js";
import { scanValue } from "./injection.js";
import { toolHints } from "./annotations.js";

export interface SmokeRun {
  tool: string;
  kind: ArgumentKind;
  label: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
  /**
   * The tool's annotations as they stood when the run happened. Supplied by
   * the runner so result rules can tell a declared untrusted-content boundary
   * from a missing one.
   */
  annotations?: Record<string, unknown> | null;
  /** The page URL after the call, when the runner saw it change during the call. */
  navigatedTo?: string;
}

export interface SmokeBudgets {
  /** Serialized result length, in characters, that triggers result-too-large. Default 1500. */
  maxResultChars?: number;
  /** Duration that triggers result-slow. Default 5000 ms. */
  maxDurationMs?: number;
}

export interface SmokeReport {
  runs: SmokeRun[];
  findings: Finding[];
  counts: Record<Severity, number>;
}

export const SMOKE_RULES = {
  "result-error-on-valid-input": { severity: "error" as Severity, description: "A tool threw or reported an error for schema-valid input." },
  "result-contains-null": {
    severity: "error" as Severity,
    description: "Result contains null; Chrome's Prompt API rejects JSON null at any depth in tool results.",
  },
  "result-not-serializable": { severity: "error" as Severity, description: "Result could not be serialized to JSON, so no agent can consume it." },
  "result-undefined": { severity: "warning" as Severity, description: "Tool returned undefined; return an object so the agent gets a confirmation." },
  "result-too-large": { severity: "warning" as Severity, description: "Result is large enough to crowd out a small model's context window." },
  "result-slow": { severity: "warning" as Severity, description: "Tool took longer than the duration budget." },
  "result-accepts-invalid-input": {
    severity: "warning" as Severity,
    description: "Tool accepted schema-invalid input without an error; validate arguments so bad calls fail loudly.",
  },
  "result-string-json": {
    severity: "info" as Severity,
    description: "Tool returned a JSON string rather than an object; agents cope, but objects are easier to inspect.",
  },
  "result-suspicious-content": {
    severity: "warning" as Severity,
    description:
      "Result text of a tool declared untrustedContent looks like an instruction to the agent; the declaration is there, so this is for the client to contain.",
  },
  "result-navigates": {
    severity: "warning" as Severity,
    description:
      "The call changed the page URL, but the tool does not declare consequentialHint, or declares readOnlyHint; a client cannot tell the view will change under the user.",
  },
  "untrusted-content-unmarked": {
    severity: "error" as Severity,
    description:
      "Result text reads as an instruction to the agent, but the tool does not declare untrustedContentHint, so no client can tell it apart from the page's own words.",
  },
} as const;

export type SmokeRuleId = keyof typeof SMOKE_RULES;

/**
 * MCP-style tool result, the shape `use-webmcp-tool` and MCP servers produce:
 * `{ content: [{ type: "text", text }, ...], isError?: boolean }`.
 */
export interface ContentResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
}

export function isContentResult(value: unknown): value is ContentResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const content = (value as { content?: unknown }).content;
  return Array.isArray(content) && content.every((item) => item && typeof item === "object" && typeof (item as { type?: unknown }).type === "string");
}

const ERROR_TEXT = /^\s*(?:error\b|invalid\b|failed\b|missing\b|cannot\b|can't\b|could not\b|unable to\b)/i;

/** The message of a result that is an error written as data: a string, a text block, or `{ error: "..." }`. */
function errorText(result: unknown): string | undefined {
  const texts: unknown[] = [];
  if (typeof result === "string") texts.push(result);
  else if (isContentResult(result)) texts.push(...result.content.map((c) => c.text));
  else if (result && typeof result === "object" && !Array.isArray(result)) {
    const error = (result as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return texts.find((t): t is string => typeof t === "string" && ERROR_TEXT.test(t));
}

function make(id: SmokeRuleId, run: SmokeRun, message: string, help?: string): Finding {
  return { ruleId: id, severity: SMOKE_RULES[id].severity, message, tool: run.tool, help };
}

export function judgeRun(run: SmokeRun, budgets: SmokeBudgets = {}): Finding[] {
  const maxChars = budgets.maxResultChars ?? 1_500;
  const maxMs = budgets.maxDurationMs ?? 5_000;
  const out: Finding[] = [];
  const where = `${run.tool} (${run.label})`;

  if (run.navigatedTo !== undefined) {
    const hints = toolHints(run.annotations);
    if (hints.readOnly === true)
      out.push(
        make(
          "result-navigates",
          run,
          `${where} navigated to ${run.navigatedTo} but declares readOnlyHint.`,
          "A tool that changes the page is not read-only; drop readOnlyHint and declare consequentialHint.",
        ),
      );
    else if (hints.consequential === undefined)
      out.push(
        make(
          "result-navigates",
          run,
          `${where} navigated to ${run.navigatedTo} but does not declare consequentialHint.`,
          "Set consequentialHint to true so clients can confirm before the view changes, or to false if you decided it is not.",
        ),
      );
  }

  if (run.kind === "invalid") {
    if (run.ok) {
      const message = errorText(run.result);
      out.push(
        message
          ? make(
              "result-accepts-invalid-input",
              run,
              `${where} returned the error ${JSON.stringify(message)} as a normal result for invalid input ${JSON.stringify(run.args)}.`,
              "Throw an Error (or return isError: true) so the agent sees the call failed rather than reading the message as success.",
            )
          : make(
              "result-accepts-invalid-input",
              run,
              `${where} returned normally for invalid input ${JSON.stringify(run.args)}.`,
              SMOKE_RULES["result-accepts-invalid-input"].description,
            ),
      );
    }
    return out;
  }

  if (!run.ok) {
    out.push(make("result-error-on-valid-input", run, `${where} failed: ${run.error ?? "unknown error"}.`, `Input was ${JSON.stringify(run.args)}.`));
    return out;
  }

  if (isContentResult(run.result) && run.result.isError === true) {
    const text = run.result.content
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join(" ");
    out.push(make("result-error-on-valid-input", run, `${where} reported isError: ${text || "no message"}.`, `Input was ${JSON.stringify(run.args)}.`));
    return out;
  }

  if (run.durationMs > maxMs) out.push(make("result-slow", run, `${where} took ${run.durationMs} ms; budget is ${maxMs} ms.`));

  if (run.result === undefined) {
    out.push(make("result-undefined", run, `${where} returned undefined.`, SMOKE_RULES["result-undefined"].description));
    return out;
  }
  if (isContentResult(run.result) && run.result.content.length === 0) {
    out.push(make("result-undefined", run, `${where} returned an empty content array.`, SMOKE_RULES["result-undefined"].description));
    return out;
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(run.result);
    if (serialized === undefined) throw new Error("not serializable");
  } catch {
    out.push(make("result-not-serializable", run, `${where} returned a value that cannot be JSON serialized.`));
    return out;
  }

  if (typeof run.result === "string") {
    try {
      JSON.parse(run.result);
      out.push(make("result-string-json", run, `${where} returned JSON as a string.`));
    } catch {
      /* plain text is fine */
    }
  }

  const nullPaths: string[] = [];
  for (const [path, value] of walk(run.result)) if (value === null) nullPaths.push(path || "/");
  if (nullPaths.length)
    out.push(
      make(
        "result-contains-null",
        run,
        `${where} returned null at ${nullPaths.slice(0, 5).join(", ")}${nullPaths.length > 5 ? ", ..." : ""}.`,
        "Omit the key or use an empty string, zero, or false instead.",
      ),
    );

  // A tool that declares untrustedContent has done its part: the text is
  // still worth reporting, but the boundary is marked and containing it is
  // the client's job. One that does not declare it is passing somebody else's
  // words off as the page's own.
  const declared = toolHints(run.annotations).untrustedContent === true;
  for (const { path, hits } of scanValue(run.result)) {
    const id: SmokeRuleId = declared ? "result-suspicious-content" : "untrusted-content-unmarked";
    out.push(
      make(
        id,
        run,
        `${where} returned ${hits.map((h) => h.kind.replace(/-/g, " ")).join(", ")} at ${path}: ${JSON.stringify(hits[0].match)}.`,
        declared ? SMOKE_RULES[id].description : "Set untrustedContentHint on this tool, or sanitize the text before returning it.",
      ),
    );
  }

  if (serialized.length > maxChars)
    out.push(
      make(
        "result-too-large",
        run,
        `${where} returned ${serialized.length} characters; budget is ${maxChars}.`,
        "Paginate, or return ids plus a summary and let the agent ask for details.",
      ),
    );

  return out;
}

export function judgeRuns(runs: SmokeRun[], budgets: SmokeBudgets = {}): SmokeReport {
  const findings = runs.flatMap((r) => judgeRun(r, budgets));
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return { runs, findings, counts };
}

/** Markdown table of the generated inputs a smoke run executed and what came back. */
export function formatSmokeRuns(runs: SmokeRun[]): string {
  if (!runs.length) return "";
  const cell = (v: string) => v.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const clip = (v: string, n = 80) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);
  // A code span whose fence is longer than any backtick run inside it, padded when the content touches the fence.
  const code = (v: string) => {
    const longest = Math.max(0, ...(v.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(longest + 1);
    const padded = v.startsWith("`") || v.endsWith("`") || (v.startsWith(" ") && v.endsWith(" ")) ? ` ${v} ` : v;
    return `${fence}${padded}${fence}`;
  };
  const lines = ["| Tool | Input | Arguments | Outcome | ms |", "| --- | --- | --- | --- | ---: |"];
  for (const r of runs) {
    const outcome = r.ok ? "ok" : `error: ${clip(r.error ?? "unknown", 60)}`;
    lines.push(
      `| ${code(cell(r.tool))} | ${cell(r.kind)}: ${cell(r.label)} | ${code(cell(clip(JSON.stringify(r.args))))} | ${cell(outcome)} | ${r.durationMs} |`,
    );
  }
  return lines.join("\n");
}
