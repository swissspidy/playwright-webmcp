import { lexicalSimilarity, type SimilarityFn } from "../similarity.js";
import type { Finding } from "../types.js";
import { defineRule, finding, opt } from "./helpers.js";

export const duplicateToolName = defineRule({
  id: "duplicate-tool-name",
  scope: "page",
  description: "Two tools with the same name on one page leave the agent guessing which one it gets.",
  severity: "error",
  check: (ctx) => {
    const seen = new Map<string, number[]>();
    ctx.snapshot.tools.forEach((t, i) => seen.set(t.name, [...(seen.get(t.name) ?? []), i]));
    return [...seen.entries()]
      .filter(([, idx]) => idx.length > 1)
      .map(([name, idx]) => {
        const frames = idx.map((i) => ctx.snapshot.tools[i].frame);
        const where = new Set(frames).size > 1 ? `across frames ${[...new Set(frames)].join(", ")}` : "in the same frame";
        return finding(duplicateToolName, `Tool "${name}" is registered ${idx.length} times ${where}.`, { tool: name });
      });
  },
});

export const similarDescriptions = defineRule({
  id: "similar-descriptions",
  scope: "page",
  description: "Tools whose descriptions read almost the same get confused by models; make the distinction explicit.",
  severity: "warning",
  defaults: { threshold: 0.7 },
  check: (ctx) => {
    const threshold = opt(ctx, "threshold", 0.7);
    const similarity = opt<SimilarityFn>(ctx, "similarity", lexicalSimilarity);
    const tools = ctx.snapshot.tools.filter((t) => t.description?.trim());
    const out = [];
    for (let i = 0; i < tools.length; i++) {
      for (let j = i + 1; j < tools.length; j++) {
        const score = similarity(tools[i].description, tools[j].description);
        if (score >= threshold)
          out.push(
            finding(similarDescriptions, `"${tools[i].name}" and "${tools[j].name}" have near-identical descriptions (similarity ${score.toFixed(2)}).`, {
              tool: tools[i].name,
              help: "State what differs: scope, side effects, or the shape of the result.",
            }),
          );
      }
    }
    return out;
  },
});

export const tooManyTools = defineRule({
  id: "too-many-tools",
  scope: "page",
  description: "Large tool lists overflow small on-device model contexts and degrade tool selection.",
  severity: "warning",
  defaults: { max: 20 },
  check: (ctx) => {
    const max = opt(ctx, "max", 20);
    const n = ctx.snapshot.tools.length;
    return n > max
      ? [
          finding(tooManyTools, `${n} tools are exposed on this page; consider keeping it under ${max}.`, {
            help: "Register tools for the current view only and unregister them on navigation.",
          }),
        ]
      : [];
  },
});

export const noTools = defineRule({
  id: "no-tools",
  scope: "page",
  description: "Reports pages that expose no tools at all, which usually means registration failed.",
  severity: "info",
  check: (ctx) => (ctx.snapshot.tools.length === 0 ? [finding(noTools, `No WebMCP tools were found on ${ctx.snapshot.url}.`)] : []),
});

export const iframeAllowTools = defineRule({
  id: "iframe-allow-tools",
  scope: "page",
  description: 'Cross-origin iframes only expose tools when the embedding element carries allow="tools".',
  severity: "info",
  check: (ctx) => {
    const out: Finding[] = [];
    ctx.snapshot.frames.forEach((f, i) => {
      if (f.isTop || !f.crossOriginFromTop) return;
      const hasTools = ctx.snapshot.tools.some((t) => t.frame === i);
      const allowed = (f.allow ?? "").split(/[;\s]+/).includes("tools");
      if (hasTools && !allowed)
        out.push(
          finding(iframeAllowTools, `Cross-origin frame ${f.url} registers tools but its <iframe> lacks allow="tools".`, {
            frame: i,
          }),
        );
    });
    return out;
  },
});
