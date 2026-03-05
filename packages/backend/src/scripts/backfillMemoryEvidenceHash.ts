import type { Pool } from "pg";
import { closePgPoolSingleton, getPgPoolSingleton } from "../runtime/PgPool.js";
import { buildMemoryEvidenceHash } from "../utils/memoryEvidence.js";

interface EvidenceRow {
  id: string;
  fact_id: string;
  source_type: "document" | "chat_user" | "chat_assistant" | "manual";
  document_id: string | null;
  chunk_id: string | null;
  chat_session_id: string | null;
  chat_message_id: string | null;
  excerpt: string | null;
}

export interface BackfillMemoryEvidenceHashResult {
  scannedRows: number;
  updatedRows: number;
  deduplicatedRows: number;
  remainingWithoutHash: number;
}

const UPDATE_CHUNK_SIZE = 500;
const DELETE_CHUNK_SIZE = 1000;

export async function backfillMemoryEvidenceHash(pool: Pool): Promise<BackfillMemoryEvidenceHashResult> {
  await pool.query(`
    ALTER TABLE memory_evidence
      ADD COLUMN IF NOT EXISTS evidence_hash TEXT
  `);

  let deduplicatedRows = 0;

  const initialDedupe = await deleteDuplicateEvidenceByHash(pool);
  deduplicatedRows += initialDedupe;

  const rowsResult = await pool.query<EvidenceRow>(
    `
      SELECT
        id,
        fact_id,
        source_type,
        document_id,
        chunk_id,
        chat_session_id,
        chat_message_id,
        excerpt
      FROM memory_evidence
      WHERE evidence_hash IS NULL
      ORDER BY extracted_at DESC, id DESC
    `
  );
  const rows = rowsResult.rows;

  const seenKeys = new Set<string>();
  const updates: Array<{ id: string; evidenceHash: string }> = [];
  const duplicateIds: string[] = [];

  for (const row of rows) {
    const evidenceHash = buildMemoryEvidenceHash({
      sourceType: row.source_type,
      documentId: row.document_id,
      chunkId: row.chunk_id,
      chatSessionId: row.chat_session_id,
      chatMessageId: row.chat_message_id,
      excerpt: row.excerpt
    });
    const dedupeKey = `${row.fact_id}|${evidenceHash}`;
    if (seenKeys.has(dedupeKey)) {
      duplicateIds.push(row.id);
      continue;
    }
    seenKeys.add(dedupeKey);
    updates.push({ id: row.id, evidenceHash });
  }

  deduplicatedRows += await deleteEvidenceIds(pool, duplicateIds);
  const updatedRows = await applyEvidenceHashUpdates(pool, updates);

  const postUpdateDedupe = await deleteDuplicateEvidenceByHash(pool);
  deduplicatedRows += postUpdateDedupe;

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_fact_hash
      ON memory_evidence(fact_id, evidence_hash)
      WHERE evidence_hash IS NOT NULL
  `);

  const remainingResult = await pool.query<{ count: number }>(
    `
      SELECT COUNT(*)::int AS count
      FROM memory_evidence
      WHERE evidence_hash IS NULL
    `
  );

  return {
    scannedRows: rows.length,
    updatedRows,
    deduplicatedRows,
    remainingWithoutHash: remainingResult.rows[0]?.count ?? 0
  };
}

async function applyEvidenceHashUpdates(
  pool: Pool,
  rows: Array<{ id: string; evidenceHash: string }>
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }

  let updated = 0;
  for (let offset = 0; offset < rows.length; offset += UPDATE_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + UPDATE_CHUNK_SIZE);
    const ids = chunk.map((row) => row.id);
    const hashes = chunk.map((row) => row.evidenceHash);
    const result = await pool.query<{ id: string }>(
      `
        UPDATE memory_evidence ev
        SET evidence_hash = data.evidence_hash
        FROM (
          SELECT
            unnest($1::uuid[]) AS id,
            unnest($2::text[]) AS evidence_hash
        ) AS data
        WHERE ev.id = data.id
        RETURNING ev.id
      `,
      [ids, hashes]
    );
    updated += result.rowCount ?? result.rows.length;
  }
  return updated;
}

async function deleteEvidenceIds(pool: Pool, ids: string[]): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }

  let deleted = 0;
  for (let offset = 0; offset < ids.length; offset += DELETE_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + DELETE_CHUNK_SIZE);
    const result = await pool.query<{ id: string }>(
      `
        DELETE FROM memory_evidence
        WHERE id = ANY($1::uuid[])
        RETURNING id
      `,
      [chunk]
    );
    deleted += result.rowCount ?? result.rows.length;
  }

  return deleted;
}

async function deleteDuplicateEvidenceByHash(pool: Pool): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY fact_id, evidence_hash
            ORDER BY extracted_at DESC, id DESC
          ) AS row_num
        FROM memory_evidence
        WHERE evidence_hash IS NOT NULL
      )
      DELETE FROM memory_evidence ev
      USING ranked
      WHERE ev.id = ranked.id
        AND ranked.row_num > 1
      RETURNING ev.id
    `
  );
  return result.rowCount ?? result.rows.length;
}

async function main(): Promise<void> {
  const pool = getPgPoolSingleton();
  try {
    const result = await backfillMemoryEvidenceHash(pool);
    console.log("Backfill memory_evidence.evidence_hash completed.");
    console.log(
      `scanned=${result.scannedRows}, updated=${result.updatedRows}, deduplicated=${result.deduplicatedRows}, remainingWithoutHash=${result.remainingWithoutHash}`
    );
  } finally {
    await closePgPoolSingleton();
  }
}

if (process.argv[1]?.endsWith("backfillMemoryEvidenceHash.ts")) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Backfill evidence_hash failed: ${message}`);
    process.exitCode = 1;
  });
}

