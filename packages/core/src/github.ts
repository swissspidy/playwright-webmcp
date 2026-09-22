/**
 * GitHub Actions workflow commands for findings, so a CLI run inside a job
 * shows each finding as an annotation on the run summary. No file or line
 * is known for a live page, so annotations carry a title and the message.
 * https://docs.github.com/en/actions/reference/workflow-commands-for-github-actions
 */
import type { Finding, Severity } from "./types.js";

const COMMAND: Record<Severity, "error" | "warning" | "notice"> = { error: "error", warning: "warning", info: "notice" };

function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export interface GitHubAnnotationOptions {
  /** File to attach the annotations to, e.g. the linted tools.json. */
  file?: string;
  /** Prefix for the annotation title, e.g. "webmcp-audit". The command name, not the package. */
  tool?: string;
}

/** One `::error`/`::warning`/`::notice` line per finding. */
export function toGitHubAnnotations(findings: Finding[], options: GitHubAnnotationOptions = {}): string {
  return findings
    .map((f) => {
      const props: string[] = [];
      if (options.file) props.push(`file=${escapeProperty(options.file)}`);
      props.push(`title=${escapeProperty([options.tool, f.ruleId].filter(Boolean).join(": "))}`);
      const where = f.tool ? `${f.tool}: ` : "";
      return `::${COMMAND[f.severity]} ${props.join(",")}::${escapeData(`${where}${f.message}${f.help ? ` ${f.help}` : ""}`)}`;
    })
    .join("\n");
}
