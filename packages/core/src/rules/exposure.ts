/**
 * Who, other than the page itself, can reach a tool. `exposedTo` lists the
 * embedding origins a tool answers for; the embedder still has to opt in with
 * `<iframe allow="tools">`, but an attacker writes their own embedder, so
 * `exposedTo` is the only half of that handshake the author controls.
 *
 * The API runs each entry through the URL parser and accepts potentially
 * trustworthy origins and nothing else: something that does not parse, an
 * `http://` origin other than localhost, or a wildcard makes `registerTool()`
 * reject with `SecurityError`, so the tool never registers at all. That is
 * still worth a finding, because the code that wrote it meant something.
 */
import { defineRule, finding } from "./helpers.js";

const LOCAL_HOST = /^(localhost|[a-z0-9-]+\.localhost|127\.0\.0\.1|\[::1\])$/i;

/** Whether a parsed URL's origin is potentially trustworthy in the sense of the Secure Contexts specification. */
export function isPotentiallyTrustworthy(url: URL): boolean {
  if (url.protocol === "https:" || url.protocol === "wss:") return true;
  if (url.protocol === "http:" || url.protocol === "ws:") return LOCAL_HOST.test(url.hostname);
  return false;
}

export const exposedToInsecure = defineRule({
  id: "exposed-to-secure-origins",
  scope: "tool",
  description: 'exposedTo entries must parse as potentially trustworthy origins; anything else, "*" included, makes registerTool() reject with SecurityError.',
  severity: "error",
  check: (ctx) =>
    ctx.snapshot.tools.flatMap((t) =>
      (t.exposedTo ?? []).flatMap((o) => {
        if (o === "*")
          return [
            finding(exposedToInsecure, `Tool "${t.name}" is exposed to "*", which is not an origin; registerTool() rejects it and the tool never registers.`, {
              tool: t.name,
              frame: t.frame,
              help: "List the embedding origins instead. The API has no wildcard, so a tool meant for every embedder cannot be expressed.",
            }),
          ];
        let url: URL;
        try {
          url = new URL(o);
        } catch {
          return [
            finding(exposedToInsecure, `Tool "${t.name}" is exposed to ${JSON.stringify(o)}, which does not parse as a URL; registerTool() rejects it.`, {
              tool: t.name,
              frame: t.frame,
              help: "Write the origin as scheme://host[:port], for example https://partner.example.",
            }),
          ];
        }
        if (isPotentiallyTrustworthy(url)) return [];
        return [
          finding(exposedToInsecure, `Tool "${t.name}" is exposed to ${o}, which is not a potentially trustworthy origin; registerTool() rejects it.`, {
            tool: t.name,
            frame: t.frame,
          }),
        ];
      }),
    ),
});
