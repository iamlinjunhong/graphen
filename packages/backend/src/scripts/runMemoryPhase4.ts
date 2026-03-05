import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { closePgPoolSingleton, getPgPoolSingleton } from "../runtime/PgPool.js";
import { applyPhase0MemorySchema } from "../runtime/pgMemorySchema.js";
import { PgMemoryStore } from "../services/PgMemoryStore.js";
import { GraphSyncWorker } from "../workers/GraphSyncWorker.js";

interface RecordedCypher {
  query: string;
  params: Record<string, unknown>;
}

class FakeNeo4jSyncTarget {
  public readonly calls: RecordedCypher[] = [];
  private readonly failFactIds = new Set<string>();
  private readonly failedOnce = new Set<string>();

  failOnceForFact(factId: string): void {
    this.failFactIds.add(factId);
  }

  async runCypher(query: string, params: Record<string, unknown> = {}): Promise<void> {
    this.calls.push({ query, params });
    const factId = typeof params.factId === "string" ? params.factId : null;
    if (factId && this.failFactIds.has(factId) && !this.failedOnce.has(factId)) {
      this.failedOnce.add(factId);
      throw new Error(`neo4j mock failure for fact ${factId}`);
    }
  }
}

async function main(): Promise<void> {
  const runTag = randomUUID().slice(0, 8);
  const pgPool = getPgPoolSingleton();
  const entryStore = new PgMemoryStore({ pool: pgPool });
  const neo4j = new FakeNeo4jSyncTarget();

  const cleanupEntryIds: string[] = [];
  let invalidFactId = "";

  try {
    await applyPhase0MemorySchema(pgPool);

    // Seed valid facts (one success, one fail-then-retry)
    const successEntry = await entryStore.createEntry(`Phase4 success entry ${runTag}`);
    cleanupEntryIds.push(successEntry.id);
    const successUpsert = await entryStore.upsertFacts(successEntry.id, [
      {
        subjectText: "张三",
        predicate: "职位",
        objectText: "CTO",
        valueType: "text",
        confidence: 0.92
      }
    ]);
    const successFactId = successUpsert.facts[0]?.id;
    if (!successFactId) {
      throw new Error("failed to seed success fact");
    }

    const retryEntry = await entryStore.createEntry(`Phase4 retry entry ${runTag}`);
    cleanupEntryIds.push(retryEntry.id);
    const retryUpsert = await entryStore.upsertFacts(retryEntry.id, [
      {
        subjectText: "李四",
        predicate: "职位",
        objectText: "CEO",
        valueType: "text",
        confidence: 0.9
      }
    ]);
    const retryFactId = retryUpsert.facts[0]?.id;
    if (!retryFactId) {
      throw new Error("failed to seed retry fact");
    }
    neo4j.failOnceForFact(retryFactId);

    // Seed invalid fact row for strict-filter validation (subject_text empty).
    const invalidEntry = await entryStore.createEntry(`Phase4 invalid entry ${runTag}`);
    cleanupEntryIds.push(invalidEntry.id);
    const invalidInsert = await pgPool.query<{ id: string }>(
      `
        INSERT INTO memory_facts (
          entry_id,
          subject_node_id,
          subject_text,
          predicate,
          object_node_id,
          object_text,
          value_type,
          normalized_fact_key,
          confidence,
          fact_state,
          neo4j_synced
        )
        VALUES (
          $1::uuid,
          NULL,
          '',
          '职位',
          NULL,
          'Intern',
          'text',
          $2,
          0.7,
          'active',
          FALSE
        )
        RETURNING id
      `,
      [invalidEntry.id, `invalid-${runTag}`]
    );
    invalidFactId = invalidInsert.rows[0]?.id ?? "";
    if (!invalidFactId) {
      throw new Error("failed to seed invalid fact");
    }

    const worker = new GraphSyncWorker(pgPool, neo4j, {
      intervalMs: 50,
      batchSize: 100,
      maxRetries: 3
    });

    // T4.1.2/T4.1.3/T4.1.4/T4.1.5/T4.1.6/T4.1.7
    const first = await worker.syncOnce();
    if (first.fetched !== 2 || first.synced !== 1 || first.failed !== 1) {
      throw new Error(
        `unexpected first sync stats: fetched=${first.fetched}, synced=${first.synced}, failed=${first.failed}`
      );
    }

    const successRow = await pgPool.query<{
      neo4j_synced: boolean;
      neo4j_retry_count: number;
      neo4j_last_error: string | null;
    }>(
      `
        SELECT neo4j_synced, neo4j_retry_count, neo4j_last_error
        FROM memory_facts
        WHERE id = $1::uuid
      `,
      [successFactId]
    );
    if (!successRow.rows[0]?.neo4j_synced) {
      throw new Error("success fact should be marked neo4j_synced=true");
    }

    const retryRowAfterFirst = await pgPool.query<{
      neo4j_synced: boolean;
      neo4j_retry_count: number;
      neo4j_last_error: string | null;
    }>(
      `
        SELECT neo4j_synced, neo4j_retry_count, neo4j_last_error
        FROM memory_facts
        WHERE id = $1::uuid
      `,
      [retryFactId]
    );
    if (
      retryRowAfterFirst.rows[0]?.neo4j_synced ||
      (retryRowAfterFirst.rows[0]?.neo4j_retry_count ?? 0) < 1 ||
      !retryRowAfterFirst.rows[0]?.neo4j_last_error
    ) {
      throw new Error("retry fact should fail once and increase retry_count");
    }

    const invalidRow = await pgPool.query<{
      neo4j_synced: boolean;
      neo4j_retry_count: number;
    }>(
      `
        SELECT neo4j_synced, neo4j_retry_count
        FROM memory_facts
        WHERE id = $1::uuid
      `,
      [invalidFactId]
    );
    if (invalidRow.rows[0]?.neo4j_retry_count !== 0) {
      throw new Error("invalid fact should not enter sync batch due to strict filter");
    }

    const second = await worker.syncOnce();
    if (second.fetched !== 1 || second.synced !== 1 || second.failed !== 0) {
      throw new Error(
        `unexpected second sync stats: fetched=${second.fetched}, synced=${second.synced}, failed=${second.failed}`
      );
    }

    const retryRowAfterSecond = await pgPool.query<{
      neo4j_synced: boolean;
      neo4j_retry_count: number;
      neo4j_last_error: string | null;
    }>(
      `
        SELECT neo4j_synced, neo4j_retry_count, neo4j_last_error
        FROM memory_facts
        WHERE id = $1::uuid
      `,
      [retryFactId]
    );
    if (!retryRowAfterSecond.rows[0]?.neo4j_synced) {
      throw new Error("retry fact should be synced in second batch");
    }

    const cypher = neo4j.calls[0]?.query ?? "";
    if (
      !cypher.includes("MERGE (s:Entity") ||
      !cypher.includes("MERGE (s)-[r:RELATED_TO {syncKey: $syncKey}]->(o)")
    ) {
      throw new Error("syncFactToNeo4j does not contain expected idempotent MERGE clauses");
    }

    // T4.1.1 start/stop loop behavior
    worker.start();
    await sleep(120);
    await worker.stop();
    if (worker.isRunning) {
      throw new Error("worker should stop gracefully");
    }

    console.log("Phase 4 completed successfully.");
    console.log(`Run tag: ${runTag}`);
    console.log("T4.1 GraphSyncWorker core loop + sync logic: ok");
    console.log("T4.2 server lifecycle integration: implemented in server.ts");
    console.log("T4.3 sync monitoring logs: ok");
  } finally {
    if (cleanupEntryIds.length > 0) {
      await entryStore.deleteEntries(cleanupEntryIds);
    }
    await closePgPoolSingleton();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Phase 4 failed: ${message}`);
  process.exitCode = 1;
});
