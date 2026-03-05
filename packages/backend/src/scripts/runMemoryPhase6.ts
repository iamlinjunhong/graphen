import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { appConfig } from "../config.js";
import { closePgPoolSingleton, getPgPoolSingleton } from "../runtime/PgPool.js";
import {
  mapLegacyId,
  migrateToPg,
  type EntryEmbeddingProvider,
  type LegacyMigrationDataset,
  StaticMigrationSource
} from "./migrate-to-pg.js";
import { backfillMemoryEvidenceHash } from "./backfillMemoryEvidenceHash.js";

function buildEmbedding(seed: number): number[] {
  const dimensions = appConfig.EMBEDDING_DIMENSIONS;
  const values = new Array<number>(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    const angle = (seed + index * 17) % 360;
    values[index] = Number((Math.sin(angle) * 0.5 + 0.5).toFixed(6));
  }
  return values;
}

class DeterministicEmbeddingProvider implements EntryEmbeddingProvider {
  async generateEmbedding(text: string): Promise<number[]> {
    return buildEmbedding(text.length);
  }
}

class InvalidEmbeddingProvider implements EntryEmbeddingProvider {
  async generateEmbedding(): Promise<number[]> {
    return [0.42];
  }
}

function buildFixtureDataset(runTag: string): LegacyMigrationDataset {
  const chatId = `legacy-chat-${runTag}`;
  const messageId = `legacy-message-${runTag}`;
  const factId = `legacy-fact-${runTag}`;
  const evidenceId = `legacy-evidence-${runTag}`;
  const documentId = `legacy-doc-${runTag}`;
  const chunkId = `legacy-chunk-${runTag}`;

  return {
    chatSessions: [
      {
        id: chatId,
        title: `Phase6 Chat ${runTag}`,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z"
      }
    ],
    chatMessages: [
      {
        id: messageId,
        session_id: chatId,
        role: "user",
        content: `我是 ${runTag}，负责后端迁移。`,
        sources_json: JSON.stringify([{ kind: "doc", id: documentId }]),
        graph_context_json: JSON.stringify({ nodes: ["n1"], edges: [] }),
        source_paths_json: null,
        inferred_relations_json: null,
        created_at: "2025-01-01T00:01:00.000Z"
      }
    ],
    memoryFacts: [
      {
        id: factId,
        subject_node_id: "node:zhangsan",
        predicate: "职位",
        object_node_id: null,
        object_text: "CTO",
        value_type: "text",
        normalized_key: "node:zhangsan|职位|cto",
        confidence: 0.91,
        review_status: "confirmed",
        review_note: "legacy approved",
        first_seen_at: "2025-01-01T00:00:00.000Z",
        last_seen_at: "2025-01-01T00:02:00.000Z",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:02:00.000Z",
        deleted_at: null
      }
    ],
    memoryEvidence: [
      {
        id: evidenceId,
        fact_id: factId,
        source_type: "document",
        document_id: documentId,
        chunk_id: chunkId,
        chat_session_id: chatId,
        chat_message_id: messageId,
        excerpt: "张三担任公司 CTO",
        extracted_at: "2025-01-01T00:02:00.000Z"
      }
    ],
    documents: [
      {
        id: documentId,
        filename: `phase6-${runTag}.md`,
        fileType: "md",
        fileSize: 1234,
        status: "completed",
        uploadedAt: "2025-01-01T00:00:00.000Z",
        parsedAt: "2025-01-01T00:00:10.000Z",
        metadata: { chunkCount: 1, source: "phase6-script" },
        errorMessage: null
      }
    ],
    chunks: [
      {
        id: chunkId,
        documentId,
        chunkIndex: 0,
        content: "张三是 CTO。",
        embedding: buildEmbedding(7),
        metadata: { startLine: 1, endLine: 1 }
      }
    ]
  };
}

async function countRowsByIds(
  pool: Pool,
  tableName:
    | "chat_sessions"
    | "chat_messages"
    | "memory_entries"
    | "memory_facts"
    | "memory_evidence"
    | "documents"
    | "document_chunks",
  ids: string[]
): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ${tableName} WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  return result.rows[0]?.count ?? 0;
}

async function cleanupMigratedRows(pool: Pool, ids: {
  chatSessionIds: string[];
  chatMessageIds: string[];
  memoryEntryIds: string[];
  memoryFactIds: string[];
  memoryEvidenceIds: string[];
  documentIds: string[];
  chunkIds: string[];
}): Promise<void> {
  if (ids.memoryEvidenceIds.length > 0) {
    await pool.query(`DELETE FROM memory_evidence WHERE id = ANY($1::uuid[])`, [ids.memoryEvidenceIds]);
  }
  if (ids.memoryFactIds.length > 0) {
    await pool.query(`DELETE FROM memory_facts WHERE id = ANY($1::uuid[])`, [ids.memoryFactIds]);
  }
  if (ids.memoryEntryIds.length > 0) {
    await pool.query(`DELETE FROM memory_entries WHERE id = ANY($1::uuid[])`, [ids.memoryEntryIds]);
  }
  if (ids.chunkIds.length > 0) {
    await pool.query(`DELETE FROM document_chunks WHERE id = ANY($1::uuid[])`, [ids.chunkIds]);
  }
  if (ids.documentIds.length > 0) {
    await pool.query(`DELETE FROM documents WHERE id = ANY($1::uuid[])`, [ids.documentIds]);
  }
  if (ids.chatMessageIds.length > 0) {
    await pool.query(`DELETE FROM chat_messages WHERE id = ANY($1::uuid[])`, [ids.chatMessageIds]);
  }
  if (ids.chatSessionIds.length > 0) {
    await pool.query(`DELETE FROM chat_sessions WHERE id = ANY($1::uuid[])`, [ids.chatSessionIds]);
  }
}

async function main(): Promise<void> {
  const runTag = randomUUID().slice(0, 8);
  const rollbackTag = randomUUID().slice(0, 8);
  const pool = getPgPoolSingleton();
  let committedIds: {
    chatSessionIds: string[];
    chatMessageIds: string[];
    memoryEntryIds: string[];
    memoryFactIds: string[];
    memoryEvidenceIds: string[];
    documentIds: string[];
    chunkIds: string[];
  } | null = null;

  try {
    const dataset = buildFixtureDataset(runTag);
    const result = await migrateToPg({
      source: new StaticMigrationSource(dataset),
      embeddingProvider: new DeterministicEmbeddingProvider(),
      generateEmbeddings: true
    });

    committedIds = result.ids;
    if (!result.committed) {
      throw new Error("Phase6 fixture migration should be committed");
    }

    if (
      result.migratedCounts.chatSessions !== 1
      || result.migratedCounts.chatMessages !== 1
      || result.migratedCounts.memoryEntries !== 1
      || result.migratedCounts.memoryFacts !== 1
      || result.migratedCounts.memoryEvidence !== 1
      || result.migratedCounts.documents !== 1
      || result.migratedCounts.chunks !== 1
    ) {
      throw new Error(`unexpected migrated counts: ${JSON.stringify(result.migratedCounts)}`);
    }
    if (result.migratedCounts.generatedEmbeddings < 1) {
      throw new Error("expected at least one generated memory entry embedding");
    }

    const embeddedEntryCount = await pool.query<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM memory_entries
        WHERE id = ANY($1::uuid[])
          AND embedding IS NOT NULL
      `,
      [result.ids.memoryEntryIds]
    );
    if ((embeddedEntryCount.rows[0]?.count ?? 0) !== result.ids.memoryEntryIds.length) {
      throw new Error("entry embedding backfill validation failed");
    }

    // T6.5 evidence_hash backfill + dedupe validation
    const migratedEvidenceId = result.ids.memoryEvidenceIds[0];
    const migratedFactId = result.ids.memoryFactIds[0];
    const migratedEntryId = result.ids.memoryEntryIds[0];
    if (!migratedEvidenceId || !migratedFactId || !migratedEntryId) {
      throw new Error("T6.5 failed: missing migrated ids for evidence backfill validation");
    }

    const baseEvidence = await pool.query<{
      source_type: "document" | "chat_user" | "chat_assistant" | "manual";
      document_id: string | null;
      chunk_id: string | null;
      chat_session_id: string | null;
      chat_message_id: string | null;
      excerpt: string | null;
      extracted_at: string;
    }>(
      `
        SELECT
          source_type,
          document_id,
          chunk_id,
          chat_session_id,
          chat_message_id,
          excerpt,
          extracted_at
        FROM memory_evidence
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [migratedEvidenceId]
    );
    const baseRow = baseEvidence.rows[0];
    if (!baseRow) {
      throw new Error("T6.5 failed: missing migrated evidence row");
    }

    const duplicateEvidenceId = mapLegacyId("memory-evidence", `legacy-evidence-duplicate-${runTag}`);
    result.ids.memoryEvidenceIds.push(duplicateEvidenceId);
    await pool.query(
      `
        UPDATE memory_evidence
        SET evidence_hash = NULL
        WHERE id = $1::uuid
      `,
      [migratedEvidenceId]
    );
    await pool.query(
      `
        INSERT INTO memory_evidence (
          id,
          fact_id,
          entry_id,
          source_type,
          evidence_hash,
          document_id,
          chunk_id,
          chat_session_id,
          chat_message_id,
          excerpt,
          extracted_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4,
          NULL,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10::timestamptz
        )
      `,
      [
        duplicateEvidenceId,
        migratedFactId,
        migratedEntryId,
        baseRow.source_type,
        baseRow.document_id,
        baseRow.chunk_id,
        baseRow.chat_session_id,
        baseRow.chat_message_id,
        baseRow.excerpt,
        baseRow.extracted_at
      ]
    );

    const backfillResult = await backfillMemoryEvidenceHash(pool);
    if (backfillResult.remainingWithoutHash !== 0) {
      throw new Error(`T6.5 failed: remaining evidence_hash null rows=${backfillResult.remainingWithoutHash}`);
    }
    if (backfillResult.updatedRows < 1) {
      throw new Error(`T6.5 failed: expected updatedRows >= 1, got ${backfillResult.updatedRows}`);
    }
    if (backfillResult.deduplicatedRows < 1) {
      throw new Error(`T6.5 failed: expected deduplicatedRows >= 1, got ${backfillResult.deduplicatedRows}`);
    }

    const evidenceCountAfterBackfill = await pool.query<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM memory_evidence
        WHERE fact_id = $1::uuid
      `,
      [migratedFactId]
    );
    if ((evidenceCountAfterBackfill.rows[0]?.count ?? 0) !== 1) {
      throw new Error("T6.5 failed: duplicate evidence rows were not collapsed to a single row");
    }

    // T6.4 rollback test: use invalid embedding provider to force transaction failure.
    const rollbackDataset = buildFixtureDataset(`rollback-${rollbackTag}`);
    let rollbackFailedAsExpected = false;
    try {
      await migrateToPg({
        source: new StaticMigrationSource(rollbackDataset),
        embeddingProvider: new InvalidEmbeddingProvider(),
        generateEmbeddings: true
      });
    } catch {
      rollbackFailedAsExpected = true;
    }
    if (!rollbackFailedAsExpected) {
      throw new Error("rollback test expected migration failure but succeeded");
    }

    const rollbackSessionId = mapLegacyId(
      "chat-session",
      `legacy-chat-rollback-${rollbackTag}`
    );
    const rollbackFactId = mapLegacyId(
      "memory-fact",
      `legacy-fact-rollback-${rollbackTag}`
    );
    const rollbackChunkId = mapLegacyId(
      "chunk",
      `legacy-chunk-rollback-${rollbackTag}`
    );

    const rollbackSessionCount = await countRowsByIds(pool, "chat_sessions", [rollbackSessionId]);
    const rollbackFactCount = await countRowsByIds(pool, "memory_facts", [rollbackFactId]);
    const rollbackChunkCount = await countRowsByIds(pool, "document_chunks", [rollbackChunkId]);
    if (rollbackSessionCount !== 0 || rollbackFactCount !== 0 || rollbackChunkCount !== 0) {
      throw new Error("rollback validation failed: partial rows leaked after rollback");
    }

    console.log("Phase 6 completed successfully.");
    console.log("T6.1 migrate-to-pg.ts migrates chat/memory/neo4j data to PG: ok");
    console.log("T6.2 memory_entries embedding backfill: ok");
    console.log("T6.3 migration count + relation integrity verification: ok");
    console.log("T6.4 migration rollback test: ok");
    console.log("T6.5 memory_evidence evidence_hash backfill + dedupe: ok");
  } finally {
    if (committedIds) {
      await cleanupMigratedRows(pool, committedIds);
    }
    await closePgPoolSingleton();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Phase 6 failed: ${message}`);
  process.exitCode = 1;
});
