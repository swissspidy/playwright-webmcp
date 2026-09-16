/**
 * Who, other than the page itself, can reach a tool. `exposedTo` decides which
 * embedding origins a tool answers for; the embedder still has to opt in with
 * `<iframe allow="tools">`, but an attacker writes their own embedder, so
 * `exposedTo` is the only half of that handshake the author controls.
 */
import { toolHints } from "../annotations.js";
import { defineRule, finding } from "./helpers.js";

const SECURE_ORIGIN = /^https:\/\//;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export const exposedToInsecure = defineRule({
  id: "exposed-to-secure-origins",
  scope: "tool",
  description: "exposedTo must list secure origins; http:// origins other than localhost are rejected by the API.",
  severity: "error",
  check: (ctx) =>
    ctx.snapshot.tools.flatMap((t) =>
      (t.exposedTo ?? [])
        .filter((o) => o !== "*" && !SECURE_ORIGIN.test(o) && !LOCAL_ORIGIN.test(o))
        .map((o) => finding(exposedToInsecure, `Tool "${t.name}" is exposed to insecure origin ${o}.`, { tool: t.name, frame: t.frame })),
    ),
});

export const exposedToWildcard = defineRule({
  id: "exposed-to-wildcard",
  scope: "tool",
  description: 'exposedTo: ["*"] answers any embedder, so any page that iframes this one drives the tool with the user\'s session.',
  severity: "error",
  check: (ctx) =>
    ctx.snapshot.tools
      .filter((t) => (t.exposedTo ?? []).includes("*"))
      .map((t) => {
        const readOnly = toolHints(t.annotations).readOnly === true;
        const consequence = readOnly
          ? "any embedder can read what it returns for the signed-in user"
          : "any embedder can make it act on behalf of the signed-in user";
        return finding(exposedToWildcard, `Tool "${t.name}" is exposed to "*", so ${consequence}.`, {
          tool: t.name,
          frame: t.frame,
          help: readOnly
            ? 'List the embedding origins instead. Re-level this rule to "warning" if the data really is public.'
            : "List the embedding origins instead, and keep tools that write behind a same-origin check.",
        });
      }),
});
