/**
 * Who, other than the page itself, can reach a tool. `exposedTo` lists the
 * embedding origins a tool answers for; the embedder still has to opt in with
 * `<iframe allow="tools">`, but an attacker writes their own embedder, so
 * `exposedTo` is the only half of that handshake the author controls.
 *
 * The API accepts potentially trustworthy origins and nothing else: an
 * `http://` origin other than localhost, or a wildcard, makes `registerTool()`
 * reject with `SecurityError`, so the tool never registers at all. That is
 * still worth a finding, because the code that wrote it meant something.
 */
import { defineRule, finding } from "./helpers.js";

const SECURE_ORIGIN = /^(https|wss):\/\//;
const LOCAL_ORIGIN = /^(http|ws):\/\/(localhost|[a-z0-9-]+\.localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export const exposedToInsecure = defineRule({
  id: "exposed-to-secure-origins",
  scope: "tool",
  description: 'exposedTo entries must be potentially trustworthy origins; anything else, "*" included, makes registerTool() reject with SecurityError.',
  severity: "error",
  check: (ctx) =>
    ctx.snapshot.tools.flatMap((t) =>
      (t.exposedTo ?? [])
        .filter((o) => !SECURE_ORIGIN.test(o) && !LOCAL_ORIGIN.test(o))
        .map((o) =>
          o === "*"
            ? finding(
                exposedToInsecure,
                `Tool "${t.name}" is exposed to "*", which is not an origin; registerTool() rejects it and the tool never registers.`,
                {
                  tool: t.name,
                  frame: t.frame,
                  help: "List the embedding origins instead. The API has no wildcard, so a tool meant for every embedder cannot be expressed.",
                },
              )
            : finding(exposedToInsecure, `Tool "${t.name}" is exposed to ${o}, which is not a potentially trustworthy origin; registerTool() rejects it.`, {
                tool: t.name,
                frame: t.frame,
              }),
        ),
    ),
});
