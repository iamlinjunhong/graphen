import type { MemoryEntryFact } from "@graphen/shared";
import type { Pool } from "pg";
import type { Neo4jSyncTargetLike } from "../workers/GraphSyncWorker.js";
import { logger } from "./logger.js";

/**
 * 将 facts 同步写入 Neo4j（内联同步，与 PG 写入并行调用）。
 * 成功的 fact 会在 PG 中标记 neo4j_synced=TRUE。
 * 失败不抛异常，仅记录日志；失败的 fact 仍保持 neo4j_synced=FALSE，
 * 由 GraphSyncWorker 后续重试。
 */
export async function syncFactsToNeo4jInline(
  neo4j: Neo4jSyncTargetLike,
  facts: MemoryEntryFact[],
  pgPool?: Pool,
  documentId?: string
): Promise<{ synced: number; failed: number }> {
  if (facts.length === 0) {
    return { synced: 0, failed: 0 };
  }

  const results = await Promise.allSettled(
    facts.map((fact) => syncSingleFact(neo4j, fact, documentId))
  );

  const syncedIds: string[] = [];
  let failed = 0;
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === "fulfilled") {
      syncedIds.push(facts[i]!.id);
    } else {
      failed++;
    }
  }

  // 标记成功同步的 facts
  if (syncedIds.length > 0 && pgPool) {
    try {
      await pgPool.query(
        `
          UPDATE memory_facts
          SET neo4j_synced = TRUE,
              neo4j_synced_at = NOW(),
              neo4j_last_error = NULL,
              updated_at = NOW()
          WHERE id = ANY($1::uuid[])
        `,
        [syncedIds]
      );
    } catch (err) {
      logger.warn({ err }, "syncFactsToNeo4jInline: failed to mark facts as synced in PG (non-fatal)");
    }
  }

  if (failed > 0) {
    logger.warn(
      { synced: syncedIds.length, failed, total: facts.length },
      "syncFactsToNeo4jInline: some facts failed (will be retried by GraphSyncWorker)"
    );
  }

  return { synced: syncedIds.length, failed };
}

async function syncSingleFact(
  neo4j: Neo4jSyncTargetLike,
  fact: MemoryEntryFact,
  documentId?: string
): Promise<void> {
  const subjectText = fact.subjectText.trim();
  const predicate = fact.predicate.trim();
  const subjectNodeKey = fact.subjectNodeId?.trim() || `text:${normalizeForKey(subjectText)}`;
  const objectNodeKey = fact.objectNodeId?.trim() || `value:${fact.entryId}:${fact.normalizedFactKey}`;
  const objectText = fact.objectText?.trim() || fact.objectNodeId?.trim() || objectNodeKey;
  const syncKey = `${fact.entryId}:${fact.normalizedFactKey}`;
  const confidence = clampConfidence(fact.confidence);

  const subjectLower = normalizeForKey(subjectText);
  const objectLower = normalizeForKey(objectText);
  const sourceDocIds = documentId ? [documentId] : [];

  logger.debug(
    { factId: fact.id, subjectText, subjectLower, objectText, objectLower, predicate, subjectNodeKey },
    "syncSingleFact: syncing"
  );

  // Use nameLower indexed field for fast lookup, with toLower() fallback
  // for nodes that don't have nameLower set yet.
  // Also set nameLower on created/matched nodes to keep the index populated.
  await neo4j.runCypher(
    `
      OPTIONAL MATCH (existingS:Entity)
      WHERE existingS.nameLower = $subjectLower
         OR (existingS.nameLower IS NULL AND toLower(existingS.name) = $subjectLower)
      WITH existingS
      ORDER BY
        CASE WHEN existingS.type <> 'auto' THEN 0 ELSE 1 END ASC,
        existingS.createdAt ASC
      LIMIT 1
      WITH coalesce(existingS.id, $subjectNodeKey) AS sId

      MERGE (s:Entity {id: sId})
      ON CREATE SET
        s.name = $subjectText,
        s.nameLower = $subjectLower,
        s.type = 'auto',
        s.sourceDocumentIds = $sourceDocIds,
        s.createdAt = datetime(),
        s.updatedAt = datetime()
      ON MATCH SET
        s.name = coalesce(s.name, $subjectText),
        s.nameLower = coalesce(s.nameLower, $subjectLower),
        s.sourceDocumentIds = CASE
          WHEN size($sourceDocIds) > 0
          THEN REDUCE(acc = coalesce(s.sourceDocumentIds, []),
                      x IN $sourceDocIds |
                      CASE WHEN x IN acc THEN acc ELSE acc + x END)
          ELSE s.sourceDocumentIds
        END,
        s.updatedAt = datetime()

      WITH s
      OPTIONAL MATCH (existingO:Entity)
      WHERE existingO.nameLower = $objectLower
         OR (existingO.nameLower IS NULL AND toLower(existingO.name) = $objectLower)
      WITH s, existingO
      ORDER BY
        CASE WHEN existingO.type <> 'auto' THEN 0 ELSE 1 END ASC,
        existingO.createdAt ASC
      LIMIT 1
      WITH s, coalesce(existingO.id, $objectNodeKey) AS oId

      MERGE (o:Entity {id: oId})
      ON CREATE SET
        o.name = $objectText,
        o.nameLower = $objectLower,
        o.type = 'auto',
        o.sourceDocumentIds = $sourceDocIds,
        o.createdAt = datetime(),
        o.updatedAt = datetime()
      ON MATCH SET
        o.name = coalesce(o.name, $objectText),
        o.nameLower = coalesce(o.nameLower, $objectLower),
        o.sourceDocumentIds = CASE
          WHEN size($sourceDocIds) > 0
          THEN REDUCE(acc = coalesce(o.sourceDocumentIds, []),
                      x IN $sourceDocIds |
                      CASE WHEN x IN acc THEN acc ELSE acc + x END)
          ELSE o.sourceDocumentIds
        END,
        o.updatedAt = datetime()

      MERGE (s)-[r:RELATED_TO {syncKey: $syncKey}]->(o)
      ON CREATE SET
        r.id = $factId,
        r.sourceNodeId = s.id,
        r.targetNodeId = o.id,
        r.relationType = $predicate,
        r.description = $predicate,
        r.properties = '{}',
        r.weight = 1.0,
        r.sourceDocumentIds = $sourceDocIds,
        r.confidence = $confidence,
        r.createdAt = datetime()
      ON MATCH SET
        r.id = $factId,
        r.sourceNodeId = s.id,
        r.targetNodeId = o.id,
        r.relationType = $predicate,
        r.description = $predicate,
        r.confidence = $confidence,
        r.sourceDocumentIds = CASE
          WHEN size($sourceDocIds) > 0
          THEN REDUCE(acc = coalesce(r.sourceDocumentIds, []),
                      x IN $sourceDocIds |
                      CASE WHEN x IN acc THEN acc ELSE acc + x END)
          ELSE r.sourceDocumentIds
        END,
        r.updatedAt = datetime()
    `,
    {
      factId: fact.id,
      syncKey,
      subjectNodeKey,
      subjectText,
      subjectLower,
      predicate,
      objectNodeKey,
      objectText,
      objectLower,
      confidence,
      sourceDocIds
    }
  );
}

function normalizeForKey(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, value));
}

/**
 * 要从 Neo4j 中删除的 fact 的最小信息。
 */
export interface DeleteFactInfo {
  id: string;
  entryId: string;
  subjectNodeId: string | null;
  subjectText: string;
  normalizedFactKey: string;
}

/**
 * 从 Neo4j 中删除已软删除的 facts 对应的边和孤儿节点（内联同步）。
 * 成功删除的 fact 在 PG 中标记 neo4j_synced=TRUE。
 * 失败不抛异常，仅记录日志；失败的 fact 由 GraphSyncWorker 后续重试。
 */
export async function deleteFactsFromNeo4jInline(
  neo4j: Neo4jSyncTargetLike,
  facts: DeleteFactInfo[],
  pgPool?: Pool
): Promise<{ deleted: number; failed: number }> {
  if (facts.length === 0) {
    return { deleted: 0, failed: 0 };
  }

  const results = await Promise.allSettled(
    facts.map((fact) => deleteSingleFactFromNeo4j(neo4j, fact))
  );

  const deletedIds: string[] = [];
  let failed = 0;
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === "fulfilled") {
      deletedIds.push(facts[i]!.id);
    } else {
      failed++;
      logger.warn(
        { factId: facts[i]!.id, err: result.reason },
        "deleteFactsFromNeo4jInline: failed to delete fact from Neo4j"
      );
    }
  }

  // 标记成功删除的 facts 为已同步（即 Neo4j 中已清理）
  if (deletedIds.length > 0 && pgPool) {
    try {
      await pgPool.query(
        `
          UPDATE memory_facts
          SET neo4j_synced = TRUE,
              neo4j_synced_at = NOW(),
              neo4j_last_error = NULL,
              updated_at = NOW()
          WHERE id = ANY($1::uuid[])
        `,
        [deletedIds]
      );
    } catch (err) {
      logger.warn({ err }, "deleteFactsFromNeo4jInline: failed to mark facts as synced in PG (non-fatal)");
    }
  }

  if (failed > 0) {
    logger.warn(
      { deleted: deletedIds.length, failed, total: facts.length },
      "deleteFactsFromNeo4jInline: some facts failed (will be retried by GraphSyncWorker)"
    );
  }

  return { deleted: deletedIds.length, failed };
}

/**
 * 从 Neo4j 中删除单条 fact 对应的 RELATED_TO 边。
 * 删除边后，如果产生了没有任何边的孤儿 Entity 节点（type='auto'），
 * 也一并清理。
 */
async function deleteSingleFactFromNeo4j(
  neo4j: Neo4jSyncTargetLike,
  fact: DeleteFactInfo
): Promise<void> {
  const syncKey = `${fact.entryId}:${fact.normalizedFactKey}`;

  // 1. 删除 RELATED_TO 边（通过 syncKey 精确匹配）
  // 2. 清理因删边而成为孤儿的 auto Entity 节点
  await neo4j.runCypher(
    `
      MATCH (s)-[r:RELATED_TO {syncKey: $syncKey}]->(o)
      DELETE r
      WITH s, o
      CALL {
        WITH s
        WITH s WHERE s.type = 'auto'
          AND NOT EXISTS { (s)-[]-() }
        DETACH DELETE s
      }
      CALL {
        WITH o
        WITH o WHERE o.type = 'auto'
          AND NOT EXISTS { (o)-[]-() }
        DETACH DELETE o
      }
    `,
    { syncKey }
  );
}
