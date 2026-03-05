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

export interface GraphSyncWorkerStats {
  fetched: number;
  synced: number;
  failed: number;
  maxLagMs: number;
  durationMs: number;
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
    const client = await this.pgPool.connect();

    try {
      await client.query("BEGIN");
      const rows = await this.fetchPendingFacts(client);
      if (rows.length === 0) {
        await client.query("COMMIT");
        return {
          fetched: 0,
          synced: 0,
          failed: 0,
          maxLagMs: 0,
          durationMs: Date.now() - startedAt
        };
      }

      let failed = 0;
      const syncedIds: string[] = [];
      const now = Date.now();
      let maxLagMs = 0;

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
          await client.query(
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
        await client.query(
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

      await client.query("COMMIT");
      const stats: GraphSyncWorkerStats = {
        fetched: rows.length,
        synced: syncedIds.length,
        failed,
        maxLagMs,
        durationMs: Date.now() - startedAt
      };
      logger.info(
        stats,
        "GraphSyncWorker sync batch finished"
      );
      return stats;
    } catch (error) {
      await safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
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
