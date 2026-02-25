import { randomUUID } from "node:crypto";
import type { GraphEdge, GraphNode } from "@graphen/shared";
import type { ExtractedEntity } from "../services/llmTypes.js";
import type { ChunkExtractionResult, ResolvedGraph } from "./types.js";

interface WorkingEntity {
  id: string;
  name: string;
  type: string;
  description: string;
  confidence: number;
  properties: Record<string, unknown>;
  sourceDocumentIds: Set<string>;
  sourceChunkIds: Set<string>;
  aliases: Set<string>;
  createdAt: Date;
  updatedAt: Date;
}

interface RelationMention {
  source: string;
  target: string;
  type: string;
  description: string;
  confidence: number;
  chunkId: string;
}

const synonymMap: Record<string, string> = {
  llm: "large language model",
  ai: "artificial intelligence"
};

export class EntityResolver {
  resolve(extractions: ChunkExtractionResult[], documentId: string): ResolvedGraph {
    const mentions: WorkingEntity[] = [];
    const relations: RelationMention[] = [];

    for (const item of extractions) {
      for (const entity of item.result.entities) {
        mentions.push(this.createWorkingEntity(entity, documentId, item.chunkId));
      }

      for (const relation of item.result.relations) {
        relations.push({
          source: relation.source,
          target: relation.target,
          type: relation.type,
          description: relation.description,
          confidence: relation.confidence,
          chunkId: item.chunkId
        });
      }
    }

    const exactMatched = this.stageExactMatch(mentions);
    const fuzzyMatched = this.stageFuzzyMatch(exactMatched);
    const semanticMatched = this.stageSemanticMatch(fuzzyMatched);

    const nodes = semanticMatched.map((entity) => this.toGraphNode(entity));
    const aliasToNodeId = this.buildAliasMap(semanticMatched);
    const edges = this.remapEdges(relations, aliasToNodeId, documentId);

    return { nodes, edges };
  }

  private stageExactMatch(entities: WorkingEntity[]): WorkingEntity[] {
    const grouped = new Map<string, WorkingEntity>();

    for (const entity of entities) {
      const key = this.normalizeName(entity.name);
      const existing = grouped.get(key);
      if (existing) {
        grouped.set(key, this.mergeEntity(existing, entity));
      } else {
        grouped.set(key, entity);
      }
    }

    return [...grouped.values()];
  }

  private stageFuzzyMatch(entities: WorkingEntity[]): WorkingEntity[] {
    const merged: WorkingEntity[] = [];

    for (const entity of entities) {
      let targetIndex = -1;
      for (let i = 0; i < merged.length; i += 1) {
        const existing = merged[i];
        if (!existing || existing.type !== entity.type) {
          continue;
        }

        const similarity = this.nameSimilarity(existing.name, entity.name);
        if (similarity >= 0.85) {
          targetIndex = i;
          break;
        }
      }

      if (targetIndex === -1) {
        merged.push(entity);
      } else {
        const target = merged[targetIndex];
        if (!target) {
          merged.push(entity);
        } else {
          merged[targetIndex] = this.mergeEntity(target, entity);
        }
      }
    }

    return merged;
  }

  private stageSemanticMatch(entities: WorkingEntity[]): WorkingEntity[] {
    const remaining = [...entities];
    const result: WorkingEntity[] = [];

    while (remaining.length > 0) {
      const current = remaining.shift();
      if (!current) {
        break;
      }

      let mergedEntity = current;
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        const candidate = remaining[i];
        if (!candidate || candidate.type !== mergedEntity.type) {
          continue;
        }

        const similarity = this.semanticSimilarity(mergedEntity.description, candidate.description);
        if (similarity >= 0.92) {
          mergedEntity = this.mergeEntity(mergedEntity, candidate);
          remaining.splice(i, 1);
        }
      }

      result.push(mergedEntity);
    }

    return result;
  }

  private remapEdges(
    relations: RelationMention[],
    aliasToNodeId: Map<string, string>,
    documentId: string
  ): GraphEdge[] {
    const edgeMap = new Map<string, GraphEdge>();
    const edgeConfidenceCount = new Map<string, number>();

    for (const relation of relations) {
      const sourceId = aliasToNodeId.get(this.normalizeName(relation.source));
      const targetId = aliasToNodeId.get(this.normalizeName(relation.target));
      if (!sourceId || !targetId || sourceId === targetId) {
        continue;
      }

      const edgeKey = `${sourceId}|${targetId}|${relation.type}`;
      const existing = edgeMap.get(edgeKey);
      if (!existing) {
        edgeMap.set(edgeKey, {
          id: randomUUID(),
          sourceNodeId: sourceId,
          targetNodeId: targetId,
          relationType: relation.type,
          description: relation.description,
          properties: {},
          weight: 1,
          sourceDocumentIds: [documentId],
          confidence: relation.confidence,
          createdAt: new Date()
        });
        edgeConfidenceCount.set(edgeKey, 1);
        continue;
      }

      const count = edgeConfidenceCount.get(edgeKey) ?? 1;
      const nextCount = count + 1;
      existing.confidence = (existing.confidence * count + relation.confidence) / nextCount;
      if (relation.description && !existing.description.includes(relation.description)) {
        existing.description = `${existing.description} | ${relation.description}`.trim();
      }
      edgeConfidenceCount.set(edgeKey, nextCount);
    }

    return [...edgeMap.values()];
  }

  private buildAliasMap(entities: WorkingEntity[]): Map<string, string> {
    const aliasMap = new Map<string, string>();
    for (const entity of entities) {
      aliasMap.set(this.normalizeName(entity.name), entity.id);
      for (const alias of entity.aliases) {
        aliasMap.set(this.normalizeName(alias), entity.id);
      }
    }
    return aliasMap;
  }

  private createWorkingEntity(
    entity: ExtractedEntity,
    documentId: string,
    sourceChunkId: string
  ): WorkingEntity {
    return {
      id: randomUUID(),
      name: entity.name.trim(),
      type: entity.type.trim() || "Unknown",
      description: entity.description.trim(),
      confidence: entity.confidence,
      properties: {},
      sourceDocumentIds: new Set([documentId]),
      sourceChunkIds: new Set([sourceChunkId]),
      aliases: new Set([entity.name.trim()]),
      createdAt: new Date(),
      updatedAt: new Date()
    };
  }

  private mergeEntity(a: WorkingEntity, b: WorkingEntity): WorkingEntity {
    const mergedName = pickPreferredName(a.name, b.name);
    const mergedDescription = mergeTextSegments(a.description, b.description);

    const merged: WorkingEntity = {
      ...a,
      name: mergedName,
      type: this.pickType(a.type, b.type),
      description: mergedDescription,
      confidence: (a.confidence + b.confidence) / 2,
      updatedAt: new Date()
    };

    for (const id of b.sourceDocumentIds) {
      merged.sourceDocumentIds.add(id);
    }
    for (const id of b.sourceChunkIds) {
      merged.sourceChunkIds.add(id);
    }
    for (const alias of b.aliases) {
      merged.aliases.add(alias);
    }

    return merged;
  }

  private pickType(typeA: string, typeB: string): string {
    if (typeA === typeB) {
      return typeA;
    }
    if (typeA === "Unknown") {
      return typeB;
    }
    if (typeB === "Unknown") {
      return typeA;
    }
    return typeA;
  }

  private toGraphNode(entity: WorkingEntity): GraphNode {
    return {
      id: entity.id,
      name: entity.name,
      type: entity.type,
      description: entity.description,
      properties: entity.properties,
      sourceDocumentIds: [...entity.sourceDocumentIds],
      sourceChunkIds: [...entity.sourceChunkIds],
      confidence: entity.confidence,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt
    };
  }

  private normalizeName(name: string): string {
    const normalized = name.trim().toLowerCase().replace(/\s+/g, " ");
    return synonymMap[normalized] ?? normalized;
  }

  private nameSimilarity(a: string, b: string): number {
    const normA = this.normalizeName(a);
    const normB = this.normalizeName(b);
    if (normA === normB) {
      return 1;
    }

    const lev = normalizedLevenshtein(normA, normB);
    const jac = jaccardSimilarity(normA, normB);
    return (lev + jac) / 2;
  }

  private semanticSimilarity(a: string, b: string): number {
    const vectorA = textVector(a);
    const vectorB = textVector(b);
    return cosineSimilarity(vectorA, vectorB);
  }
}

function pickPreferredName(a: string, b: string): string {
  return a.length >= b.length ? a : b;
}

function mergeTextSegments(a: string, b: string): string {
  const segments = new Set(
    [a, b]
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  );
  return [...segments].join(" | ");
}

function normalizedLevenshtein(a: string, b: string): number {
  const distance = levenshteinDistance(a, b);
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) {
    return 1;
  }
  return 1 - distance / maxLength;
}

function levenshteinDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, idx) => idx);

  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1);
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = (prev[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const substitution = (prev[j - 1] ?? 0) + cost;
      current[j] = Math.min(deletion, insertion, substitution);
    }
    prev = current;
  }

  return prev[b.length] ?? 0;
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.split(/\s+/).filter(Boolean));
  const setB = new Set(b.split(/\s+/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function textVector(text: string, dimension = 128): number[] {
  const vector = new Array<number>(dimension).fill(0);
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

  for (const token of tokens) {
    const idx = hashToken(token) % dimension;
    vector[idx] = (vector[idx] ?? 0) + 1;
  }

  return vector;
}

function hashToken(token: string): number {
  let hash = 0;
  for (let i = 0; i < token.length; i += 1) {
    hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const valueA = a[i] ?? 0;
    const valueB = b[i] ?? 0;
    dot += valueA * valueB;
    normA += valueA * valueA;
    normB += valueB * valueB;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
