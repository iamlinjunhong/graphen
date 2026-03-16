import type {
  FactReviewStatus,
  FactValueType,
  MemoryEntry,
  MemoryEntryCreateMetadata,
  MemoryEntryFact,
  MemoryEntrySearchQuery,
  MemoryEntryState,
  MemoryEntryStoreLike,
  MemoryEntryUpdateMetadata,
  MemoryEntryUpsertFactInput,
  PaginatedEntries,
  UpsertEntryFactsResult
} from "@graphen/shared";
import type { Pool } from "pg";
import { appConfig } from "../config.js";
import { getPgPoolSingleton } from "../runtime/PgPool.js";

interface EntryRow {
  id: string;
  content: string;
  embedding: string | null;
  normalized_content_key: string;
  state: MemoryEntryState;
  review_status: FactReviewStatus;
  review_note: string | null;
  categories: string[] | null;
  source_type: MemoryEntry["sourceType"];
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  similarity?: number;
  recency_rank?: number;
}

interface FactRow {
  id: string;
  entry_id: string;
  subject_node_id: string | null;
  subject_text: string;
  predicate: string;
  object_node_id: string | null;
  object_text: string | null;
  value_type: FactValueType;
  normalized_fact_key: string;
  confidence: number;
  fact_state: "active" | "deleted";
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  neo4j_synced: boolean;
  neo4j_synced_at: string | null;
  neo4j_retry_count: number;
  neo4j_last_error: string | null;
  inserted?: boolean | string;
}

export interface PgMemoryStoreOptions {
  pool?: Pool;
  vectorEfSearch?: number;
}

export class PgMemoryStore implements MemoryEntryStoreLike {
  private readonly pool: Pool;
  private readonly vectorEfSearch: number;

  constructor(options: PgMemoryStoreOptions = {}) {
    this.pool = options.pool ?? getPgPoolSingleton();
    this.vectorEfSearch = sanitizeInt(
      options.vectorEfSearch ?? appConfig.PG_VECTOR_EF_SEARCH,
      8,
      1000
    );
  }

  async createEntry(
    content: string,
    embedding: number[] | null = null,
    metadata: MemoryEntryCreateMetadata = {}
  ): Promise<MemoryEntry> {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new Error("content must not be empty");
    }

    const now = new Date().toISOString();
    const normalizedContentKey = normalizeForKey(trimmed);
    const vectorLiteral = embedding ? toVectorLiteral(embedding) : null;

    const result = await this.pool.query<EntryRow>(
      `
        INSERT INTO memory_entries (
          content,
          embedding,
          normalized_content_key,
          state,
          review_status,
          review_note,
          categories,
          source_type,
          first_seen_at,
          last_seen_at,
          updated_at
        )
        VALUES (
          $1,
          $2::vector,
          $3,
          $4,
          $5,
          $6,
          $7::text[],
          $8,
          $9::timestamptz,
          $10::timestamptz,
          NOW()
        )
        ON CONFLICT (normalized_content_key) WHERE deleted_at IS NULL
        DO UPDATE SET
          content = EXCLUDED.content,
          embedding = COALESCE(EXCLUDED.embedding, memory_entries.embedding),
          state = EXCLUDED.state,
          review_status = EXCLUDED.review_status,
          review_note = EXCLUDED.review_note,
          categories = EXCLUDED.categories,
          source_type = EXCLUDED.source_type,
          last_seen_at = GREATEST(memory_entries.last_seen_at, EXCLUDED.last_seen_at),
          updated_at = NOW()
        RETURNING
          id,
          content,
          embedding,
          normalized_content_key,
          state,
          review_status,
          review_note,
          categories,
          source_type,
          first_seen_at,
          last_seen_at,
          created_at,
          updated_at,
          deleted_at
      `,
      [
        trimmed,
        vectorLiteral,
        normalizedContentKey,
        metadata.state ?? "active",
        metadata.reviewStatus ?? "auto",
        metadata.reviewNote ?? null,
        metadata.categories ?? [],
        metadata.sourceType ?? "manual",
        metadata.firstSeenAt ?? now,
        metadata.lastSeenAt ?? now
      ]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("failed to create memory entry");
    }
    return mapEntryRow(row);
  }

  async updateEntry(
    id: string,
    content: string,
    embedding: number[] | null = null,
    metadata: MemoryEntryUpdateMetadata = {}
  ): Promise<MemoryEntry | null> {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new Error("content must not be empty");
    }

    const params: unknown[] = [id, trimmed, normalizeForKey(trimmed)];
    const setClauses: string[] = [
      "content = $2",
      "normalized_content_key = $3",
      "updated_at = NOW()",
      "last_seen_at = NOW()"
    ];
    let idx = 4;

    if (embedding !== undefined || metadata.embedding !== undefined) {
      const vector = metadata.embedding === undefined ? embedding : metadata.embedding;
      params.push(vector ? toVectorLiteral(vector) : null);
      setClauses.push(`embedding = $${idx}::vector`);
      idx += 1;
    }
    if (metadata.categories !== undefined) {
      params.push(metadata.categories);
      setClauses.push(`categories = $${idx}::text[]`);
      idx += 1;
    }
    if (metadata.sourceType !== undefined) {
      params.push(metadata.sourceType);
      setClauses.push(`source_type = $${idx}`);
      idx += 1;
    }
    if (metadata.state !== undefined) {
      params.push(metadata.state);
      setClauses.push(`state = $${idx}`);
      idx += 1;
    }
    if (metadata.reviewStatus !== undefined) {
      params.push(metadata.reviewStatus);
      setClauses.push(`review_status = $${idx}`);
      idx += 1;
    }
    if (metadata.reviewNote !== undefined) {
      params.push(metadata.reviewNote);
      setClauses.push(`review_note = $${idx}`);
      idx += 1;
    }
    if (metadata.lastSeenAt !== undefined) {
      params.push(metadata.lastSeenAt);
      setClauses.push(`last_seen_at = $${idx}::timestamptz`);
      idx += 1;
    }

    const result = await this.pool.query<EntryRow>(
      `
        UPDATE memory_entries
        SET ${setClauses.join(", ")}
        WHERE id = $1
          AND deleted_at IS NULL
        RETURNING
          id,
          content,
          embedding,
          normalized_content_key,
          state,
          review_status,
          review_note,
          categories,
          source_type,
          first_seen_at,
          last_seen_at,
          created_at,
          updated_at,
          deleted_at
      `,
      params
    );

    const row = result.rows[0];
    return row ? mapEntryRow(row) : null;
  }

  async getEntry(id: string): Promise<MemoryEntry | null> {
    const result = await this.pool.query<EntryRow>(
      `
        SELECT
          id,
          content,
          embedding,
          normalized_content_key,
          state,
          review_status,
          review_note,
          categories,
          source_type,
          first_seen_at,
          last_seen_at,
          created_at,
          updated_at,
          deleted_at
        FROM memory_entries
        WHERE id = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [id]
    );
    const row = result.rows[0];
    return row ? mapEntryRow(row) : null;
  }

  async upsertFacts(entryId: string, facts: MemoryEntryUpsertFactInput[]): Promise<UpsertEntryFactsResult> {
    if (facts.length === 0) {
      return { created: 0, updated: 0, facts: [] };
    }

    const client = await this.pool.connect();
    let created = 0;
    let updated = 0;
    const upsertedFacts: MemoryEntryFact[] = [];

    try {
      await client.query("BEGIN");

      for (const fact of facts) {
        const predicate = fact.predicate.trim();
        if (predicate.length === 0) {
          throw new Error("predicate must not be empty");
        }

        const subjectNodeId = fact.subjectNodeId?.trim();
        const subjectText = (fact.subjectText ?? subjectNodeId ?? "").trim();
        if (subjectText.length === 0) {
          throw new Error("subject_text (or subject_node_id) is required");
        }

        const objectNodeId = fact.objectNodeId?.trim() || null;
        const objectText = fact.objectText?.trim() || null;
        if (!objectNodeId && !objectText) {
          throw new Error("object_node_id or object_text is required");
        }

        const normalizedFactKey = buildNormalizedFactKey({
          ...(subjectNodeId ? { subjectNodeId } : {}),
          subjectText,
          predicate,
          objectNodeId,
          objectText
        });

        const result = await client.query<FactRow>(
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
              fact_state
            )
            VALUES (
              $1::uuid,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9,
              $10
            )
            ON CONFLICT (entry_id, normalized_fact_key) WHERE deleted_at IS NULL
            DO UPDATE SET
              subject_node_id = EXCLUDED.subject_node_id,
              subject_text = EXCLUDED.subject_text,
              predicate = EXCLUDED.predicate,
              object_node_id = EXCLUDED.object_node_id,
              object_text = EXCLUDED.object_text,
              value_type = EXCLUDED.value_type,
              confidence = EXCLUDED.confidence,
              fact_state = EXCLUDED.fact_state,
              neo4j_synced = FALSE,
              neo4j_synced_at = NULL,
              neo4j_retry_count = 0,
              neo4j_last_error = NULL,
              deleted_at = CASE WHEN EXCLUDED.fact_state = 'deleted' THEN NOW() ELSE NULL END,
              updated_at = NOW()
            RETURNING
              id,
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
              created_at,
              updated_at,
              deleted_at,
              neo4j_synced,
              neo4j_synced_at,
              neo4j_retry_count,
              neo4j_last_error,
              (xmax = 0) AS inserted
          `,
          [
            entryId,
            subjectNodeId ?? null,
            subjectText,
            predicate,
            objectNodeId,
            objectText,
            fact.valueType ?? "text",
            normalizedFactKey,
            clampConfidence(fact.confidence ?? 0.5),
            fact.factState ?? "active"
          ]
        );

        const row = result.rows[0];
        if (!row) {
          throw new Error("failed to upsert memory fact");
        }

        const inserted = row.inserted === true || row.inserted === "t";
        if (inserted) {
          created += 1;
        } else {
          updated += 1;
        }
        upsertedFacts.push(mapFactRow(row));
      }

      await client.query("COMMIT");
      return { created, updated, facts: upsertedFacts };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async searchEntries(input: MemoryEntrySearchQuery): Promise<PaginatedEntries> {
    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.max(1, Math.min(200, input.pageSize ?? 20));
    const filters = input.filters ?? {};

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (!filters.includeDeleted) {
      conditions.push("deleted_at IS NULL");
    }
    if (filters.states && filters.states.length > 0) {
      params.push(filters.states);
      conditions.push(`state = ANY($${params.length}::text[])`);
    }
    if (filters.reviewStatus && filters.reviewStatus.length > 0) {
      params.push(filters.reviewStatus);
      conditions.push(`review_status = ANY($${params.length}::text[])`);
    }
    if (filters.sourceTypes && filters.sourceTypes.length > 0) {
      params.push(filters.sourceTypes);
      conditions.push(`source_type = ANY($${params.length}::text[])`);
    }
    if (filters.categories && filters.categories.length > 0) {
      params.push(filters.categories);
      conditions.push(`categories && $${params.length}::text[]`);
    }

    const keyword = input.query?.trim();
    if (keyword && keyword.length > 0) {
      params.push(keyword);
      const p = params.length;
      conditions.push(
        `(to_tsvector('simple', content) @@ plainto_tsquery('simple', $${p}) OR content ILIKE '%' || $${p} || '%')`
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const countSql = `SELECT COUNT(*)::int AS total FROM memory_entries ${whereClause}`;
    const countResult = await this.pool.query<{ total: number }>(countSql, params);
    const total = countResult.rows[0]?.total ?? 0;

    const sortExpression = mapEntrySortExpression(input.sortBy);
    const sortDirection = input.sortOrder === "asc" ? "ASC" : "DESC";
    const orderByClause =
      input.sortBy === undefined || input.sortBy === "updatedAt"
        ? "recency_rank DESC, updated_at DESC, id ASC"
        : `${sortExpression} ${sortDirection}, recency_rank DESC, updated_at DESC, id ASC`;
    const pageParams = [...params, pageSize, (page - 1) * pageSize];

    const dataSql = `
      SELECT
        id,
        content,
        embedding,
        normalized_content_key,
        state,
        review_status,
        review_note,
        categories,
        source_type,
        first_seen_at,
        last_seen_at,
        created_at,
        updated_at,
        deleted_at,
        (
          CASE source_type
            WHEN 'manual' THEN 1.00
            WHEN 'chat_user' THEN 0.90
            WHEN 'document' THEN 0.75
            WHEN 'chat_assistant' THEN 0.65
            ELSE 0.60
          END
          * exp(-GREATEST(EXTRACT(EPOCH FROM (NOW() - updated_at)), 0) / 2592000.0)
        ) AS recency_rank
      FROM memory_entries
      ${whereClause}
      ORDER BY ${orderByClause}
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;
    const dataResult = await this.pool.query<EntryRow>(dataSql, pageParams);

    return {
      entries: dataResult.rows.map((row) => mapEntryRow(row)),
      total,
      page,
      pageSize
    };
  }

  async searchEntriesByVector(embedding: number[], limit = 10): Promise<MemoryEntry[]> {
    if (embedding.length === 0) {
      return [];
    }

    const vectorLiteral = toVectorLiteral(embedding);
    const safeLimit = Math.max(1, Math.min(100, limit));
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL hnsw.ef_search = ${this.vectorEfSearch}`);

      const result = await client.query<EntryRow>(
        `
          SELECT
            id,
            content,
            embedding,
            normalized_content_key,
            state,
            review_status,
            review_note,
            categories,
            source_type,
            first_seen_at,
            last_seen_at,
            created_at,
            updated_at,
            deleted_at,
            1 - (embedding <=> $1::vector) AS similarity
          FROM memory_entries
          WHERE embedding IS NOT NULL
            AND state = 'active'
            AND review_status NOT IN ('rejected', 'conflicted')
            AND deleted_at IS NULL
          ORDER BY embedding <=> $1::vector
          LIMIT $2
        `,
        [vectorLiteral, safeLimit]
      );

      await client.query("COMMIT");
      return result.rows.map((row) => mapEntryRow(row));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getEntryFacts(entryId: string): Promise<MemoryEntryFact[]> {
    const result = await this.pool.query<FactRow>(
      `
        SELECT
          id,
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
          created_at,
          updated_at,
          deleted_at,
          neo4j_synced,
          neo4j_synced_at,
          neo4j_retry_count,
          neo4j_last_error
        FROM memory_facts
        WHERE entry_id = $1::uuid
          AND deleted_at IS NULL
        ORDER BY confidence DESC, created_at DESC
      `,
      [entryId]
    );
    return result.rows.map((row) => mapFactRow(row));
  }

  async updateEntryState(ids: string[], state: MemoryEntryState, changedBy = "system"): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const result = await this.pool.query<{ affected: number }>(
      `
        WITH target AS (
          SELECT id, state, review_status
          FROM memory_entries
          WHERE id = ANY($1::uuid[])
            AND deleted_at IS NULL
        ),
        updated AS (
          UPDATE memory_entries e
          SET state = $2,
              updated_at = NOW(),
              last_seen_at = NOW(),
              deleted_at = CASE WHEN $2 = 'deleted' THEN COALESCE(e.deleted_at, NOW()) ELSE NULL END
          FROM target t
          WHERE e.id = t.id
          RETURNING e.id, t.state AS old_state, e.state AS new_state, t.review_status AS old_review, e.review_status AS new_review
        ),
        history AS (
          INSERT INTO memory_status_history (entry_id, old_state, new_state, old_review, new_review, changed_by)
          SELECT id, old_state, new_state, old_review, new_review, $3
          FROM updated
        )
        SELECT COUNT(*)::int AS affected
        FROM updated
      `,
      [ids, state, changedBy]
    );

    const affected = result.rows[0]?.affected ?? 0;
    if (affected > 0 && state === "deleted") {
      await this.pool.query(
        `
          UPDATE memory_facts
          SET fact_state = 'deleted',
              deleted_at = COALESCE(deleted_at, NOW()),
              updated_at = NOW(),
              neo4j_synced = FALSE,
              neo4j_synced_at = NULL
          WHERE entry_id = ANY($1::uuid[])
            AND deleted_at IS NULL
        `,
        [ids]
      );
    }
    return affected;
  }

  async deleteEntries(ids: string[]): Promise<number> {
    return this.updateEntryState(ids, "deleted", "system");
  }

  async tuneEntryVectorIndex(m = appConfig.PG_VECTOR_HNSW_M, efConstruction = appConfig.PG_VECTOR_HNSW_EF_CONSTRUCTION): Promise<void> {
    const safeM = sanitizeInt(m, 4, 128);
    const safeEfConstruction = sanitizeInt(efConstruction, 8, 2000);
    await this.pool.query("DROP INDEX IF EXISTS idx_entry_embedding");
    await this.pool.query(
      `
        CREATE INDEX IF NOT EXISTS idx_entry_embedding
        ON memory_entries USING hnsw (embedding vector_cosine_ops)
        WITH (m = ${safeM}, ef_construction = ${safeEfConstruction})
      `
    );
  }

  async getEntryVectorIndexDefinition(): Promise<string | null> {
    const result = await this.pool.query<{ indexdef: string }>(
      `
        SELECT indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_entry_embedding'
        LIMIT 1
      `
    );
    return result.rows[0]?.indexdef ?? null;
  }
}

function mapEntryRow(row: EntryRow): MemoryEntry {
  const entry: MemoryEntry = {
    id: row.id,
    content: row.content,
    normalizedContentKey: row.normalized_content_key,
    state: row.state,
    reviewStatus: row.review_status,
    categories: row.categories ?? [],
    sourceType: row.source_type,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };

  const embedding = parseVector(row.embedding);
  if (embedding && embedding.length > 0) {
    entry.embedding = embedding;
  }
  if (row.review_note) {
    entry.reviewNote = row.review_note;
  }
  if (row.deleted_at) {
    entry.deletedAt = row.deleted_at;
  }
  if (typeof row.similarity === "number") {
    entry.similarity = row.similarity;
  }
  return entry;
}

function mapFactRow(row: FactRow): MemoryEntryFact {
  const fact: MemoryEntryFact = {
    id: row.id,
    entryId: row.entry_id,
    subjectText: row.subject_text,
    predicate: row.predicate,
    valueType: row.value_type,
    normalizedFactKey: row.normalized_fact_key,
    confidence: row.confidence,
    factState: row.fact_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    neo4jSynced: row.neo4j_synced,
    neo4jRetryCount: row.neo4j_retry_count
  };

  if (row.subject_node_id) {
    fact.subjectNodeId = row.subject_node_id;
  }
  if (row.object_node_id) {
    fact.objectNodeId = row.object_node_id;
  }
  if (row.object_text) {
    fact.objectText = row.object_text;
  }
  if (row.deleted_at) {
    fact.deletedAt = row.deleted_at;
  }
  if (row.neo4j_synced_at) {
    fact.neo4jSyncedAt = row.neo4j_synced_at;
  }
  if (row.neo4j_last_error) {
    fact.neo4jLastError = row.neo4j_last_error;
  }
  return fact;
}

function mapEntrySortExpression(sortBy: MemoryEntrySearchQuery["sortBy"]): string {
  switch (sortBy) {
    case "content":
      return "content";
    case "sourceType":
      return "source_type";
    case "createdAt":
      return "created_at";
    case "lastSeenAt":
      return "last_seen_at";
    case "updatedAt":
    default:
      return "updated_at";
  }
}

function normalizeForKey(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildNormalizedFactKey(input: {
  subjectNodeId?: string;
  subjectText: string;
  predicate: string;
  objectNodeId: string | null;
  objectText: string | null;
}): string {
  const subject = normalizeForKey(input.subjectNodeId ?? input.subjectText);
  const predicate = normalizeForKey(input.predicate);
  const object = normalizeForKey(input.objectNodeId ?? input.objectText ?? "");
  return `${subject}|${predicate}|${object}`;
}

function toVectorLiteral(values: number[]): string {
  if (values.length === 0) {
    throw new Error("embedding vector is empty");
  }
  return `[${values.map((value) => formatVectorNumber(value)).join(",")}]`;
}

function formatVectorNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("embedding contains non-finite numbers");
  }
  return Number(value.toFixed(8)).toString();
}

function parseVector(raw: string | null): number[] | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim();
  if (!normalized.startsWith("[") || !normalized.endsWith("]")) {
    return undefined;
  }
  const inner = normalized.slice(1, -1).trim();
  if (inner.length === 0) {
    return [];
  }
  return inner.split(",").map((value) => Number.parseFloat(value.trim()));
}

function sanitizeInt(value: number, min: number, max: number): number {
  const truncated = Math.trunc(value);
  if (!Number.isFinite(truncated)) {
    return min;
  }
  return Math.min(max, Math.max(min, truncated));
}

function clampConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) {
    return 0.5;
  }
  if (confidence < 0) {
    return 0;
  }
  if (confidence > 1) {
    return 1;
  }
  return confidence;
}
