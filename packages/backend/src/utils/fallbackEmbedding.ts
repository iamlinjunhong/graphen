import { appConfig } from "../config.js";

function normalizeText(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function buildFallbackTextEmbedding(text: string): number[] {
  const normalized = normalizeText(text);
  if (normalized.length === 0) {
    return [];
  }

  const dimensions = appConfig.EMBEDDING_DIMENSIONS;
  const values = new Array<number>(dimensions).fill(0);
  const chars = [...normalized];

  const addWeightedToken = (token: string, weight: number): void => {
    const index = hashToken(token) % dimensions;
    values[index] = (values[index] ?? 0) + weight;
  };

  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index];
    if (!current) {
      continue;
    }
    addWeightedToken(`u:${current}`, 1);

    const next = chars[index + 1];
    if (next) {
      addWeightedToken(`b:${current}${next}`, 1.5);
    }
  }

  addWeightedToken(`t:${normalized}`, 2);

  let squaredNorm = 0;
  for (const value of values) {
    squaredNorm += value * value;
  }

  if (squaredNorm <= 0) {
    return [];
  }

  const norm = Math.sqrt(squaredNorm);
  return values.map((value) => Number((value / norm).toFixed(8)));
}
