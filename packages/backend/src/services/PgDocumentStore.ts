import type { ChunkSearchResult, Document, DocumentChunk, DocumentStatus } from "@graphen/shared";
import type { Pool } from "pg";
import { appConfig } from "../config.js";
import { getPgPoolSingleton } from "../runtime/PgPool.js";

interface DocumentRow {
  id: string;
  filename: string;
  file_type: Document["fileType"];
  file_size: number;
  status: DocumentStatus;
  uploaded_at: string;
  parsed_at: string | null;
  metadata: unknown;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface DocumentChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  embedding: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
  similarity?: number;
}

export interface PgDocumentStoreLike {
  saveDocument(doc: Document): Promise<void>;
  getDocuments(): Promise<Document[]>;
  getDocumentById(id: string): Promise<Document | null>;
  deleteDocumentAndRelated(docId: string): Promise<void>;
  saveChunks(chunks: DocumentChunk[]): Promise<void>;
  getChunksByDocument(docId: string): Promise<DocumentChunk[]>;
  chunkVectorSearch(vector: number[], k: number): Promise<ChunkSearchResult[]>;
}

export interface PgDocumentStoreOptions {
  pool?: Pool;
  vectorEfSearch?: number;
}

export class PgDocumentStore implements PgDocumentStoreLike {
  private readonly pool: Pool;
  private readonly vectorEfSearch: number;
  private schemaReady: Promise<void> | null = null;

  constructor(options: PgDocumentStoreOptions = {}) {
    this.pool = options.pool ?? getPgPoolSingleton();
    this.vectorEfSearch = sanitizeInt(
      options.vectorEfSearch ?? appConfig.PG_VECTOR_EF_SEARCH,
      8,
      1000
    );
  }

  async saveDocument(doc: Document): Promise<void> {
    await this.ensureSchema();

    const metadata = doc.metadata ?? {};
    const parsedAt = doc.parsedAt ? doc.parsedAt.toISOString() : null;
    const errorMessage = doc.errorMessage ?? null;

    await this.pool.query(
      `
        INSERT INTO documents (
          id,
          filename,
          file_type,
          file_size,
          status,
          uploaded_at,
          parsed_at,
          metadata,
          error_message,
          updated_at
        )
        VALUES (
          $1::uuid,
          $2,
          $3,
          $4,
          $5,
          $6::timestamptz,
          $7::timestamptz,
          $8::jsonb,
          $9,
          NOW()
        )
        ON CONFLICT (id)
        DO UPDATE SET
          filename = EXCLUDED.filename,
          file_type = EXCLUDED.file_type,
          file_size = EXCLUDED.file_size,
          status = EXCLUDED.status,
          uploaded_at = EXCLUDED.uploaded_at,
          parsed_at = EXCLUDED.parsed_at,
          metadata = EXCLUDED.metadata,
          error_message = EXCLUDED.error_message,
          updated_at = NOW()
      `,
      [
        doc.id,
        doc.filename,
        doc.fileType,
        doc.fileSize,
        doc.status,
        doc.uploadedAt.toISOString(),
        parsedAt,
        JSON.stringify(metadata),
        errorMessage
      ]
    );
  }

  async getDocuments(): Promise<Document[]> {
    await this.ensureSchema();

    const result = await this.pool.query<DocumentRow>(
      `
        SELECT
          id,
          filename,
          file_type,
          file_size,
          status,
          uploaded_at,
          parsed_at,
          metadata,
          error_message,
          created_at,
          updated_at
        FROM documents
        ORDER BY created_at DESC
      `
    );

    return result.rows.map((row) => mapDocumentRow(row));
  }

  async getDocumentById(id: string): Promise<Document | null> {
    await this.ensureSchema();

    const result = await this.pool.query<DocumentRow>(
      `
        SELECT
          id,
          filename,
          file_type,
          file_size,
          status,
          uploaded_at,
          parsed_at,
          metadata,
          error_message,
          created_at,
          updated_at
        FROM documents
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [id]
    );

    const row = result.rows[0];
    return row ? mapDocumentRow(row) : null;
  }

  async deleteDocumentAndRelated(docId: string): Promise<void> {
    await this.ensureSchema();

    // 清理由该文档产生的 memory entries / facts / evidence
    // 精细清理：只删除该文档独占的数据，保留其他来源共享的数据
    try {
      // 1. 找出该文档关联的所有 entry ids
      const evidenceResult = await this.pool.query<{ entry_id: string }>(
        `SELECT DISTINCT entry_id FROM memory_evidence WHERE document_id = $1`,
        [docId]
      );
      const entryIds = evidenceResult.rows.map((r) => r.entry_id);

      if (entryIds.length > 0) {
        // 2. 删除该文档的 evidence 记录
        await this.pool.query(
          `DELETE FROM memory_evidence WHERE document_id = $1`,
          [docId]
        );

        // 3. 软删除不再有任何 evidence 的 facts
        await this.pool.query(
          `
            UPDATE memory_facts
            SET fact_state = 'deleted',
                deleted_at = NOW(),
                neo4j_synced = FALSE,
                updated_at = NOW()
            WHERE entry_id = ANY($1::uuid[])
              AND deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM memory_evidence ev
                WHERE ev.fact_id = memory_facts.id
              )
          `,
          [entryIds]
        );

        // 4. 删除不再有任何 active facts 的 entries
        await this.pool.query(
          `
            DELETE FROM memory_entries
            WHERE id = ANY($1::uuid[])
              AND NOT EXISTS (
                SELECT 1 FROM memory_facts f
                WHERE f.entry_id = memory_entries.id
                  AND f.deleted_at IS NULL
                  AND f.fact_state = 'active'
              )
          `,
          [entryIds]
        );
      }
    } catch (error) {
      // memory 表可能尚未创建（如未启用 memory 功能），忽略
      const pgErr = error as { code?: string };
      if (pgErr.code !== "42P01") {
        throw error;
      }
    }

    // 删除文档本身（document_chunks 通过 ON DELETE CASCADE 自动清理）
    await this.pool.query(
      `
        DELETE FROM documents
        WHERE id = $1::uuid
      `,
      [docId]
    );
  }

  async saveChunks(chunks: DocumentChunk[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }
    await this.ensureSchema();

    // 收集涉及的 document_id，先删除旧 chunks 再插入，避免 reparse 时唯一约束冲突
    const documentIds = [...new Set(chunks.map((c) => c.documentId))];

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      if (documentIds.length > 0) {
        await client.query(
          `DELETE FROM document_chunks WHERE document_id = ANY($1::uuid[])`,
          [documentIds]
        );
      }

      for (const chunk of chunks) {
        await client.query(
          `
            INSERT INTO document_chunks (
              id,
              document_id,
              chunk_index,
              content,
              embedding,
              metadata,
              updated_at
            )
            VALUES (
              $1::uuid,
              $2::uuid,
              $3,
              $4,
              $5::vector,
              $6::jsonb,
              NOW()
            )
            ON CONFLICT (id)
            DO UPDATE SET
              document_id = EXCLUDED.document_id,
              chunk_index = EXCLUDED.chunk_index,
              content = EXCLUDED.content,
              embedding = EXCLUDED.embedding,
              metadata = EXCLUDED.metadata,
              updated_at = NOW()
          `,
          [
            chunk.id,
            chunk.documentId,
            chunk.index,
            chunk.content,
            chunk.embedding && chunk.embedding.length > 0 ? toVectorLiteral(chunk.embedding) : null,
            JSON.stringify(chunk.metadata ?? {})
          ]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getChunksByDocument(docId: string): Promise<DocumentChunk[]> {
    await this.ensureSchema();

    const result = await this.pool.query<DocumentChunkRow>(
      `
        SELECT
          id,
          document_id,
          chunk_index,
          content,
          embedding,
          metadata,
          created_at,
          updated_at
        FROM document_chunks
        WHERE document_id = $1::uuid
        ORDER BY chunk_index ASC
      `,
      [docId]
    );

    return result.rows.map((row) => mapChunkRow(row));
  }

  async chunkVectorSearch(vector: number[], k: number): Promise<ChunkSearchResult[]> {
    if (vector.length === 0) {
      return [];
    }

    await this.ensureSchema();

    const safeLimit = Math.max(1, Math.min(100, Math.floor(k)));
    const vectorLiteral = toVectorLiteral(vector);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL hnsw.ef_search = ${this.vectorEfSearch}`);

      const result = await client.query<DocumentChunkRow>(
        `
          SELECT
            id,
            document_id,
            chunk_index,
            content,
            embedding,
            metadata,
            created_at,
            updated_at,
            1 - (embedding <=> $1::vector) AS similarity
          FROM document_chunks
          WHERE embedding IS NOT NULL
          ORDER BY embedding <=> $1::vector
          LIMIT $2
        `,
        [vectorLiteral, safeLimit]
      );

      await client.query("COMMIT");
      return result.rows.map((row) => ({
        chunk: mapChunkRow(row),
        score: row.similarity ?? 0
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.initializeSchema();
    }
    return this.schemaReady;
  }

  private async initializeSchema(): Promise<void> {
    await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        filename      TEXT NOT NULL,
        file_type     TEXT NOT NULL CHECK (file_type IN ('pdf', 'md', 'txt')),
        file_size     BIGINT NOT NULL DEFAULT 0,
        status        TEXT NOT NULL CHECK (status IN ('uploading','parsing','extracting','embedding','completed','error')),
        uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        parsed_at     TIMESTAMPTZ,
        metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
        error_message TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS document_chunks (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        chunk_index   INTEGER NOT NULL,
        content       TEXT NOT NULL,
        embedding     vector(1024),
        metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chunk_document_index
      ON document_chunks(document_id, chunk_index);
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_created_at
      ON documents(created_at DESC);
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_chunk_document
      ON document_chunks(document_id, chunk_index);
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_chunk_embedding
      ON document_chunks USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 200);
    `);
  }
}

function mapDocumentRow(row: DocumentRow): Document {
  const metadata = normalizeDocumentMetadata(row.metadata);
  const document: Document = {
    id: row.id,
    filename: row.filename,
    fileType: row.file_type,
    fileSize: Number(row.file_size),
    status: row.status,
    uploadedAt: new Date(row.uploaded_at),
    metadata
  };

  if (row.parsed_at) {
    document.parsedAt = new Date(row.parsed_at);
  }
  if (row.error_message) {
    document.errorMessage = row.error_message;
  }
  return document;
}

function mapChunkRow(row: DocumentChunkRow): DocumentChunk {
  const chunk: DocumentChunk = {
    id: row.id,
    documentId: row.document_id,
    content: row.content,
    index: row.chunk_index,
    metadata: normalizeChunkMetadata(row.metadata)
  };

  const embedding = parseVector(row.embedding);
  if (embedding && embedding.length > 0) {
    chunk.embedding = embedding;
  }
  return chunk;
}

function parseVector(value: string | null): number[] | null {
  if (!value) {
    return null;
  }
  const raw = value.trim();
  if (!raw.startsWith("[") || !raw.endsWith("]")) {
    return null;
  }
  const body = raw.slice(1, -1).trim();
  if (body.length === 0) {
    return [];
  }
  return body
    .split(",")
    .map((part) => Number.parseFloat(part.trim()))
    .filter((num) => Number.isFinite(num));
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => Number(value).toString()).join(",")}]`;
}

function sanitizeInt(value: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return min;
  }
  return Math.min(max, Math.max(min, parsed));
}

function normalizeDocumentMetadata(value: unknown): {
  pageCount?: number;
  wordCount?: number;
  chunkCount?: number;
  entityCount?: number;
  edgeCount?: number;
} {
  if (!value || typeof value !== "object") {
    return {};
  }
  const row = value as Record<string, unknown>;
  const metadata: {
    pageCount?: number;
    wordCount?: number;
    chunkCount?: number;
    entityCount?: number;
    edgeCount?: number;
  } = {};

  const pageCount = toNumber(row.pageCount);
  if (pageCount !== null) metadata.pageCount = pageCount;
  const wordCount = toNumber(row.wordCount);
  if (wordCount !== null) metadata.wordCount = wordCount;
  const chunkCount = toNumber(row.chunkCount);
  if (chunkCount !== null) metadata.chunkCount = chunkCount;
  const entityCount = toNumber(row.entityCount);
  if (entityCount !== null) metadata.entityCount = entityCount;
  const edgeCount = toNumber(row.edgeCount);
  if (edgeCount !== null) metadata.edgeCount = edgeCount;

  return metadata;
}

function normalizeChunkMetadata(value: unknown): {
  pageNumber?: number;
  startLine?: number;
  endLine?: number;
} {
  if (!value || typeof value !== "object") {
    return {};
  }

  const row = value as Record<string, unknown>;
  const metadata: {
    pageNumber?: number;
    startLine?: number;
    endLine?: number;
  } = {};

  const pageNumber = toNumber(row.pageNumber);
  if (pageNumber !== null) metadata.pageNumber = pageNumber;
  const startLine = toNumber(row.startLine);
  if (startLine !== null) metadata.startLine = startLine;
  const endLine = toNumber(row.endLine);
  if (endLine !== null) metadata.endLine = endLine;

  return metadata;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}
