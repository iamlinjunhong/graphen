import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import neo4j, { type Driver, type Record as Neo4jRecord, type Session } from "neo4j-driver";
import type { DocumentStatus } from "@graphen/shared";
import type { Pool, PoolClient } from "pg";
import { appConfig } from "../config.js";
import { closePgPoolSingleton, getPgPoolSingleton } from "../runtime/PgPool.js";
import { MEMORY_FOLLOWUP_SCHEMA_SQL, PHASE0_MEMORY_SCHEMA_SQL } from "../runtime/pgMemorySchema.js";
import { LLMService } from "../services/LLMService.js";

const execFileAsync = promisify(execFile);

const SUPPORTED_DOCUMENT_STATUS = new Set<DocumentStatus>([
  "uploading",
  "parsing",
  "extracting",
  "embedding",
  "completed",
  "error"
]);

const SUPPORTED_SOURCE_TYPES = new Set(["document", "chat_user", "chat_assistant", "manual"]);
const SUPPORTED_REVIEW_STATUS = new Set([
  "auto",
  "confirmed",
  "modified",
  "rejected",
  "conflicted"
]);
const SUPPORTED_VALUE_TYPES = new Set(["entity", "text", "number", "date"]);

export interface LegacyChatSessionRow {
  id: string;
  title: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface LegacyChatMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  sources_json: string | null;
  graph_context_json: string | null;
  source_paths_json: string | null;
  inferred_relations_json: string | null;
  created_at: string | null;
}

export interface LegacyMemoryFactRow {
  id: string;
  subject_node_id: string | null;
  predicate: string | null;
  object_node_id: string | null;
  object_text: string | null;
  value_type: string | null;
  normalized_key: string | null;
  confidence: number | null;
  review_status: string | null;
  review_note: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
}

export interface LegacyMemoryEvidenceRow {
  id: string;
  fact_id: string;
  source_type: string | null;
  document_id: string | null;
  chunk_id: string | null;
  chat_session_id: string | null;
  chat_message_id: string | null;
  excerpt: string | null;
  extracted_at: string | null;
}

export interface LegacyNeo4jDocumentRow {
  id: string;
  filename: string;
  fileType: string;
  fileSize: number;
  status: string;
  uploadedAt: string | null;
  parsedAt: string | null;
  metadata: Record<string, unknown>;
  errorMessage: string | null;
}

export interface LegacyNeo4jChunkRow {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  embedding: number[] | null;
  metadata: Record<string, unknown>;
}

export interface LegacyMigrationDataset {
  chatSessions: LegacyChatSessionRow[];
  chatMessages: LegacyChatMessageRow[];
  memoryFacts: LegacyMemoryFactRow[];
  memoryEvidence: LegacyMemoryEvidenceRow[];
  documents: LegacyNeo4jDocumentRow[];
  chunks: LegacyNeo4jChunkRow[];
}

export interface LegacyMigrationSource {
  load(): Promise<LegacyMigrationDataset>;
  close?(): Promise<void>;
}

export interface EntryEmbeddingProvider {
  generateEmbedding(text: string): Promise<number[]>;
}

export interface MigrationVerification {
  chatSessionCountMatched: boolean;
  chatMessageCountMatched: boolean;
  memoryEntryCountMatched: boolean;
  memoryFactCountMatched: boolean;
  memoryEvidenceCountMatched: boolean;
  documentCountMatched: boolean;
  chunkCountMatched: boolean;
  orphanChatMessages: number;
  orphanFacts: number;
  orphanEvidence: number;
  orphanChunks: number;
}

export interface MigrationResult {
  committed: boolean;
  sourceCounts: {
    chatSessions: number;
    chatMessages: number;
    memoryFacts: number;
    memoryEvidence: number;
    documents: number;
    chunks: number;
  };
  migratedCounts: {
    chatSessions: number;
    chatMessages: number;
    memoryEntries: number;
    memoryFacts: number;
    memoryEvidence: number;
    documents: number;
    chunks: number;
    generatedEmbeddings: number;
  };
  ids: {
    chatSessionIds: string[];
    chatMessageIds: string[];
    memoryEntryIds: string[];
    memoryFactIds: string[];
    memoryEvidenceIds: string[];
    documentIds: string[];
    chunkIds: string[];
  };
  verification: MigrationVerification;
}

interface MigrationArtifacts {
  chatSessionIds: Set<string>;
  chatMessageIds: Set<string>;
  memoryEntryIds: Set<string>;
  memoryFactIds: Set<string>;
  memoryEvidenceIds: Set<string>;
  documentIds: Set<string>;
  chunkIds: Set<string>;
}

interface MigrationContext {
  entryIdByLegacyFactId: Map<string, string>;
  factIdByLegacyFactId: Map<string, string>;
  documentIdByLegacyDocumentId: Map<string, string>;
  sessionIdByLegacySessionId: Map<string, string>;
  messageIdByLegacyMessageId: Map<string, string>;
}

export interface MigrateToPgOptions {
  source: LegacyMigrationSource;
  pool?: Pool;
  embeddingProvider?: EntryEmbeddingProvider;
  generateEmbeddings?: boolean;
  dryRun?: boolean;
  log?: (message: string) => void;
}

export interface SqliteAndNeo4jSourceOptions {
  chatDbPath?: string;
  memoryDbPath?: string;
  includeChat?: boolean;
  includeMemory?: boolean;
  includeNeo4j?: boolean;
  allowMissingSources?: boolean;
  neo4jUri?: string;
  neo4jUser?: string;
  neo4jPassword?: string;
  neo4jDatabase?: string;
}

export function mapLegacyId(
  kind:
    | "chat-session"
    | "chat-message"
    | "memory-entry"
    | "memory-fact"
    | "memory-evidence"
    | "document"
    | "chunk",
  legacyId: string
): string {
  const normalized = legacyId.trim();
  if (looksLikeUuid(normalized)) {
    return normalized.toLowerCase();
  }
  return toStableUuid(`${kind}:${normalized}`);
}

export function toStableUuid(input: string): string {
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 32).split("");
  // RFC 4122 variant + version bits
  hash[12] = "4";
  const variant = Number.parseInt(hash[16] ?? "0", 16);
  hash[16] = ((variant & 0x3) | 0x8).toString(16);
  const raw = hash.join("");
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 32)}`;
}

export class SqliteAndNeo4jSource implements LegacyMigrationSource {
  private readonly chatDbPath: string;
  private readonly memoryDbPath: string;
  private readonly includeChat: boolean;
  private readonly includeMemory: boolean;
  private readonly includeNeo4j: boolean;
  private readonly allowMissingSources: boolean;
  private readonly neo4jUri: string;
  private readonly neo4jUser: string;
  private readonly neo4jPassword: string;
  private readonly neo4jDatabase: string | undefined;
  private neo4jDriver: Driver | null = null;

  constructor(options: SqliteAndNeo4jSourceOptions = {}) {
    this.chatDbPath = options.chatDbPath ?? "data/chat.db";
    this.memoryDbPath = options.memoryDbPath ?? "data/memory.db";
    this.includeChat = options.includeChat ?? true;
    this.includeMemory = options.includeMemory ?? true;
    this.includeNeo4j = options.includeNeo4j ?? true;
    this.allowMissingSources = options.allowMissingSources ?? false;
    this.neo4jUri = options.neo4jUri ?? appConfig.NEO4J_URI;
    this.neo4jUser = options.neo4jUser ?? appConfig.NEO4J_USER;
    this.neo4jPassword = options.neo4jPassword ?? appConfig.NEO4J_PASSWORD;
    this.neo4jDatabase = options.neo4jDatabase ?? appConfig.NEO4J_DATABASE;
  }

  async load(): Promise<LegacyMigrationDataset> {
    const chatSessions = this.includeChat
      ? await this.readSqliteTable<LegacyChatSessionRow>(
          this.chatDbPath,
          "chat_sessions",
          `
            SELECT id, title, created_at, updated_at
            FROM chat_sessions
            ORDER BY created_at ASC, id ASC
          `
        )
      : [];
    const chatMessages = this.includeChat
      ? await this.readSqliteTable<LegacyChatMessageRow>(
          this.chatDbPath,
          "chat_messages",
          `
            SELECT
              id,
              session_id,
              role,
              content,
              sources_json,
              graph_context_json,
              source_paths_json,
              inferred_relations_json,
              created_at
            FROM chat_messages
            ORDER BY created_at ASC, id ASC
          `
        )
      : [];
    const memoryFacts = this.includeMemory
      ? await this.readSqliteTable<LegacyMemoryFactRow>(
          this.memoryDbPath,
          "memory_facts",
          `
            SELECT
              id,
              subject_node_id,
              predicate,
              object_node_id,
              object_text,
              value_type,
              normalized_key,
              confidence,
              review_status,
              review_note,
              first_seen_at,
              last_seen_at,
              created_at,
              updated_at,
              deleted_at
            FROM memory_facts
            ORDER BY created_at ASC, id ASC
          `
        )
      : [];
    const memoryEvidence = this.includeMemory
      ? await this.readSqliteTable<LegacyMemoryEvidenceRow>(
          this.memoryDbPath,
          "memory_evidence",
          `
            SELECT
              id,
              fact_id,
              source_type,
              document_id,
              chunk_id,
              chat_session_id,
              chat_message_id,
              excerpt,
              extracted_at
            FROM memory_evidence
            ORDER BY extracted_at ASC, id ASC
          `
        )
      : [];

    const { documents, chunks } = this.includeNeo4j
      ? await this.readNeo4jDocumentsAndChunks()
      : { documents: [], chunks: [] };

    return {
      chatSessions,
      chatMessages,
      memoryFacts,
      memoryEvidence,
      documents,
      chunks
    };
  }

  async close(): Promise<void> {
    if (this.neo4jDriver) {
      await this.neo4jDriver.close();
      this.neo4jDriver = null;
    }
  }

  private async readSqliteTable<T>(dbPath: string, tableName: string, sql: string): Promise<T[]> {
    const hasFile = await fileExists(dbPath);
    if (!hasFile) {
      if (this.allowMissingSources) {
        return [];
      }
      throw new Error(`SQLite source file not found: ${dbPath}`);
    }

    const tableExists = await this.sqliteTableExists(dbPath, tableName);
    if (!tableExists) {
      return [];
    }

    try {
      const { stdout } = await execFileAsync(
        "sqlite3",
        ["-json", dbPath, sql],
        { maxBuffer: 32 * 1024 * 1024 }
      );
      const raw = String(stdout ?? "").trim();
      if (raw.length === 0) {
        return [];
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed querying SQLite table ${tableName} from ${dbPath}: ${message}`);
    }
  }

  private async sqliteTableExists(dbPath: string, tableName: string): Promise<boolean> {
    const { stdout } = await execFileAsync(
      "sqlite3",
      [
        "-json",
        dbPath,
        `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}' LIMIT 1`
      ],
      { maxBuffer: 2 * 1024 * 1024 }
    );
    const raw = String(stdout ?? "").trim();
    if (raw.length === 0) {
      return false;
    }
    const rows = JSON.parse(raw);
    return Array.isArray(rows) && rows.length > 0;
  }

  private async readNeo4jDocumentsAndChunks(): Promise<{
    documents: LegacyNeo4jDocumentRow[];
    chunks: LegacyNeo4jChunkRow[];
  }> {
    const session = await this.getNeo4jReadSession();
    try {
      const docsResult = await session.run(
        `
          MATCH (d:Document)
          RETURN
            coalesce(d.id, '') AS id,
            coalesce(d.filename, d.name, d.title, '') AS filename,
            coalesce(d.fileType, d.file_type, 'txt') AS fileType,
            coalesce(d.fileSize, d.file_size, 0) AS fileSize,
            coalesce(d.status, 'completed') AS status,
            coalesce(toString(d.uploadedAt), toString(d.uploaded_at), '') AS uploadedAt,
            coalesce(toString(d.parsedAt), toString(d.parsed_at), '') AS parsedAt,
            d.metadata AS metadata,
            coalesce(d.errorMessage, d.error_message, '') AS errorMessage
          ORDER BY filename ASC, id ASC
        `
      );
      const chunkResult = await session.run(
        `
          MATCH (c:Chunk)
          RETURN
            coalesce(c.id, '') AS id,
            coalesce(c.documentId, c.document_id, '') AS documentId,
            coalesce(c.index, c.chunk_index, 0) AS chunkIndex,
            coalesce(c.content, c.text, '') AS content,
            c.embedding AS embedding,
            c.metadata AS metadata
          ORDER BY documentId ASC, chunkIndex ASC, id ASC
        `
      );

      const documents = docsResult.records
        .map((record) => mapLegacyNeo4jDocument(record))
        .filter((doc) => doc.id.length > 0);
      const chunks = chunkResult.records
        .map((record) => mapLegacyNeo4jChunk(record))
        .filter((chunk) => chunk.id.length > 0);

      return { documents, chunks };
    } catch (error) {
      if (this.allowMissingSources) {
        return { documents: [], chunks: [] };
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed querying Neo4j documents/chunks: ${message}`);
    } finally {
      await session.close();
    }
  }

  private async getNeo4jReadSession(): Promise<Session> {
    if (!this.neo4jDriver) {
      this.neo4jDriver = neo4j.driver(
        this.neo4jUri,
        neo4j.auth.basic(this.neo4jUser, this.neo4jPassword)
      );
      await this.neo4jDriver.verifyConnectivity();
    }

    return this.neo4jDriver.session({
      defaultAccessMode: neo4j.session.READ,
      database: this.neo4jDatabase
    });
  }
}

class LlmEmbeddingProvider implements EntryEmbeddingProvider {
  private readonly llm = LLMService.fromEnv();

  async generateEmbedding(text: string): Promise<number[]> {
    return this.llm.generateEmbedding(text);
  }
}

export class StaticMigrationSource implements LegacyMigrationSource {
  constructor(private readonly dataset: LegacyMigrationDataset) {}
  async load(): Promise<LegacyMigrationDataset> {
    return this.dataset;
  }
}

export async function migrateToPg(options: MigrateToPgOptions): Promise<MigrationResult> {
  const source = options.source;
  const pool = options.pool ?? getPgPoolSingleton();
  const generateEmbeddings = options.generateEmbeddings !== false;
  const dryRun = options.dryRun === true;
  const log = options.log ?? (() => {});

  const dataset = await source.load();
  assertNoDuplicateIds(dataset.chatSessions.map((row) => row.id), "chat_sessions.id");
  assertNoDuplicateIds(dataset.chatMessages.map((row) => row.id), "chat_messages.id");
  assertNoDuplicateIds(dataset.memoryFacts.map((row) => row.id), "memory_facts.id");
  assertNoDuplicateIds(dataset.memoryEvidence.map((row) => row.id), "memory_evidence.id");
  assertNoDuplicateIds(dataset.documents.map((row) => row.id), "neo4j Document.id");
  assertNoDuplicateIds(dataset.chunks.map((row) => row.id), "neo4j Chunk.id");

  const artifacts: MigrationArtifacts = {
    chatSessionIds: new Set(),
    chatMessageIds: new Set(),
    memoryEntryIds: new Set(),
    memoryFactIds: new Set(),
    memoryEvidenceIds: new Set(),
    documentIds: new Set(),
    chunkIds: new Set()
  };
  const context: MigrationContext = {
    entryIdByLegacyFactId: new Map(),
    factIdByLegacyFactId: new Map(),
    documentIdByLegacyDocumentId: new Map(),
    sessionIdByLegacySessionId: new Map(),
    messageIdByLegacyMessageId: new Map()
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureAllTargetSchemas(client);

    log(`Migrating chat sessions/messages (${dataset.chatSessions.length}/${dataset.chatMessages.length})`);
    await migrateChat(dataset, client, artifacts, context);

    log(`Migrating memory facts/evidence (${dataset.memoryFacts.length}/${dataset.memoryEvidence.length})`);
    await migrateMemory(dataset, client, artifacts, context);

    log(`Migrating Neo4j documents/chunks (${dataset.documents.length}/${dataset.chunks.length})`);
    await migrateDocuments(dataset, client, artifacts, context);

    let generatedEmbeddings = 0;
    if (generateEmbeddings) {
      const provider = options.embeddingProvider ?? new LlmEmbeddingProvider();
      log("Backfilling missing memory entry embeddings");
      generatedEmbeddings = await backfillEntryEmbeddings(client, artifacts.memoryEntryIds, provider);
    }

    const verification = await verifyMigration(client, artifacts, dataset);
    assertVerification(verification);

    if (dryRun) {
      await client.query("ROLLBACK");
      return buildResult(false, dataset, artifacts, verification, generatedEmbeddings);
    }

    await client.query("COMMIT");
    return buildResult(true, dataset, artifacts, verification, generatedEmbeddings);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    if (source.close) {
      await source.close();
    }
  }
}

function buildResult(
  committed: boolean,
  dataset: LegacyMigrationDataset,
  artifacts: MigrationArtifacts,
  verification: MigrationVerification,
  generatedEmbeddings: number
): MigrationResult {
  return {
    committed,
    sourceCounts: {
      chatSessions: dataset.chatSessions.length,
      chatMessages: dataset.chatMessages.length,
      memoryFacts: dataset.memoryFacts.length,
      memoryEvidence: dataset.memoryEvidence.length,
      documents: dataset.documents.length,
      chunks: dataset.chunks.length
    },
    migratedCounts: {
      chatSessions: artifacts.chatSessionIds.size,
      chatMessages: artifacts.chatMessageIds.size,
      memoryEntries: artifacts.memoryEntryIds.size,
      memoryFacts: artifacts.memoryFactIds.size,
      memoryEvidence: artifacts.memoryEvidenceIds.size,
      documents: artifacts.documentIds.size,
      chunks: artifacts.chunkIds.size,
      generatedEmbeddings
    },
    ids: {
      chatSessionIds: [...artifacts.chatSessionIds],
      chatMessageIds: [...artifacts.chatMessageIds],
      memoryEntryIds: [...artifacts.memoryEntryIds],
      memoryFactIds: [...artifacts.memoryFactIds],
      memoryEvidenceIds: [...artifacts.memoryEvidenceIds],
      documentIds: [...artifacts.documentIds],
      chunkIds: [...artifacts.chunkIds]
    },
    verification
  };
}

async function ensureAllTargetSchemas(client: PoolClient): Promise<void> {
  await client.query(PHASE0_MEMORY_SCHEMA_SQL);
  await client.query(MEMORY_FOLLOWUP_SCHEMA_SQL);

  await client.query(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title       TEXT NOT NULL DEFAULT 'New Session',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id  UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content     TEXT NOT NULL,
      metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated_at
    ON chat_sessions(updated_at DESC);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id
    ON chat_messages(session_id, created_at);
  `);

  await client.query(`
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
  await client.query(`
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
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chunk_document_index
    ON document_chunks(document_id, chunk_index);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_documents_created_at
    ON documents(created_at DESC);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_chunk_document
    ON document_chunks(document_id, chunk_index);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_chunk_embedding
    ON document_chunks USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);
  `);
}

async function migrateChat(
  dataset: LegacyMigrationDataset,
  client: PoolClient,
  artifacts: MigrationArtifacts,
  context: MigrationContext
): Promise<void> {
  for (const row of dataset.chatSessions) {
    const legacyId = sanitizeLegacyId(row.id, "chat_sessions.id");
    const sessionId = mapLegacyId("chat-session", legacyId);
    artifacts.chatSessionIds.add(sessionId);
    context.sessionIdByLegacySessionId.set(legacyId, sessionId);

    await client.query(
      `
        INSERT INTO chat_sessions (id, title, created_at, updated_at)
        VALUES ($1::uuid, $2, $3::timestamptz, $4::timestamptz)
        ON CONFLICT (id)
        DO UPDATE SET
          title = EXCLUDED.title,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        sessionId,
        row.title?.trim() || "Migrated Session",
        toIsoString(row.created_at),
        toIsoString(row.updated_at, row.created_at)
      ]
    );
  }

  for (const row of dataset.chatMessages) {
    const legacyMessageId = sanitizeLegacyId(row.id, "chat_messages.id");
    const legacySessionId = sanitizeLegacyId(row.session_id, "chat_messages.session_id");
    const sessionId = context.sessionIdByLegacySessionId.get(legacySessionId)
      ?? mapLegacyId("chat-session", legacySessionId);
    if (!artifacts.chatSessionIds.has(sessionId)) {
      artifacts.chatSessionIds.add(sessionId);
      await client.query(
        `
          INSERT INTO chat_sessions (id, title)
          VALUES ($1::uuid, $2)
          ON CONFLICT (id) DO NOTHING
        `,
        [sessionId, "Migrated Session"]
      );
    }
    context.sessionIdByLegacySessionId.set(legacySessionId, sessionId);

    const messageId = mapLegacyId("chat-message", legacyMessageId);
    artifacts.chatMessageIds.add(messageId);
    context.messageIdByLegacyMessageId.set(legacyMessageId, messageId);

    const metadata = buildChatMetadata(row);
    await client.query(
      `
        INSERT INTO chat_messages (
          id,
          session_id,
          role,
          content,
          metadata,
          created_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3,
          $4,
          $5::jsonb,
          $6::timestamptz
        )
        ON CONFLICT (id)
        DO UPDATE SET
          session_id = EXCLUDED.session_id,
          role = EXCLUDED.role,
          content = EXCLUDED.content,
          metadata = EXCLUDED.metadata,
          created_at = EXCLUDED.created_at
      `,
      [
        messageId,
        sessionId,
        normalizeChatRole(row.role),
        row.content ?? "",
        JSON.stringify(metadata),
        toIsoString(row.created_at)
      ]
    );
  }
}

async function migrateMemory(
  dataset: LegacyMigrationDataset,
  client: PoolClient,
  artifacts: MigrationArtifacts,
  context: MigrationContext
): Promise<void> {
  const evidenceByLegacyFactId = new Map<string, LegacyMemoryEvidenceRow[]>();
  for (const evidence of dataset.memoryEvidence) {
    const legacyFactId = sanitizeLegacyId(evidence.fact_id, "memory_evidence.fact_id");
    const bucket = evidenceByLegacyFactId.get(legacyFactId);
    if (bucket) {
      bucket.push(evidence);
    } else {
      evidenceByLegacyFactId.set(legacyFactId, [evidence]);
    }
  }

  for (const row of dataset.memoryFacts) {
    const legacyFactId = sanitizeLegacyId(row.id, "memory_facts.id");
    const factId = mapLegacyId("memory-fact", legacyFactId);
    const entryId = mapLegacyId("memory-entry", legacyFactId);
    context.factIdByLegacyFactId.set(legacyFactId, factId);
    context.entryIdByLegacyFactId.set(legacyFactId, entryId);
    artifacts.memoryFactIds.add(factId);
    artifacts.memoryEntryIds.add(entryId);

    const subjectNodeId = normalizeNullableText(row.subject_node_id);
    const subjectText = subjectNodeId ?? "unknown_subject";
    const predicate = normalizeNullableText(row.predicate) ?? "related_to";
    const objectNodeId = normalizeNullableText(row.object_node_id);
    let objectText = normalizeNullableText(row.object_text);
    if (!objectNodeId && !objectText) {
      objectText = "unknown_object";
    }

    const reviewStatus = normalizeReviewStatus(row.review_status);
    const state = row.deleted_at ? "deleted" : "active";
    const factState = row.deleted_at ? "deleted" : "active";
    const sourceType = deriveEntrySourceType(evidenceByLegacyFactId.get(legacyFactId) ?? []);

    const entryContent = buildEntryContent(subjectText, predicate, objectNodeId, objectText);
    const normalizedEntryKey = `${normalizeForKey(entryContent)}|legacy:${normalizeForKey(legacyFactId)}`;

    await client.query(
      `
        INSERT INTO memory_entries (
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
        )
        VALUES (
          $1::uuid,
          $2,
          NULL,
          $3,
          $4,
          $5,
          $6,
          '{}'::text[],
          $7,
          $8::timestamptz,
          $9::timestamptz,
          $10::timestamptz,
          $11::timestamptz,
          $12::timestamptz
        )
        ON CONFLICT (id)
        DO UPDATE SET
          content = EXCLUDED.content,
          normalized_content_key = EXCLUDED.normalized_content_key,
          state = EXCLUDED.state,
          review_status = EXCLUDED.review_status,
          review_note = EXCLUDED.review_note,
          source_type = EXCLUDED.source_type,
          first_seen_at = EXCLUDED.first_seen_at,
          last_seen_at = EXCLUDED.last_seen_at,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at,
          deleted_at = EXCLUDED.deleted_at
      `,
      [
        entryId,
        entryContent,
        normalizedEntryKey,
        state,
        reviewStatus,
        row.review_note ?? null,
        sourceType,
        toIsoString(row.first_seen_at, row.created_at),
        toIsoString(row.last_seen_at, row.updated_at ?? row.created_at),
        toIsoString(row.created_at),
        toIsoString(row.updated_at, row.created_at),
        row.deleted_at ? toIsoString(row.deleted_at) : null
      ]
    );

    const normalizedFactKey = normalizeNullableText(row.normalized_key)
      ?? buildNormalizedFactKey(subjectNodeId, subjectText, predicate, objectNodeId, objectText);

    await client.query(
      `
        INSERT INTO memory_facts (
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
          neo4j_retry_count
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12::timestamptz,
          $13::timestamptz,
          $14::timestamptz,
          FALSE,
          0
        )
        ON CONFLICT (id)
        DO UPDATE SET
          entry_id = EXCLUDED.entry_id,
          subject_node_id = EXCLUDED.subject_node_id,
          subject_text = EXCLUDED.subject_text,
          predicate = EXCLUDED.predicate,
          object_node_id = EXCLUDED.object_node_id,
          object_text = EXCLUDED.object_text,
          value_type = EXCLUDED.value_type,
          normalized_fact_key = EXCLUDED.normalized_fact_key,
          confidence = EXCLUDED.confidence,
          fact_state = EXCLUDED.fact_state,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at,
          deleted_at = EXCLUDED.deleted_at,
          neo4j_synced = FALSE,
          neo4j_synced_at = NULL,
          neo4j_retry_count = 0,
          neo4j_last_error = NULL
      `,
      [
        factId,
        entryId,
        subjectNodeId,
        subjectText,
        predicate,
        objectNodeId,
        objectText,
        normalizeValueType(row.value_type),
        normalizedFactKey,
        clampConfidence(row.confidence),
        factState,
        toIsoString(row.created_at),
        toIsoString(row.updated_at, row.created_at),
        row.deleted_at ? toIsoString(row.deleted_at) : null
      ]
    );
  }

  for (const row of dataset.memoryEvidence) {
    const legacyEvidenceId = sanitizeLegacyId(row.id, "memory_evidence.id");
    const legacyFactId = sanitizeLegacyId(row.fact_id, "memory_evidence.fact_id");
    const factId = context.factIdByLegacyFactId.get(legacyFactId);
    const entryId = context.entryIdByLegacyFactId.get(legacyFactId);
    if (!factId || !entryId) {
      continue;
    }

    const evidenceId = mapLegacyId("memory-evidence", legacyEvidenceId);
    artifacts.memoryEvidenceIds.add(evidenceId);
    const sourceType = normalizeSourceType(row.source_type);
    const documentId = normalizeNullableText(row.document_id);
    const chunkId = normalizeNullableText(row.chunk_id);
    const chatSessionId = remapOptionalContextId(
      row.chat_session_id,
      "chat-session",
      context.sessionIdByLegacySessionId
    );
    const chatMessageId = remapOptionalContextId(
      row.chat_message_id,
      "chat-message",
      context.messageIdByLegacyMessageId
    );
    const excerpt = normalizeNullableText(row.excerpt);
    const evidenceHash = buildEvidenceHash({
      sourceType,
      documentId,
      chunkId,
      chatSessionId,
      chatMessageId,
      excerpt
    });

    await client.query(
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
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11::timestamptz
        )
        ON CONFLICT (id)
        DO UPDATE SET
          fact_id = EXCLUDED.fact_id,
          entry_id = EXCLUDED.entry_id,
          source_type = EXCLUDED.source_type,
          evidence_hash = EXCLUDED.evidence_hash,
          document_id = EXCLUDED.document_id,
          chunk_id = EXCLUDED.chunk_id,
          chat_session_id = EXCLUDED.chat_session_id,
          chat_message_id = EXCLUDED.chat_message_id,
          excerpt = EXCLUDED.excerpt,
          extracted_at = EXCLUDED.extracted_at
      `,
      [
        evidenceId,
        factId,
        entryId,
        sourceType,
        evidenceHash,
        documentId,
        chunkId,
        chatSessionId,
        chatMessageId,
        excerpt,
        toIsoString(row.extracted_at)
      ]
    );
  }
}

async function migrateDocuments(
  dataset: LegacyMigrationDataset,
  client: PoolClient,
  artifacts: MigrationArtifacts,
  context: MigrationContext
): Promise<void> {
  for (const row of dataset.documents) {
    const legacyDocumentId = sanitizeLegacyId(row.id, "neo4j document id");
    const documentId = mapLegacyId("document", legacyDocumentId);
    context.documentIdByLegacyDocumentId.set(legacyDocumentId, documentId);
    artifacts.documentIds.add(documentId);

    await client.query(
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
          created_at,
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
          NOW(),
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
        documentId,
        row.filename.trim() || "migrated-document",
        normalizeDocumentFileType(row.fileType),
        normalizeBigInt(row.fileSize),
        normalizeDocumentStatus(row.status),
        toIsoString(row.uploadedAt),
        row.parsedAt ? toIsoString(row.parsedAt) : null,
        JSON.stringify(normalizeRecord(row.metadata)),
        normalizeNullableText(row.errorMessage)
      ]
    );
  }

  for (const row of dataset.chunks) {
    const legacyChunkId = sanitizeLegacyId(row.id, "neo4j chunk id");
    const chunkId = mapLegacyId("chunk", legacyChunkId);
    artifacts.chunkIds.add(chunkId);

    const legacyDocumentId = sanitizeLegacyId(row.documentId, "neo4j chunk.documentId");
    const mappedDocumentId = context.documentIdByLegacyDocumentId.get(legacyDocumentId)
      ?? mapLegacyId("document", legacyDocumentId);
    if (!artifacts.documentIds.has(mappedDocumentId)) {
      artifacts.documentIds.add(mappedDocumentId);
      await client.query(
        `
          INSERT INTO documents (id, filename, file_type, file_size, status, metadata)
          VALUES ($1::uuid, $2, 'txt', 0, 'completed', '{}'::jsonb)
          ON CONFLICT (id) DO NOTHING
        `,
        [mappedDocumentId, `migrated-placeholder-${legacyDocumentId}`]
      );
    }
    context.documentIdByLegacyDocumentId.set(legacyDocumentId, mappedDocumentId);

    const embeddingLiteral = normalizeChunkEmbedding(row.embedding);

    await client.query(
      `
        INSERT INTO document_chunks (
          id,
          document_id,
          chunk_index,
          content,
          embedding,
          metadata,
          created_at,
          updated_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3,
          $4,
          $5::vector,
          $6::jsonb,
          NOW(),
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
        chunkId,
        mappedDocumentId,
        Math.max(0, Math.floor(row.chunkIndex)),
        row.content ?? "",
        embeddingLiteral,
        JSON.stringify(normalizeRecord(row.metadata))
      ]
    );
  }
}

async function backfillEntryEmbeddings(
  client: PoolClient,
  migratedEntryIds: Set<string>,
  embeddingProvider: EntryEmbeddingProvider
): Promise<number> {
  if (migratedEntryIds.size === 0) {
    return 0;
  }

  const ids = [...migratedEntryIds];
  const rows = await client.query<{ id: string; content: string }>(
    `
      SELECT id, content
      FROM memory_entries
      WHERE id = ANY($1::uuid[])
        AND embedding IS NULL
        AND deleted_at IS NULL
      ORDER BY created_at ASC
    `,
    [ids]
  );

  let generated = 0;
  for (const row of rows.rows) {
    const embedding = await embeddingProvider.generateEmbedding(row.content);
    if (!Array.isArray(embedding) || embedding.length !== appConfig.EMBEDDING_DIMENSIONS) {
      throw new Error(
        `embedding dimension mismatch for entry ${row.id}: expected ${appConfig.EMBEDDING_DIMENSIONS}, got ${Array.isArray(embedding) ? embedding.length : "invalid"}`
      );
    }
    await client.query(
      `
        UPDATE memory_entries
        SET embedding = $2::vector,
            updated_at = NOW()
        WHERE id = $1::uuid
      `,
      [row.id, toVectorLiteral(embedding)]
    );
    generated += 1;
  }

  return generated;
}

async function verifyMigration(
  client: PoolClient,
  artifacts: MigrationArtifacts,
  dataset: LegacyMigrationDataset
): Promise<MigrationVerification> {
  const chatSessionCount = await countRowsByIds(client, "chat_sessions", artifacts.chatSessionIds);
  const chatMessageCount = await countRowsByIds(client, "chat_messages", artifacts.chatMessageIds);
  const memoryEntryCount = await countRowsByIds(client, "memory_entries", artifacts.memoryEntryIds);
  const memoryFactCount = await countRowsByIds(client, "memory_facts", artifacts.memoryFactIds);
  const memoryEvidenceCount = await countRowsByIds(client, "memory_evidence", artifacts.memoryEvidenceIds);
  const documentCount = await countRowsByIds(client, "documents", artifacts.documentIds);
  const chunkCount = await countRowsByIds(client, "document_chunks", artifacts.chunkIds);

  const orphanChatMessages = await countOrphans(
    client,
    artifacts.chatMessageIds,
    `
      SELECT COUNT(*)::int AS count
      FROM chat_messages m
      LEFT JOIN chat_sessions s
        ON s.id = m.session_id
      WHERE m.id = ANY($1::uuid[])
        AND s.id IS NULL
    `
  );
  const orphanFacts = await countOrphans(
    client,
    artifacts.memoryFactIds,
    `
      SELECT COUNT(*)::int AS count
      FROM memory_facts f
      LEFT JOIN memory_entries e
        ON e.id = f.entry_id
      WHERE f.id = ANY($1::uuid[])
        AND e.id IS NULL
    `
  );
  const orphanEvidence = await countOrphans(
    client,
    artifacts.memoryEvidenceIds,
    `
      SELECT COUNT(*)::int AS count
      FROM memory_evidence ev
      LEFT JOIN memory_facts f
        ON f.id = ev.fact_id
      LEFT JOIN memory_entries e
        ON e.id = ev.entry_id
      WHERE ev.id = ANY($1::uuid[])
        AND (f.id IS NULL OR e.id IS NULL)
    `
  );
  const orphanChunks = await countOrphans(
    client,
    artifacts.chunkIds,
    `
      SELECT COUNT(*)::int AS count
      FROM document_chunks c
      LEFT JOIN documents d
        ON d.id = c.document_id
      WHERE c.id = ANY($1::uuid[])
        AND d.id IS NULL
    `
  );

  return {
    chatSessionCountMatched: chatSessionCount === dataset.chatSessions.length,
    chatMessageCountMatched: chatMessageCount === dataset.chatMessages.length,
    memoryEntryCountMatched: memoryEntryCount === dataset.memoryFacts.length,
    memoryFactCountMatched: memoryFactCount === dataset.memoryFacts.length,
    memoryEvidenceCountMatched: memoryEvidenceCount === dataset.memoryEvidence.length,
    documentCountMatched: documentCount === dataset.documents.length,
    chunkCountMatched: chunkCount === dataset.chunks.length,
    orphanChatMessages,
    orphanFacts,
    orphanEvidence,
    orphanChunks
  };
}

function assertVerification(verification: MigrationVerification): void {
  const checks = [
    verification.chatSessionCountMatched,
    verification.chatMessageCountMatched,
    verification.memoryEntryCountMatched,
    verification.memoryFactCountMatched,
    verification.memoryEvidenceCountMatched,
    verification.documentCountMatched,
    verification.chunkCountMatched
  ];
  if (checks.some((ok) => !ok)) {
    throw new Error("migration count verification failed");
  }
  if (
    verification.orphanChatMessages > 0 ||
    verification.orphanFacts > 0 ||
    verification.orphanEvidence > 0 ||
    verification.orphanChunks > 0
  ) {
    throw new Error("migration relation integrity verification failed");
  }
}

async function countRowsByIds(
  client: PoolClient,
  tableName: "chat_sessions" | "chat_messages" | "memory_entries" | "memory_facts" | "memory_evidence" | "documents" | "document_chunks",
  ids: Set<string>
): Promise<number> {
  if (ids.size === 0) {
    return 0;
  }
  const result = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ${tableName} WHERE id = ANY($1::uuid[])`,
    [[...ids]]
  );
  return result.rows[0]?.count ?? 0;
}

async function countOrphans(client: PoolClient, ids: Set<string>, sql: string): Promise<number> {
  if (ids.size === 0) {
    return 0;
  }
  const result = await client.query<{ count: number }>(sql, [[...ids]]);
  return result.rows[0]?.count ?? 0;
}

function buildChatMetadata(row: LegacyChatMessageRow): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const sources = parseJson(row.sources_json);
  const graphContext = parseJson(row.graph_context_json);
  const sourcePaths = parseJson(row.source_paths_json);
  const inferredRelations = parseJson(row.inferred_relations_json);
  if (sources !== null) metadata.sources = sources;
  if (graphContext !== null) metadata.graphContext = graphContext;
  if (sourcePaths !== null) metadata.sourcePaths = sourcePaths;
  if (inferredRelations !== null) metadata.inferredRelations = inferredRelations;
  return metadata;
}

function parseJson(raw: string | null): unknown | null {
  if (!raw || raw.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeChatRole(raw: string): "user" | "assistant" | "system" {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (normalized === "assistant" || normalized === "system") {
    return normalized;
  }
  return "user";
}

function normalizeDocumentStatus(raw: string): DocumentStatus {
  const normalized = (raw ?? "").trim().toLowerCase() as DocumentStatus;
  return SUPPORTED_DOCUMENT_STATUS.has(normalized) ? normalized : "completed";
}

function normalizeDocumentFileType(raw: string): "pdf" | "md" | "txt" {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (normalized === "pdf" || normalized === "md" || normalized === "txt") {
    return normalized;
  }
  return "txt";
}

function normalizeSourceType(raw: string | null): "document" | "chat_user" | "chat_assistant" | "manual" {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (normalized === "document" || normalized === "doc") {
    return "document";
  }
  if (normalized === "chat_user" || normalized === "user" || normalized === "chat-user") {
    return "chat_user";
  }
  if (normalized === "chat_assistant" || normalized === "assistant" || normalized === "chat-assistant") {
    return "chat_assistant";
  }
  return "manual";
}

function deriveEntrySourceType(
  evidences: LegacyMemoryEvidenceRow[]
): "document" | "chat_user" | "chat_assistant" | "manual" {
  if (evidences.length === 0) {
    return "manual";
  }
  for (const evidence of evidences) {
    const source = normalizeSourceType(evidence.source_type);
    if (SUPPORTED_SOURCE_TYPES.has(source)) {
      return source as "document" | "chat_user" | "chat_assistant" | "manual";
    }
  }
  return "manual";
}

function normalizeReviewStatus(raw: string | null): "auto" | "confirmed" | "modified" | "rejected" | "conflicted" {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (SUPPORTED_REVIEW_STATUS.has(normalized)) {
    return normalized as "auto" | "confirmed" | "modified" | "rejected" | "conflicted";
  }
  return "auto";
}

function normalizeValueType(raw: string | null): "entity" | "text" | "number" | "date" {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (SUPPORTED_VALUE_TYPES.has(normalized)) {
    return normalized as "entity" | "text" | "number" | "date";
  }
  return "text";
}

function remapOptionalContextId(
  rawLegacyId: string | null,
  kind: "chat-session" | "chat-message",
  mapping: Map<string, string>
): string | null {
  const normalized = normalizeNullableText(rawLegacyId);
  if (!normalized) {
    return null;
  }
  const existing = mapping.get(normalized);
  if (existing) {
    return existing;
  }
  const id = mapLegacyId(kind, normalized);
  mapping.set(normalized, id);
  return id;
}

function buildEntryContent(
  subjectText: string,
  predicate: string,
  objectNodeId: string | null,
  objectText: string | null
): string {
  const object = objectText ?? objectNodeId ?? "unknown_object";
  return `${subjectText} ${predicate} ${object}`.trim();
}

function buildNormalizedFactKey(
  subjectNodeId: string | null,
  subjectText: string,
  predicate: string,
  objectNodeId: string | null,
  objectText: string | null
): string {
  const subject = normalizeForKey(subjectNodeId ?? subjectText);
  const relation = normalizeForKey(predicate);
  const object = normalizeForKey(objectNodeId ?? objectText ?? "");
  return `${subject}|${relation}|${object}`;
}

function buildEvidenceHash(input: {
  sourceType: "document" | "chat_user" | "chat_assistant" | "manual";
  documentId: string | null;
  chunkId: string | null;
  chatSessionId: string | null;
  chatMessageId: string | null;
  excerpt: string | null;
}): string {
  const payload = [
    input.sourceType,
    input.documentId ?? "",
    input.chunkId ?? "",
    input.chatSessionId ?? "",
    input.chatMessageId ?? "",
    (input.excerpt ?? "").trim().replace(/\s+/g, " ")
  ].join("|");
  return createHash("sha256").update(payload).digest("hex");
}

function normalizeChunkEmbedding(values: number[] | null): string | null {
  if (!values || values.length === 0) {
    return null;
  }
  if (values.length !== appConfig.EMBEDDING_DIMENSIONS) {
    return null;
  }
  return toVectorLiteral(values);
}

function normalizeForKey(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeNullableText(input: string | null | undefined): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clampConfidence(value: number | null): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0.5;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function toIsoString(
  input: string | null | undefined,
  fallbackInput?: string | null | undefined
): string {
  const value = normalizeNullableText(input) ?? normalizeNullableText(fallbackInput);
  if (!value) {
    return new Date().toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

function sanitizeLegacyId(input: string, fieldName: string): string {
  const trimmed = input?.trim();
  if (!trimmed) {
    throw new Error(`invalid empty legacy id in ${fieldName}`);
  }
  return trimmed;
}

function normalizeBigInt(input: number): number {
  if (!Number.isFinite(input)) {
    return 0;
  }
  return Math.max(0, Math.floor(input));
}

function normalizeRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
}

function assertNoDuplicateIds(ids: string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || id.trim().length === 0) {
      throw new Error(`${label} contains empty id`);
    }
    if (seen.has(id)) {
      throw new Error(`${label} contains duplicate id: ${id}`);
    }
    seen.add(id);
  }
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toVectorLiteral(values: number[]): string {
  const normalized = values.map((value) => {
    if (!Number.isFinite(value)) {
      throw new Error("embedding contains non-finite values");
    }
    return Number(value);
  });
  return `[${normalized.join(",")}]`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function mapLegacyNeo4jDocument(record: Neo4jRecord): LegacyNeo4jDocumentRow {
  return {
    id: toStringValue(record.get("id")),
    filename: toStringValue(record.get("filename")),
    fileType: toStringValue(record.get("fileType")),
    fileSize: toNumberValue(record.get("fileSize")),
    status: toStringValue(record.get("status")),
    uploadedAt: nullableStringValue(record.get("uploadedAt")),
    parsedAt: nullableStringValue(record.get("parsedAt")),
    metadata: toRecordValue(record.get("metadata")),
    errorMessage: nullableStringValue(record.get("errorMessage"))
  };
}

function mapLegacyNeo4jChunk(record: Neo4jRecord): LegacyNeo4jChunkRow {
  return {
    id: toStringValue(record.get("id")),
    documentId: toStringValue(record.get("documentId")),
    chunkIndex: toNumberValue(record.get("chunkIndex")),
    content: toStringValue(record.get("content")),
    embedding: toNumberArray(record.get("embedding")),
    metadata: toRecordValue(record.get("metadata"))
  };
}

function toStringValue(input: unknown): string {
  if (input == null) {
    return "";
  }
  if (typeof input === "string") {
    return input;
  }
  if (neo4j.isInt(input)) {
    return input.toString();
  }
  return String(input);
}

function nullableStringValue(input: unknown): string | null {
  const value = toStringValue(input).trim();
  return value.length > 0 ? value : null;
}

function toNumberValue(input: unknown): number {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }
  if (neo4j.isInt(input)) {
    return Number(input.toString());
  }
  const fromString = Number(toStringValue(input));
  return Number.isFinite(fromString) ? fromString : 0;
}

function toNumberArray(input: unknown): number[] | null {
  if (!Array.isArray(input)) {
    return null;
  }
  const values: number[] = [];
  for (const item of input) {
    const num = toNumberValue(item);
    if (!Number.isFinite(num)) {
      return null;
    }
    values.push(num);
  }
  return values.length > 0 ? values : null;
}

function toRecordValue(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    output[key] = toPlainJsValue(value);
  }
  return output;
}

function toPlainJsValue(input: unknown): unknown {
  if (input == null) {
    return null;
  }
  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean") {
    return input;
  }
  if (neo4j.isInt(input)) {
    return Number(input.toString());
  }
  if (Array.isArray(input)) {
    return input.map((item) => toPlainJsValue(item));
  }
  if (typeof input === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      output[key] = toPlainJsValue(value);
    }
    return output;
  }
  return String(input);
}

interface CliFlags {
  chatDbPath?: string;
  memoryDbPath?: string;
  skipChat: boolean;
  skipMemory: boolean;
  skipNeo4j: boolean;
  skipEmbeddings: boolean;
  allowMissingSources: boolean;
  dryRun: boolean;
}

function parseCliFlags(argv: string[]): CliFlags {
  const flags: CliFlags = {
    skipChat: false,
    skipMemory: false,
    skipNeo4j: false,
    skipEmbeddings: false,
    allowMissingSources: false,
    dryRun: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    if (token === "--chat-db" && argv[index + 1]) {
      flags.chatDbPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--memory-db" && argv[index + 1]) {
      flags.memoryDbPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--skip-chat") {
      flags.skipChat = true;
      continue;
    }
    if (token === "--skip-memory") {
      flags.skipMemory = true;
      continue;
    }
    if (token === "--skip-neo4j") {
      flags.skipNeo4j = true;
      continue;
    }
    if (token === "--skip-embeddings") {
      flags.skipEmbeddings = true;
      continue;
    }
    if (token === "--allow-missing-sources") {
      flags.allowMissingSources = true;
      continue;
    }
    if (token === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
  }

  return flags;
}

async function main(): Promise<void> {
  const flags = parseCliFlags(process.argv.slice(2));
  const source = new SqliteAndNeo4jSource({
    chatDbPath: flags.chatDbPath,
    memoryDbPath: flags.memoryDbPath,
    includeChat: !flags.skipChat,
    includeMemory: !flags.skipMemory,
    includeNeo4j: !flags.skipNeo4j,
    allowMissingSources: flags.allowMissingSources
  });

  const result = await migrateToPg({
    source,
    generateEmbeddings: !flags.skipEmbeddings,
    dryRun: flags.dryRun,
    log: (message) => console.log(`[migrate-to-pg] ${message}`)
  });

  console.log("Migration finished.");
  console.log(`Committed: ${result.committed ? "yes" : "no (dry-run rollback)"}`);
  console.log(
    `Source counts: chat_sessions=${result.sourceCounts.chatSessions}, chat_messages=${result.sourceCounts.chatMessages}, memory_facts=${result.sourceCounts.memoryFacts}, memory_evidence=${result.sourceCounts.memoryEvidence}, documents=${result.sourceCounts.documents}, chunks=${result.sourceCounts.chunks}`
  );
  console.log(
    `Migrated counts: chat_sessions=${result.migratedCounts.chatSessions}, chat_messages=${result.migratedCounts.chatMessages}, memory_entries=${result.migratedCounts.memoryEntries}, memory_facts=${result.migratedCounts.memoryFacts}, memory_evidence=${result.migratedCounts.memoryEvidence}, documents=${result.migratedCounts.documents}, chunks=${result.migratedCounts.chunks}, generated_embeddings=${result.migratedCounts.generatedEmbeddings}`
  );
  console.log(
    `Verification: counts_ok=${
      result.verification.chatSessionCountMatched &&
      result.verification.chatMessageCountMatched &&
      result.verification.memoryEntryCountMatched &&
      result.verification.memoryFactCountMatched &&
      result.verification.memoryEvidenceCountMatched &&
      result.verification.documentCountMatched &&
      result.verification.chunkCountMatched
    }, orphan_chat_messages=${result.verification.orphanChatMessages}, orphan_facts=${result.verification.orphanFacts}, orphan_evidence=${result.verification.orphanEvidence}, orphan_chunks=${result.verification.orphanChunks}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Migration failed: ${message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePgPoolSingleton();
    });
}
