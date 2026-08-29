import crypto from "node:crypto";

/**
 * Deterministic local embedder.
 *
 * Anthropic ships no embeddings endpoint, and the vector leg of the match
 * funnel is a *ranking prefilter*, not the final judgment — so a hashed
 * bag-of-features projection is the right tool: no network, no cost, no
 * nondeterminism, and same input always yields the same vector (which is what
 * makes checkpoint resume produce identical prescores).
 *
 * Swap `Embedder` for a hosted model when recall on the prefilter matters more
 * than reproducibility; nothing above this module knows the difference.
 */
export interface Embedder {
  readonly dim: number;
  readonly name: string;
  embed(text: string): Float32Array;
}

const STOP = new Set([
  "a","an","the","and","or","of","to","in","for","on","with","at","by","from","as","is","are","be","we","you",
  "our","your","will","that","this","it","its","have","has","who","what","their","they","them","not","but",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#./-]+/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[-./]+|[-./]+$/g, ""))
    .filter((t) => t.length > 1 && t.length < 40 && !STOP.has(t));
}

export class HashingEmbedder implements Embedder {
  readonly name = "hashing-v1";
  constructor(readonly dim = 512) {}

  embed(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const tokens = tokenize(text);
    if (tokens.length === 0) return v;

    // Unigrams carry topic, bigrams carry phrasing ("distributed systems" is
    // not "distributed" + "systems"). Sublinear term weighting keeps a JD that
    // repeats "Kubernetes" nine times from dominating the vector.
    const counts = new Map<string, number>();
    const bump = (key: string, w: number) => counts.set(key, (counts.get(key) ?? 0) + w);
    for (let i = 0; i < tokens.length; i++) {
      bump(tokens[i]!, 1);
      if (i + 1 < tokens.length) bump(`${tokens[i]}_${tokens[i + 1]}`, 0.6);
    }

    for (const [term, count] of counts) {
      const h = hash32(term);
      const idx = h % this.dim;
      // Signed hashing halves collision bias without a second hash table.
      const sign = (h >>> 31) & 1 ? -1 : 1;
      v[idx]! += sign * (1 + Math.log(count));
    }

    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < v.length; i++) v[i]! /= norm;
    return v;
  }
}

function hash32(s: string): number {
  // FNV-1a. Cheap, stable across processes, good enough spread for 512 buckets.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function sha1(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex");
}

export function cosineSim(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!, y = b[i]!;
    dot += x * y; na += x * x; nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export const defaultEmbedder = new HashingEmbedder(512);
