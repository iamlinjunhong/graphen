import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ChatRole,
  ChatSession,
  ChatSource,
  InferredRelation,
  SourcePath
} from "@graphen/shared";
import type { Pool } from "pg";
import { getPgPoolSingleton } from "../runtime/PgPool.js";

interface ChatSessionRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface ChatMessageRow {
  id: string;
  session_id: string;
  role: ChatRole;
  content: string;
  metadata: unknown;
  created_at: string;
}

interface ChatMessageMetadata extends Record<string, unknown> {
  sources?: ChatSource[];
  graphContext?: { nodes: string[]; edges: string[] };
  sourcePaths?: SourcePath[];
  inferredRelations?: InferredRelation[];
}

export interface PgChatStoreLike {
  close(): Promise<void>;
  createSession(input: { title: string; id?: string }): Promise<ChatSession>;
  listSessions(limit?: number): Promise<ChatSession[]>;
  getSessionById(id: string): Promise<ChatSession | null>;
  deleteSession(id: string): Promise<boolean>;
  addMessage(input: {
    sessionId: string;
    role: ChatRole;
    content: string;
    metadata?: Record<string, unknown>;
    sources?: ChatSource[];
    graphContext?: { nodes: string[]; edges: string[] };
    sourcePaths?: SourcePath[];
    inferredRelations?: InferredRelation[];
    id?: string;
  }): Promise<ChatMessage>;
  listMessagesBySession(sessionId: string): Promise<ChatMessage[]>;
  getSessionWithMessages(sessionId: string): Promise<{ session: ChatSession; messages: ChatMessage[] } | null>;
  updateSessionTitle(id: string, title: string): Promise<boolean>;
}

export interface PgChatStoreOptions {
  pool?: Pool;
}

export class PgChatStore implements PgChatStoreLike {
  private readonly pool: Pool;
  private schemaReady: Promise<void> | null = null;

  constructor(options: PgChatStoreOptions = {}) {
    this.pool = options.pool ?? getPgPoolSingleton();
  }

  async close(): Promise<void> {
    // Pool lifecycle is managed by PgPool singleton
  }

  async createSession(input: { title: string; id?: string }): Promise<ChatSession> {
    await this.ensureSchema();

    const id = input.id ?? randomUUID();
    const title = input.title.trim();
    if (title.length === 0) {
      throw new Error("title must not be empty");
    }

    const result = await this.pool.query<ChatSessionRow>(
      `
        INSERT INTO chat_sessions (id, title)
        VALUES ($1::uuid, $2)
        RETURNING id, title, created_at, updated_at
      `,
      [id, title]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("failed to create chat session");
    }
    return mapSessionRow(row);
  }

  async listSessions(limit = 100): Promise<ChatSession[]> {
    await this.ensureSchema();
    const safeLimit = Math.max(1, Math.min(500, limit));
    const result = await this.pool.query<ChatSessionRow>(
      `
        SELECT id, title, created_at, updated_at
        FROM chat_sessions
        ORDER BY updated_at DESC, created_at DESC
        LIMIT $1
      `,
      [safeLimit]
    );
    return result.rows.map((row) => mapSessionRow(row));
  }

  async getSessionById(id: string): Promise<ChatSession | null> {
    await this.ensureSchema();
    const result = await this.pool.query<ChatSessionRow>(
      `
        SELECT id, title, created_at, updated_at
        FROM chat_sessions
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [id]
    );
    const row = result.rows[0];
    return row ? mapSessionRow(row) : null;
  }

  async deleteSession(id: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `
        DELETE FROM chat_sessions
        WHERE id = $1::uuid
      `,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async updateSessionTitle(id: string, title: string): Promise<boolean> {
    await this.ensureSchema();
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      throw new Error("title must not be empty");
    }

    const result = await this.pool.query(
      `
        UPDATE chat_sessions
        SET title = $2,
            updated_at = NOW()
        WHERE id = $1::uuid
      `,
      [id, trimmed]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async addMessage(input: {
    sessionId: string;
    role: ChatRole;
    content: string;
    metadata?: Record<string, unknown>;
    sources?: ChatSource[];
    graphContext?: { nodes: string[]; edges: string[] };
    sourcePaths?: SourcePath[];
    inferredRelations?: InferredRelation[];
    id?: string;
  }): Promise<ChatMessage> {
    await this.ensureSchema();

    const session = await this.getSessionById(input.sessionId);
    if (!session) {
      throw new Error(`chat session does not exist: ${input.sessionId}`);
    }

    const id = input.id ?? randomUUID();
    const metadata = buildMetadata(input);

    const result = await this.pool.query<ChatMessageRow>(
      `
        INSERT INTO chat_messages (id, session_id, role, content, metadata)
        VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)
        RETURNING id, session_id, role, content, metadata, created_at
      `,
      [id, input.sessionId, input.role, input.content, JSON.stringify(metadata)]
    );

    await this.pool.query(
      `
        UPDATE chat_sessions
        SET updated_at = NOW()
        WHERE id = $1::uuid
      `,
      [input.sessionId]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("failed to create chat message");
    }
    return mapMessageRow(row);
  }

  async listMessagesBySession(sessionId: string): Promise<ChatMessage[]> {
    await this.ensureSchema();
    const result = await this.pool.query<ChatMessageRow>(
      `
        SELECT id, session_id, role, content, metadata, created_at
        FROM chat_messages
        WHERE session_id = $1::uuid
        ORDER BY created_at ASC
      `,
      [sessionId]
    );
    return result.rows.map((row) => mapMessageRow(row));
  }

  async getSessionWithMessages(
    sessionId: string
  ): Promise<{ session: ChatSession; messages: ChatMessage[] } | null> {
    await this.ensureSchema();
    const session = await this.getSessionById(sessionId);
    if (!session) {
      return null;
    }
    const messages = await this.listMessagesBySession(sessionId);
    return { session, messages };
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.initializeSchema();
    }
    return this.schemaReady;
  }

  private async initializeSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title       TEXT NOT NULL DEFAULT 'New Session',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id  UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content     TEXT NOT NULL,
        metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated_at
      ON chat_sessions(updated_at DESC);
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id
      ON chat_messages(session_id, created_at);
    `);
  }
}

function mapSessionRow(row: ChatSessionRow): ChatSession {
  return {
    id: row.id,
    title: row.title,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

function mapMessageRow(row: ChatMessageRow): ChatMessage {
  const metadata = parseMetadata(row.metadata);
  const message: ChatMessage = {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: new Date(row.created_at)
  };
  if (Object.keys(metadata).length > 0) {
    message.metadata = metadata;
  }
  if (metadata.sources) {
    message.sources = metadata.sources;
  }
  if (metadata.graphContext) {
    message.graphContext = metadata.graphContext;
  }
  if (metadata.sourcePaths) {
    message.sourcePaths = metadata.sourcePaths;
  }
  if (metadata.inferredRelations) {
    message.inferredRelations = metadata.inferredRelations;
  }
  return message;
}

function parseMetadata(raw: unknown): ChatMessageMetadata {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const candidate = raw as Record<string, unknown>;
  const metadata: ChatMessageMetadata = {};
  for (const [key, value] of Object.entries(candidate)) {
    metadata[key] = value;
  }

  if (Array.isArray(candidate.sources)) {
    metadata.sources = candidate.sources as ChatSource[];
  } else {
    delete metadata.sources;
  }

  if (candidate.graphContext && typeof candidate.graphContext === "object") {
    const graphContext = candidate.graphContext as Record<string, unknown>;
    if (Array.isArray(graphContext.nodes) && Array.isArray(graphContext.edges)) {
      metadata.graphContext = {
        nodes: graphContext.nodes.filter((item): item is string => typeof item === "string"),
        edges: graphContext.edges.filter((item): item is string => typeof item === "string")
      };
    }
  } else {
    delete metadata.graphContext;
  }

  if (Array.isArray(candidate.sourcePaths)) {
    metadata.sourcePaths = candidate.sourcePaths as SourcePath[];
  } else {
    delete metadata.sourcePaths;
  }

  if (Array.isArray(candidate.inferredRelations)) {
    metadata.inferredRelations = candidate.inferredRelations as InferredRelation[];
  } else {
    delete metadata.inferredRelations;
  }

  return metadata;
}

function buildMetadata(input: {
  metadata?: Record<string, unknown>;
  sources?: ChatSource[];
  graphContext?: { nodes: string[]; edges: string[] };
  sourcePaths?: SourcePath[];
  inferredRelations?: InferredRelation[];
}): ChatMessageMetadata {
  const metadata: ChatMessageMetadata = {};
  if (input.metadata) {
    for (const [key, value] of Object.entries(input.metadata)) {
      if (value === undefined) {
        continue;
      }
      metadata[key] = value;
    }
  }
  if (input.sources && input.sources.length > 0) {
    metadata.sources = input.sources;
  }
  if (input.graphContext) {
    metadata.graphContext = input.graphContext;
  }
  if (input.sourcePaths && input.sourcePaths.length > 0) {
    metadata.sourcePaths = input.sourcePaths;
  }
  if (input.inferredRelations && input.inferredRelations.length > 0) {
    metadata.inferredRelations = input.inferredRelations;
  }
  return metadata;
}
