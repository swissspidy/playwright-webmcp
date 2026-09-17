/**
 * Composition risk: tools that are each defensible on their own but form a
 * chain once an agent holds all of them.
 *
 * The usual framing of this ("private data" + "untrusted content" + "a way to
 * send it somewhere") has a third leg that the web supplies for free: every
 * tool on a page runs inside the user's live session, with their cookies and
 * their authority. A page does not opt into private-data access, it starts
 * with it. What is left to judge is the pair -- text the page author does not
 * control reaching the agent's context, and a tool that acts on the user's
 * behalf in the same context.
 *
 * A lint has to leave the author somewhere to go. The part an author can fix
 * in the declaration is the boundary itself: a tool that says
 * `untrustedContentHint` lets every client tell somebody else's words from the
 * page's own, and containing them from there is the client's job. So the rule
 * fires on a chain whose source is *not* declared, and goes quiet once it is.
 * `requireDeclaration: false` reports declared chains too, for a review that
 * wants every composition listed rather than only the fixable ones.
 */
import { toolHints } from "../annotations.js";
import type { Finding, ToolSnapshot } from "../types.js";
import { defineRule, finding, opt } from "./helpers.js";

/**
 * Names and descriptions that read as "this returns text somebody else wrote".
 * Deliberately narrow: a pattern that matches most read tools makes the rule
 * noise, and noise gets rules switched off.
 */
const UNTRUSTED_SOURCE =
  /\b(comments?|reviews?|messages?|inbox|mail|emails?|feed|posts?|threads?|repl(?:y|ies)|submissions?|tickets?|issues?|mentions?|notifications?|chats?|testimonials?|guestbook|scrape|crawl|browse)\b/i;

/** Sinks that carry data off the origin rather than only writing locally. */
const EGRESS_SINK = /\b(send|email|mail|post|publish|share|submit|upload|tweet|message|notify|invite|webhook|export|forward|sync)\b/i;

function matches(tool: ToolSnapshot, re: RegExp): boolean {
  return re.test(tool.name) || re.test(tool.description ?? "");
}

/**
 * Whether the tool hands the agent content the page author did not write.
 *
 * A declaration stands on its own. Inference from a name does not: the same
 * words appear on tools that *accept* the thing rather than return it -- a
 * `<form>` that subscribes an email address reads as "email" to any pattern.
 * So an inferred source has to corroborate: it must not be a declarative form,
 * which submits rather than returns, and must not have said it is not
 * read-only.
 */
function isUntrustedSource(tool: ToolSnapshot, re: RegExp): "declared" | "inferred" | false {
  if (toolHints(tool.annotations).untrustedContent === true) return "declared";
  if (tool.source === "declarative" || toolHints(tool.annotations).readOnly === false) return false;
  return matches(tool, re) ? "inferred" : false;
}

export const capabilityTrifecta = defineRule({
  id: "capability-trifecta",
  scope: "page",
  description:
    "A tool that returns content the author does not control, without declaring it, on a page that also exposes tools which act on the user's behalf: that content can steer the agent into calling them.",
  severity: "warning",
  defaults: { sources: UNTRUSTED_SOURCE.source, sinks: EGRESS_SINK.source, maxNamed: 3, requireDeclaration: true },
  check: (ctx) => {
    const sourceRe = new RegExp(opt(ctx, "sources", UNTRUSTED_SOURCE.source), "i");
    const sinkRe = new RegExp(opt(ctx, "sinks", EGRESS_SINK.source), "i");
    const maxNamed = opt(ctx, "maxNamed", 3);
    const requireDeclaration = opt(ctx, "requireDeclaration", true);
    const tools = ctx.snapshot.tools;
    if (tools.length < 2) return [];

    // Anything not declared read-only can act. An unannotated tool is unknown,
    // and unknown has to count as acting: that is what the annotation is for.
    const acting = tools.filter((t) => toolHints(t.annotations).readOnly !== true);
    if (!acting.length) return [];

    const out: Finding[] = [];
    for (const source of tools) {
      const kind = isUntrustedSource(source, sourceRe);
      if (!kind) continue;
      if (kind === "declared" && requireDeclaration) continue;
      const sinks = acting.filter((t) => t !== source);
      if (!sinks.length) continue;
      const named = sinks
        .slice(0, maxNamed)
        .map((t) => `"${t.name}"${matches(t, sinkRe) ? " (sends data off-origin)" : ""}`)
        .join(", ");
      const rest = sinks.length > maxNamed ? `, and ${sinks.length - maxNamed} more` : "";
      const why =
        kind === "declared"
          ? `"${source.name}" declares untrustedContent`
          : `"${source.name}" looks like it returns content written by someone other than the page author, and does not declare untrustedContent`;
      out.push(
        finding(
          capabilityTrifecta,
          `${why}, and this page exposes ${sinks.length} tool(s) that act on the user's behalf: ${named}${rest}. Text inside a ${source.name} result can ask the agent to call them.`,
          {
            tool: source.name,
            frame: source.frame,
            help:
              kind === "declared"
                ? "Keep the acting tools behind a user confirmation, and do not let one agent turn hold both."
                : "Set untrustedContentHint on the source so clients can tell its text from the page's own, and keep the acting tools behind a user confirmation.",
          },
        ),
      );
    }
    return out;
  },
});
