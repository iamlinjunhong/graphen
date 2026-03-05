import type { Pool } from "pg";

export const MIN_SUPPORTED_POSTGRES_MAJOR = 14;

export interface PostgresVersionInfo {
  version: string;
  versionNum: number;
  major: number;
}

export interface SchemaVerificationResult {
  missingTables: string[];
  missingIndexes: string[];
}

export const PHASE0_EXPECTED_TABLES = [
  "memory_entries",
  "memory_facts",
  "memory_evidence",
  "memory_categories",
  "memory_access_logs",
  "memory_status_history",
  "memory_operational_metrics"
] as const;

export const PHASE0_EXPECTED_INDEXES = [
  "idx_entry_normalized_key",
  "idx_entry_content_fts",
  "idx_entry_state",
  "idx_entry_review",
  "idx_entry_source",
  "idx_entry_categories",
  "idx_entry_created",
  "idx_entry_embedding",
  "idx_fact_entry_normalized_key",
  "idx_fact_id_entry",
  "idx_fact_entry_id",
  "idx_fact_subject_predicate",
  "idx_fact_subject_text_predicate",
  "idx_fact_confidence",
  "idx_fact_neo4j_sync",
  "idx_evidence_fact",
  "idx_evidence_fact_hash",
  "idx_evidence_entry",
  "idx_evidence_source",
  "idx_evidence_document",
  "idx_evidence_chat",
  "idx_access_entry",
  "idx_access_session",
  "idx_status_history_entry",
  "idx_status_history_changed_at",
  "idx_operational_metrics_lookup",
  "idx_operational_metrics_date"
] as const;

export const PHASE0_MEMORY_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory_entries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content         TEXT NOT NULL,
    embedding       vector(1024),
    normalized_content_key TEXT NOT NULL,
    state           TEXT NOT NULL DEFAULT 'active'
                    CHECK (state IN ('active','paused','archived','deleted')),
    review_status   TEXT NOT NULL DEFAULT 'auto'
                    CHECK (review_status IN ('auto','confirmed','modified','rejected','conflicted')),
    review_note     TEXT,
    categories      TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    source_type     TEXT NOT NULL DEFAULT 'document'
                    CHECK (source_type IN ('document','chat_user','chat_assistant','manual')),
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_normalized_key
    ON memory_entries(normalized_content_key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_entry_content_fts
    ON memory_entries USING GIN(to_tsvector('simple', content));
CREATE INDEX IF NOT EXISTS idx_entry_state ON memory_entries(state);
CREATE INDEX IF NOT EXISTS idx_entry_review ON memory_entries(review_status);
CREATE INDEX IF NOT EXISTS idx_entry_source ON memory_entries(source_type);
CREATE INDEX IF NOT EXISTS idx_entry_categories ON memory_entries USING GIN(categories);
CREATE INDEX IF NOT EXISTS idx_entry_created ON memory_entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entry_embedding
    ON memory_entries USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);

CREATE TABLE IF NOT EXISTS memory_facts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_id        UUID NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
    subject_node_id TEXT,
    subject_text    TEXT NOT NULL,
    predicate       TEXT NOT NULL,
    object_node_id  TEXT,
    object_text     TEXT,
    value_type      TEXT NOT NULL DEFAULT 'text'
                    CHECK (value_type IN ('entity','text','number','date')),
    normalized_fact_key TEXT NOT NULL,
    confidence      REAL NOT NULL DEFAULT 0.5,
    fact_state      TEXT NOT NULL DEFAULT 'active'
                    CHECK (fact_state IN ('active','deleted')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ,
    neo4j_synced    BOOLEAN NOT NULL DEFAULT FALSE,
    neo4j_synced_at TIMESTAMPTZ,
    neo4j_retry_count INTEGER NOT NULL DEFAULT 0,
    neo4j_last_error TEXT,
    CHECK (object_node_id IS NOT NULL OR object_text IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_entry_normalized_key
    ON memory_facts(entry_id, normalized_fact_key) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_id_entry
    ON memory_facts(id, entry_id);
CREATE INDEX IF NOT EXISTS idx_fact_entry_id ON memory_facts(entry_id);
CREATE INDEX IF NOT EXISTS idx_fact_subject_predicate ON memory_facts(subject_node_id, predicate);
CREATE INDEX IF NOT EXISTS idx_fact_subject_text_predicate ON memory_facts(subject_text, predicate);
CREATE INDEX IF NOT EXISTS idx_fact_confidence ON memory_facts(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_fact_neo4j_sync ON memory_facts(neo4j_synced, created_at)
    WHERE neo4j_synced = FALSE
      AND deleted_at IS NULL
      AND subject_text IS NOT NULL
      AND subject_text <> ''
      AND predicate IS NOT NULL
      AND predicate <> ''
      AND (object_node_id IS NOT NULL OR object_text IS NOT NULL);

CREATE TABLE IF NOT EXISTS memory_evidence (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fact_id         UUID NOT NULL,
    entry_id        UUID NOT NULL,
    source_type     TEXT NOT NULL CHECK (source_type IN ('document','chat_user','chat_assistant','manual')),
    evidence_hash   TEXT,
    document_id     TEXT,
    chunk_id        TEXT,
    chat_session_id TEXT,
    chat_message_id TEXT,
    excerpt         TEXT,
    extracted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_evidence_fact_entry
      FOREIGN KEY (fact_id, entry_id)
      REFERENCES memory_facts(id, entry_id)
      ON DELETE CASCADE,
    CONSTRAINT fk_evidence_entry
      FOREIGN KEY (entry_id)
      REFERENCES memory_entries(id)
      ON DELETE CASCADE
);

ALTER TABLE memory_evidence
  ADD COLUMN IF NOT EXISTS evidence_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_evidence_fact ON memory_evidence(fact_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_fact_hash
    ON memory_evidence(fact_id, evidence_hash)
    WHERE evidence_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_evidence_entry ON memory_evidence(entry_id);
CREATE INDEX IF NOT EXISTS idx_evidence_source ON memory_evidence(source_type);
CREATE INDEX IF NOT EXISTS idx_evidence_document ON memory_evidence(document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_evidence_chat ON memory_evidence(chat_session_id) WHERE chat_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_categories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memory_access_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_id        UUID NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
    fact_id         UUID REFERENCES memory_facts(id) ON DELETE SET NULL,
    chat_session_id TEXT NOT NULL,
    accessed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    access_type     TEXT NOT NULL DEFAULT 'context_injection'
);

CREATE INDEX IF NOT EXISTS idx_access_entry ON memory_access_logs(entry_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_session ON memory_access_logs(chat_session_id);

CREATE TABLE IF NOT EXISTS memory_operational_metrics (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    metric_date     DATE NOT NULL DEFAULT CURRENT_DATE,
    metric_name     TEXT NOT NULL
                    CHECK (metric_name IN ('document_memory_extraction','memory_evidence_write','memory_access_log_write')),
    source_type     TEXT NOT NULL DEFAULT 'all'
                    CHECK (source_type IN ('all','document','chat_user','chat_assistant','manual')),
    outcome         TEXT NOT NULL
                    CHECK (outcome IN ('success','failure','deduplicated')),
    metric_count    BIGINT NOT NULL DEFAULT 0 CHECK (metric_count >= 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(metric_date, metric_name, source_type, outcome)
);

CREATE INDEX IF NOT EXISTS idx_operational_metrics_lookup
    ON memory_operational_metrics(metric_name, metric_date DESC, source_type, outcome);
CREATE INDEX IF NOT EXISTS idx_operational_metrics_date
    ON memory_operational_metrics(metric_date DESC);

CREATE TABLE IF NOT EXISTS memory_status_history (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_id    UUID NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
    old_state   TEXT NOT NULL,
    new_state   TEXT NOT NULL,
    old_review  TEXT,
    new_review  TEXT,
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    changed_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_status_history_entry ON memory_status_history(entry_id);
CREATE INDEX IF NOT EXISTS idx_status_history_changed_at ON memory_status_history(changed_at DESC);
`;

export const MEMORY_FOLLOWUP_SCHEMA_SQL = `
ALTER TABLE memory_entries
  ADD COLUMN IF NOT EXISTS content_revision INTEGER NOT NULL DEFAULT 1;

ALTER TABLE memory_evidence
  ADD COLUMN IF NOT EXISTS evidence_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_fact_hash
    ON memory_evidence(fact_id, evidence_hash)
    WHERE evidence_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_operational_metrics (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    metric_date     DATE NOT NULL DEFAULT CURRENT_DATE,
    metric_name     TEXT NOT NULL
                    CHECK (metric_name IN ('document_memory_extraction','memory_evidence_write','memory_access_log_write')),
    source_type     TEXT NOT NULL DEFAULT 'all'
                    CHECK (source_type IN ('all','document','chat_user','chat_assistant','manual')),
    outcome         TEXT NOT NULL
                    CHECK (outcome IN ('success','failure','deduplicated')),
    metric_count    BIGINT NOT NULL DEFAULT 0 CHECK (metric_count >= 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(metric_date, metric_name, source_type, outcome)
);

CREATE INDEX IF NOT EXISTS idx_operational_metrics_lookup
    ON memory_operational_metrics(metric_name, metric_date DESC, source_type, outcome);
CREATE INDEX IF NOT EXISTS idx_operational_metrics_date
    ON memory_operational_metrics(metric_date DESC);

CREATE TABLE IF NOT EXISTS memory_fact_compat_metrics (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint        TEXT NOT NULL,
    method          TEXT NOT NULL,
    caller          TEXT NOT NULL,
    stage           TEXT NOT NULL,
    blocked         BOOLEAN NOT NULL DEFAULT FALSE,
    metric_date     DATE NOT NULL DEFAULT CURRENT_DATE,
    hit_count       INTEGER NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
    first_called_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_called_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(metric_date, endpoint, method, caller, stage, blocked)
);

CREATE INDEX IF NOT EXISTS idx_fact_compat_metrics_date
    ON memory_fact_compat_metrics(metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_fact_compat_metrics_endpoint_caller
    ON memory_fact_compat_metrics(endpoint, caller, metric_date DESC);

CREATE TABLE IF NOT EXISTS entry_rewrite_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_id        UUID NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
    entry_revision  INTEGER NOT NULL CHECK (entry_revision > 0),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','succeeded','failed','dead')),
    trigger_reason  TEXT NOT NULL DEFAULT 'facts_confirmed',
    attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts    INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    next_retry_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    old_content     TEXT,
    new_content     TEXT,
    model           TEXT,
    confidence      REAL,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    UNIQUE(entry_id, entry_revision)
);

CREATE INDEX IF NOT EXISTS idx_entry_rewrite_jobs_poll
    ON entry_rewrite_jobs(status, next_retry_at, created_at);
CREATE INDEX IF NOT EXISTS idx_entry_rewrite_jobs_entry
    ON entry_rewrite_jobs(entry_id, created_at DESC);
`;

export async function getPostgresVersion(pool: Pool): Promise<PostgresVersionInfo> {
  const result = await pool.query<{
    version: string;
    version_num: string;
  }>(`
    SELECT
      current_setting('server_version') AS version,
      current_setting('server_version_num') AS version_num
  `);

  const row = result.rows[0];
  if (!row) {
    throw new Error("Unable to read PostgreSQL version from server");
  }

  const versionNum = Number.parseInt(row.version_num, 10);
  if (!Number.isFinite(versionNum)) {
    throw new Error(`Invalid PostgreSQL version number: ${row.version_num}`);
  }

  return {
    version: row.version,
    versionNum,
    major: Math.floor(versionNum / 10_000)
  };
}

export function assertPostgresVersion(
  version: PostgresVersionInfo,
  minMajor = MIN_SUPPORTED_POSTGRES_MAJOR
): void {
  if (version.major < minMajor) {
    throw new Error(
      `PostgreSQL >= ${minMajor} is required, found ${version.version} (server_version_num=${version.versionNum})`
    );
  }
}

export async function ensurePgvectorExtension(pool: Pool): Promise<boolean> {
  const before = await pool.query<{ exists: boolean }>(`
    SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') AS exists
  `);
  if (before.rows[0]?.exists) {
    return true;
  }

  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");

  const after = await pool.query<{ exists: boolean }>(`
    SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') AS exists
  `);
  return Boolean(after.rows[0]?.exists);
}

export async function applyPhase0MemorySchema(pool: Pool): Promise<void> {
  await pool.query(PHASE0_MEMORY_SCHEMA_SQL);
}

export async function applyMemoryFollowupSchema(pool: Pool): Promise<void> {
  await pool.query(MEMORY_FOLLOWUP_SCHEMA_SQL);
}

export async function verifyPhase0Schema(pool: Pool): Promise<SchemaVerificationResult> {
  const tableRows = await pool.query<{ tablename: string }>(
    `
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = ANY($1::text[])
    `,
    [PHASE0_EXPECTED_TABLES]
  );

  const indexRows = await pool.query<{ indexname: string }>(
    `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ANY($1::text[])
    `,
    [PHASE0_EXPECTED_INDEXES]
  );

  const existingTables = new Set(tableRows.rows.map((row) => row.tablename));
  const existingIndexes = new Set(indexRows.rows.map((row) => row.indexname));

  const missingTables = PHASE0_EXPECTED_TABLES.filter((name) => !existingTables.has(name));
  const missingIndexes = PHASE0_EXPECTED_INDEXES.filter((name) => !existingIndexes.has(name));

  return {
    missingTables,
    missingIndexes
  };
}
