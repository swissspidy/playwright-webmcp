/**
 * Lightweight text similarity used by the `similar-descriptions` rule.
 * Cosine similarity over unigram + bigram term frequencies. Deliberately
 * dependency free; callers can plug in an embedding based function instead.
 */

const STOP = new Set(["a", "an", "the", "of", "to", "for", "and", "or", "in", "on", "with", "by", "from", "this", "that", "is", "are", "be"]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));
}

export function termVector(text: string): Map<string, number> {
  const tokens = tokenize(text);
  const vec = new Map<string, number>();
  const bump = (k: string) => vec.set(k, (vec.get(k) ?? 0) + 1);
  for (let i = 0; i < tokens.length; i++) {
    bump(tokens[i]);
    if (i + 1 < tokens.length) bump(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return vec;
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    const w = b.get(k);
    if (w) dot += v * w;
  }
  for (const v of b.values()) nb += v * v;
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export type SimilarityFn = (a: string, b: string) => number;

export const lexicalSimilarity: SimilarityFn = (a, b) => cosine(termVector(a), termVector(b));
