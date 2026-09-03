/**
 * Heuristics for text that tries to steer an agent: prompt-injection phrases,
 * role markers, and invisible or bidirectional characters. Used both for
 * tool descriptions (static) and tool results (runtime).
 */

export interface InjectionHit {
  kind: "instruction-override" | "role-marker" | "exfiltration" | "hidden-characters" | "bidi-override" | "excessive-length";
  match: string;
}

const PHRASES: Array<[RegExp, InjectionHit["kind"]]> = [
  [/ignore (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions|prompts|messages|rules)/i, "instruction-override"],
  [/disregard (?:all |any |the )?(?:previous|prior|above|earlier)/i, "instruction-override"],
  [/you are now (?:a|an|the) /i, "instruction-override"],
  [/new instructions?:/i, "instruction-override"],
  [/(?:^|\s)(?:system|assistant|developer) ?(?:prompt|message)\s*:/i, "instruction-override"],
  [/do not (?:tell|inform|show|reveal to) the user/i, "exfiltration"],
  [/(?:send|post|forward|email|exfiltrate) (?:the |all |your )?(?:conversation|history|credentials|password|token|api key|cookies)/i, "exfiltration"],
  [/<\/?(?:system|assistant|user|tool|instructions?)>/i, "role-marker"],
  [/\[(?:INST|SYS|SYSTEM)\]/i, "role-marker"],
  [/<\|(?:im_start|im_end|system|user|assistant)\|>/i, "role-marker"],
];

const HIDDEN = /[\u200B-\u200F\u2060\uFEFF\u00AD]/g;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;

export interface DetectOptions {
  /** Flag strings longer than this many characters. Default: unlimited. */
  maxLength?: number;
}

export function detectInjection(text: string, options: DetectOptions = {}): InjectionHit[] {
  const hits: InjectionHit[] = [];
  if (typeof text !== "string" || !text) return hits;
  for (const [re, kind] of PHRASES) {
    const m = re.exec(text);
    if (m) hits.push({ kind, match: m[0].trim() });
  }
  const hidden = text.match(HIDDEN);
  if (hidden) hits.push({ kind: "hidden-characters", match: `${hidden.length} zero-width or soft-hyphen character(s)` });
  const bidi = text.match(BIDI);
  if (bidi) hits.push({ kind: "bidi-override", match: `${bidi.length} bidirectional override character(s)` });
  if (options.maxLength && text.length > options.maxLength) hits.push({ kind: "excessive-length", match: `${text.length} characters` });
  return hits;
}

/** Walk a JSON value and detect injection in every string leaf. Returns (path, hits). */
export function scanValue(value: unknown, options: DetectOptions = {}, path = ""): Array<{ path: string; hits: InjectionHit[] }> {
  const out: Array<{ path: string; hits: InjectionHit[] }> = [];
  if (typeof value === "string") {
    const hits = detectInjection(value, options);
    if (hits.length) out.push({ path: path || "/", hits });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => out.push(...scanValue(v, options, `${path}/${i}`)));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out.push(...scanValue(v, options, `${path}/${k}`));
  }
  return out;
}
