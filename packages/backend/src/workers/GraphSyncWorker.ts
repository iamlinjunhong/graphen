import type { Pool, PoolClient } from "pg";
import { logger } from "../utils/logger.js";

interface SyncFactRow {
  id: string;
  entry_id: string;
  subject_node_id: string | null;
  subject_text: string;
  predicate: string;
  object_node_id: string | null;
  object_text: string | null;
  normalized_fact_key: string;
  confidence: number;
  created_at: string;
}

interface DeleteSyncFactRow {
  id: string;
  entry_id: string;
  subject_node_id: string | null;
  subject_text: string;
  normalized_fact_key: string;
}

export interface GraphSyncWorkerStats {
  fetched: number;
  synced: number;
  failed: number;
  maxLagMs: number;
  durationMs: number;
  deleteFetched: number;
  deleteSynced: number;
  deleteFailed: number;
}

export interface Neo4jSyncTargetLike {
  runCypher(query: string, params?: Record<string, unknown>): Promise<void>;
}

export interface GraphSyncWorkerOptions {
  intervalMs?: number;
  batchSize?: number;
  maxRetries?: number;
}

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_RETRIES = 3;

export class GraphSyncWorker {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private waitTimer: NodeJS.Timeout | null = null;
  private waitResolver: (() => void) | null = null;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxRetries: number;

  constructor(
    private readonly pgPool: Pool,
    private readonly neo4j: Neo4jSyncTargetLike,
    options: GraphSyncWorkerOptions = {}
  ) {
    this.intervalMs = sanitizePositiveInt(options.intervalMs, DEFAULT_INTERVAL_MS);
    this.batchSize = sanitizePositiveInt(options.batchSize, DEFAULT_BATCH_SIZE);
    this.maxRetries = sanitizePositiveInt(options.maxRetries, DEFAULT_MAX_RETRIES);
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loopPromise = this.loop();
    logger.info(
      {
        intervalMs: this.intervalMs,
        batchSize: this.batchSize,
        maxRetries: this.maxRetries
      },
      "GraphSyncWorker started"
    );
  }

  async stop(): Promise<void> {
    if (!this.running && !this.loopPromise) {
      return;
    }

    this.running = false;
    this.cancelWait();
    const pendingLoop = this.loopPromise;
    this.loopPromise = null;
    if (pendingLoop) {
      await pendingLoop;
    }
    logger.info("GraphSyncWorker stopped");
  }

  async syncOnce(): Promise<GraphSyncWorkerStats> {
    return this.syncBatch();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.syncBatch();
      } catch (error) {
        logger.error(
          { err: error },
          "GraphSyncWorker loop error"
        );
      }

      if (!this.running) {
        break;
      }
      await this.wait(this.intervalMs);
    }
  }

  private async syncBatch(): Promise<GraphSyncWorkerStats> {
    const startedAt = Date.now();

    // --- Phase 1: Upsert sync (create/update) ---
    let fetched = 0;
    let synced = 0;
    let failed = 0;
    let maxLagMs = 0;

    const upsertClient = await this.pgPool.connect();
    try {
      await upsertClient.query("BEGIN");
      const rows = await this.fetchPendingFacts(upsertClient);
      fetched = rows.length;

      if (rows.length > 0) {
        const syncedIds: string[] = [];
        const now = Date.now();

        for (const fact of rows) {
          const createdAtMs = new Date(fact.created_at).getTime();
          if (Number.isFinite(createdAtMs)) {
            maxLagMs = Math.max(maxLagMs, Math.max(0, now - createdAtMs));
          }

          try {
            await this.syncFactToNeo4j(fact);
            syncedIds.push(fact.id);
          } catch (error) {
            failed += 1;
            const reason = stringifyError(error);
            await upsertClient.query(
              `
                UPDATE memory_facts
                SET neo4j_retry_count = neo4j_retry_count + 1,
                    neo4j_last_error = $2,
                    updated_at = NOW()
                WHERE id = $1::uuid
              `,
              [fact.id, reason]
            );
            logger.warn(
              { factId: fact.id, entryId: fact.entry_id, reason },
              "GraphSyncWorker fact sync failed"
            );
          }
        }

        if (syncedIds.length > 0) {
          await upsertClient.query(
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
        }
        synced = syncedIds.length;
      }

      await upsertClient.query("COMMIT");
    } catch (error) {
      await safeRollback(upsertClient);
      throw error;
    } finally {
      upsertClient.release();
    }

    // --- Phase 2: Delete sync (清理已删除 facts 在 Neo4j 中的边和孤儿节点) ---
    let deleteFetched = 0;
    let deleteSynced = 0;
    let deleteFailed = 0;

    const deleteClient = await this.pgPool.connect();
    try {
      await deleteClient.query("BEGIN");
      const deletedRows = await this.fetchDeletedFacts(deleteClient);
      deleteFetched = deletedRows.length;

      if (deletedRows.length > 0) {
        const deletedIds: string[] = [];

        for (const fact of deletedRows) {
          try {
            await this.deleteFactFromNeo4j(fact);
            deletedIds.push(fact.id);
          } catch (error) {
            deleteFailed += 1;
            const reason = stringifyError(error);
            await deleteClient.query(
              `
                UPDATE memory_facts
                SET neo4j_retry_count = neo4j_retry_count + 1,
                    neo4j_last_error = $2,
                    updated_at = NOW()
                WHERE id = $1::uuid
              `,
              [fact.id, reason]
            );
            logger.warn(
              { factId: fact.id, entryId: fact.entry_id, reason },
              "GraphSyncWorker delete-sync failed"
            );
          }
        }

        if (deletedIds.length > 0) {
          await deleteClient.query(
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
        }
        deleteSynced = deletedIds.length;
      }

      await deleteClient.query("COMMIT");
    } catch (error) {
      await safeRollback(deleteClient);
      // 删除同步失败不影响整体 stats，只记录日志
      logger.error({ err: error }, "GraphSyncWorker delete-sync batch error");
    } finally {
      deleteClient.release();
    }

    const stats: GraphSyncWorkerStats = {
      fetched,
      synced,
      failed,
      maxLagMs,
      durationMs: Date.now() - startedAt,
      deleteFetched,
      deleteSynced,
      deleteFailed
    };
    if (fetched > 0 || deleteFetched > 0) {
      logger.info(
        stats,
        "GraphSyncWorker sync batch finished"
      );
    }
    return stats;
  }

  private async fetchPendingFacts(client: PoolClient): Promise<SyncFactRow[]> {
    const result = await client.query<SyncFactRow>(
      `
        SELECT
          id,
          entry_id,
          subject_node_id,
          subject_text,
          predicate,
          object_node_id,
          object_text,
          normalized_fact_key,
          confidence,
          created_at
        FROM memory_facts
        WHERE neo4j_synced = FALSE
          AND deleted_at IS NULL
          AND fact_state = 'active'
          AND subject_text IS NOT NULL
          AND subject_text <> ''
          AND predicate IS NOT NULL
          AND predicate <> ''
          AND (
            object_node_id IS NOT NULL
            OR (object_text IS NOT NULL AND object_text <> '')
          )
          AND neo4j_retry_count < $2
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `,
      [this.batchSize, this.maxRetries]
    );

    return result.rows;
  }

  /**
   * 获取已软删除但尚未在 Neo4j 中清理的 facts。
   */
  private async fetchDeletedFacts(client: PoolClient): Promise<DeleteSyncFactRow[]> {
    const result = await client.query<DeleteSyncFactRow>(
      `
        SELECT
          id,
          entry_id,
          subject_node_id,
          subject_text,
          normalized_fact_key
        FROM memory_facts
        WHERE neo4j_synced = FALSE
          AND fact_state = 'deleted'
          AND neo4j_retry_count < $2
        ORDER BY updated_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `,
      [this.batchSize, this.maxRetries]
    );

    return result.rows;
  }

  /**
   * 从 Neo4j 中删除已删除 fact 对应的 RELATED_TO 边，并清理孤儿节点。
   */
  private async deleteFactFromNeo4j(fact: DeleteSyncFactRow): Promise<void> {
    const syncKey = `${fact.entry_id}:${fact.normalized_fact_key}`;

    await this.neo4j.runCypher(
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

  private async syncFactToNeo4j(fact: SyncFactRow): Promise<void> {
    const subjectText = fact.subject_text.trim();
    const predicate = fact.predicate.trim();
    const subjectNodeKey = fact.subject_node_id?.trim() || `text:${normalizeForKey(subjectText)}`;
    const objectNodeKey = fact.object_node_id?.trim() || `value:${fact.entry_id}:${fact.normalized_fact_key}`;
    const objectText = fact.object_text?.trim() || fact.object_node_id?.trim() || objectNodeKey;
    const syncKey = `${fact.entry_id}:${fact.normalized_fact_key}`;
    const confidence = clampConfidence(fact.confidence);

    await this.neo4j.runCypher(
      `
        MERGE (s:Entity {id: $subjectNodeKey})
        ON CREATE SET
          s.name = $subjectText,
          s.type = 'auto',
          s.createdAt = datetime(),
          s.updatedAt = datetime()
        ON MATCH SET
          s.name = coalesce(s.name, $subjectText),
          s.updatedAt = datetime()

        MERGE (o:Entity {id: $objectNodeKey})
        ON CREATE SET
          o.name = $objectText,
          o.type = 'auto',
          o.createdAt = datetime(),
          o.updatedAt = datetime()
        ON MATCH SET
          o.name = coalesce(o.name, $objectText),
          o.updatedAt = datetime()

        MERGE (s)-[r:RELATED_TO {syncKey: $syncKey}]->(o)
        ON CREATE SET
          r.id = $factId,
          r.sourceNodeId = $subjectNodeKey,
          r.targetNodeId = $objectNodeKey,
          r.relationType = $predicate,
          r.description = $predicate,
          r.properties = '{}',
          r.weight = 1.0,
          r.sourceDocumentIds = [],
          r.confidence = $confidence,
          r.createdAt = datetime()
        ON MATCH SET
          r.id = $factId,
          r.sourceNodeId = $subjectNodeKey,
          r.targetNodeId = $objectNodeKey,
          r.relationType = $predicate,
          r.description = $predicate,
          r.confidence = $confidence,
          r.updatedAt = datetime()
      `,
      {
        factId: fact.id,
        syncKey,
        subjectNodeKey,
        subjectText,
        predicate,
        objectNodeKey,
        objectText,
        confidence
      }
    );
  }

  private async wait(ms: number): Promise<void> {
    if (!this.running || ms <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.waitResolver = () => {
        this.waitResolver = null;
        this.waitTimer = null;
        resolve();
      };
      this.waitTimer = setTimeout(() => {
        const done = this.waitResolver;
        this.waitResolver = null;
        this.waitTimer = null;
        if (done) {
          done();
        } else {
          resolve();
        }
      }, ms);
    });
  }

  private cancelWait(): void {
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
    const done = this.waitResolver;
    this.waitResolver = null;
    if (done) {
      done();
    }
  }
}

async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Ignore rollback failure.
  }
}

function sanitizePositiveInt(input: number | undefined, fallback: number): number {
  if (input === undefined) {
    return fallback;
  }
  const n = Number.parseInt(String(input), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return n;
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

function stringifyError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw.slice(0, 1000);
}
