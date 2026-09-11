/**
 * Tool contracts: a stable, diffable description of what a page exposes to
 * agents, suitable for storing as a snapshot in the repository.
 */
import type { JsonSchema, PageSnapshot, ToolSnapshot, ToolSource } from "./types.js";

export interface ContractTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema | null;
  annotations?: Record<string, unknown>;
  source: ToolSource;
  origin: string;
}

export interface ToolContract {
  version: 1;
  tools: ContractTool[];
}

export interface ContractChange {
  kind: "tool-added" | "tool-removed" | "title-changed" | "description-changed" | "schema-changed" | "annotations-changed" | "source-changed";
  tool: string;
  detail: string;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * The CDP domain reports `autosubmit` as an annotation on declarative tools;
 * the page-side collector only knows it from the form attribute. Fold it in so
 * contracts and docs see the same thing whichever collector produced the
 * snapshot.
 */
function contractAnnotations(tool: ToolSnapshot): Record<string, unknown> | undefined {
  const annotations = { ...(tool.annotations ?? {}) };
  if (tool.declarative?.autosubmit && annotations.autosubmit === undefined) annotations.autosubmit = true;
  return Object.keys(annotations).length ? (sortKeys(annotations) as Record<string, unknown>) : undefined;
}

export function toContract(snapshot: PageSnapshot): ToolContract {
  const tools = snapshot.tools
    .map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description ?? "",
      inputSchema: (sortKeys(t.inputSchema ?? null) as JsonSchema | null) ?? null,
      annotations: contractAnnotations(t),
      source: t.source,
      origin: t.origin,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.origin.localeCompare(b.origin));
  return { version: 1, tools };
}

export function serializeContract(contract: ToolContract): string {
  return JSON.stringify(contract, null, 2) + "\n";
}

function props(schema: JsonSchema | null): Record<string, JsonSchema> {
  return ((schema?.properties ?? {}) as Record<string, JsonSchema>) || {};
}

function schemaChanges(tool: string, before: JsonSchema | null, after: JsonSchema | null): ContractChange[] {
  const out: ContractChange[] = [];
  if (JSON.stringify(before) === JSON.stringify(after)) return out;
  const b = props(before);
  const a = props(after);
  for (const k of Object.keys(a)) if (!(k in b)) out.push({ kind: "schema-changed", tool, detail: `parameter "${k}" added` });
  for (const k of Object.keys(b)) if (!(k in a)) out.push({ kind: "schema-changed", tool, detail: `parameter "${k}" removed` });
  for (const k of Object.keys(a)) {
    if (!(k in b)) continue;
    if (JSON.stringify(a[k].type) !== JSON.stringify(b[k].type))
      out.push({ kind: "schema-changed", tool, detail: `parameter "${k}" type ${JSON.stringify(b[k].type)} -> ${JSON.stringify(a[k].type)}` });
    if (JSON.stringify(a[k].enum) !== JSON.stringify(b[k].enum)) out.push({ kind: "schema-changed", tool, detail: `parameter "${k}" enum changed` });
    if (a[k].description !== b[k].description) out.push({ kind: "schema-changed", tool, detail: `parameter "${k}" description changed` });
  }
  const rb = new Set((before?.required as string[] | undefined) ?? []);
  const ra = new Set((after?.required as string[] | undefined) ?? []);
  for (const k of ra) if (!rb.has(k)) out.push({ kind: "schema-changed", tool, detail: `parameter "${k}" is now required` });
  for (const k of rb) if (!ra.has(k)) out.push({ kind: "schema-changed", tool, detail: `parameter "${k}" is no longer required` });
  if (!out.length) out.push({ kind: "schema-changed", tool, detail: "inputSchema changed" });
  return out;
}

export function diffContracts(before: ToolContract, after: ToolContract): ContractChange[] {
  const key = (t: ContractTool) => `${t.origin} ${t.name}`;
  const b = new Map(before.tools.map((t) => [key(t), t]));
  const a = new Map(after.tools.map((t) => [key(t), t]));
  const out: ContractChange[] = [];
  for (const [k, t] of a) if (!b.has(k)) out.push({ kind: "tool-added", tool: t.name, detail: `new ${t.source} tool at ${t.origin}` });
  for (const [k, t] of b) if (!a.has(k)) out.push({ kind: "tool-removed", tool: t.name, detail: `${t.source} tool at ${t.origin} is gone` });
  for (const [k, t] of a) {
    const prev = b.get(k);
    if (!prev) continue;
    if ((prev.title ?? "") !== (t.title ?? "")) out.push({ kind: "title-changed", tool: t.name, detail: `"${prev.title ?? ""}" -> "${t.title ?? ""}"` });
    if (prev.description !== t.description) out.push({ kind: "description-changed", tool: t.name, detail: `"${prev.description}" -> "${t.description}"` });
    out.push(...schemaChanges(t.name, prev.inputSchema, t.inputSchema));
    if (JSON.stringify(prev.annotations ?? null) !== JSON.stringify(t.annotations ?? null))
      out.push({ kind: "annotations-changed", tool: t.name, detail: "annotations changed" });
    if (prev.source !== t.source) out.push({ kind: "source-changed", tool: t.name, detail: `${prev.source} -> ${t.source}` });
  }
  return out;
}

export function formatChanges(changes: ContractChange[]): string {
  return changes.map((c) => `${c.kind.padEnd(20)} ${c.tool}: ${c.detail}`).join("\n");
}
