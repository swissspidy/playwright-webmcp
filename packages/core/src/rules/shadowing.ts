/**
 * Whose tools these are.
 *
 * An agent picks a tool by reading its name, so two names that read alike are
 * one choice, not two -- and if the two come from different places, whoever
 * owns the second place gets to be picked instead of the first. Exact
 * collisions are `duplicate-tool-name`'s job; these are the ones that survive
 * a glance.
 *
 * The second rule here asks a related question with a different answer: not
 * which tool gets picked, but whose code defined it. A tool registered by a
 * script from another origin is a tool your repository does not contain and
 * your static lint will never see.
 */
import type { Finding, ToolSnapshot } from "../types.js";
import { defineRule, finding, opt } from "./helpers.js";

/** Lowercased with separators dropped: what is left when a model reads a name rather than parses it. */
export function confusableForm(name: string): string {
  return name.toLowerCase().replace(/[_\-.]/g, "");
}

/** True when one insertion, deletion or substitution turns `a` into `b`. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    // Same length means a substitution; otherwise the extra character is in `long`.
    if (short.length === long.length) i++;
    j++;
  }
  return true;
}

/** The origin of the script that registered the tool, when the collector knows it. */
export function registrationOrigin(tool: ToolSnapshot): string | undefined {
  const url = tool.location?.url;
  if (!url) return undefined;
  try {
    const origin = new URL(url).origin;
    return origin && origin !== "null" ? origin : undefined;
  } catch {
    return undefined;
  }
}

function where(tool: ToolSnapshot): string {
  const script = registrationOrigin(tool);
  const place = `frame ${tool.frame} (${tool.origin})`;
  return script && script !== tool.origin ? `${place}, registered from ${script}` : place;
}

/**
 * Whether the two tools sit on opposite sides of a boundary somebody else could own.
 *
 * Registration origins only count when both are known. `location` is optional --
 * page-side collectors never set it, and the CDP collector sets it only when a
 * stack frame was available -- so one tool having provenance and the other not
 * is an absence of evidence, not evidence of a second script.
 */
function crossesBoundary(a: ToolSnapshot, b: ToolSnapshot): boolean {
  if (a.frame !== b.frame || a.origin !== b.origin) return true;
  const [scriptA, scriptB] = [registrationOrigin(a), registrationOrigin(b)];
  return scriptA !== undefined && scriptB !== undefined && scriptA !== scriptB;
}

export const toolShadowing = defineRule({
  id: "tool-shadowing",
  scope: "page",
  description:
    "Two tools whose names read alike, registered from different frames, origins or scripts: an agent choosing between them is choosing by a difference it cannot see.",
  severity: "error",
  defaults: { minLength: 4 },
  check: (ctx) => {
    const minLength = opt(ctx, "minLength", 4);
    const tools = ctx.snapshot.tools;
    const out: Finding[] = [];
    for (let i = 0; i < tools.length; i++) {
      for (let j = i + 1; j < tools.length; j++) {
        const a = tools[i];
        const b = tools[j];
        // Identical names are duplicate-tool-name's finding, not this one.
        if (a.name === b.name || !crossesBoundary(a, b)) continue;
        const [fa, fb] = [confusableForm(a.name), confusableForm(b.name)];
        const same = fa === fb;
        // A one-character difference between short names is usually just two
        // short names; between longer ones it is worth a second look.
        if (!same && (!withinOneEdit(fa, fb) || Math.min(fa.length, fb.length) < minLength)) continue;
        const how = same ? `differ only in case or separators (both read as "${fa}")` : "differ by a single character";
        out.push(
          finding(toolShadowing, `"${a.name}" in ${where(a)} and "${b.name}" in ${where(b)} ${how}.`, {
            tool: a.name,
            frame: a.frame,
            help: "Name tools so the difference is legible, and treat a near-copy arriving from a frame or script you do not control as the thing it looks like.",
          }),
        );
      }
    }
    return out;
  },
});

export const thirdPartyRegistration = defineRule({
  id: "third-party-registration",
  scope: "page",
  description: "A tool registered by a script from another origin is part of the page's agent surface but not of its source.",
  severity: "warning",
  defaults: { allow: [] as string[] },
  check: (ctx) => {
    const allow = new Set(opt<string[]>(ctx, "allow", []));
    return ctx.snapshot.tools.flatMap((tool) => {
      const script = registrationOrigin(tool);
      if (!script || script === tool.origin || allow.has(script)) return [];
      return [
        finding(thirdPartyRegistration, `Tool "${tool.name}" was registered by a script from ${script}, not from ${tool.origin}.`, {
          tool: tool.name,
          frame: tool.frame,
          help: `Its definition is not in this origin's source, so a static lint of this origin's source will never see it; lint it from the page. Add ${script} to this rule's "allow" if it is your own bundle host.`,
        }),
      ];
    });
  },
});
