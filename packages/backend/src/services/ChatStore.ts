import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type { ChatMessage, ChatRole, ChatSession, ChatSource } from "@graphen/shared";

export interface ChatStoreOptions {
  dbPath?: string;
}

export interface ChatStoreLike {
  close(): void;
  createSession(input: { title: string; id?: string }): ChatSession;
  listSessions(limit?: number): ChatSession[];
  getSessionById(id: string): ChatSession | null;
  deleteSession(id: string): boolean;
  addMessage(input: {
    sessionId: string;
    role: ChatRole;
    content: string;
    sources?: ChatSource[];
    graphContext?: { nodes: string[]; edges: string[] };
    id?: string;
  }): ChatMessage;
  listMessagesBySession(sessionId: string): ChatMessage[];
  getSessionWithMessages(sessionId: string): { session: ChatSession; messages: ChatMessage[] } | null;
}

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
  sources_json: string | null;
  graph_context_json: string | null;
  created_at: string;
}

export class ChatStore implements ChatStoreLike {
  private readonly db: Database.Database;

  constructor(options: ChatStoreOptions = {}) {
    const dbPath = resolve(options.dbPath ?? "data/chat.db");
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");

    this.initializeSchema();
  }

  close(): void {
    this.db.close();
  }

  createSession(input: { title: string; id?: string }): ChatSession {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        INSERT INTO chat_sessions (id, title, created_at, updated_at)
        VALUES (@id, @title, @created_at, @updated_at)
        `
      )
      .run({
        id,
        title: input.title,
        created_at: now,
        updated_at: now
      });

    return this.getSessionById(id) as ChatSession;
  }

  listSessions(limit = 100): ChatSession[] {
    const safeLimit = Math.max(1, limit);
    const rows = this.db
      .prepare(
        `
        SELECT id, title, created_at, updated_at
        FROM chat_sessions
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ?
        `
      )
      .all(safeLimit) as ChatSessionRow[];

    return rows.map((row) => this.mapSessionRow(row));
  }

  getSessionById(id: string): ChatSession | null {
    const row = this.db
      .prepare(
        `
        SELECT id, title, created_at, updated_at
        FROM chat_sessions
        WHERE id = ?
        LIMIT 1
        `
      )
      .get(id) as ChatSessionRow | undefined;

    return row ? this.mapSessionRow(row) : null;
  }

  deleteSession(id: string): boolean {
    const result = this.db
      .prepare(
        `
        DELETE FROM chat_sessions
        WHERE id = ?
        `
      )
      .run(id);

    return result.changes > 0;
  }

  addMessage(input: {
    sessionId: string;
    role: ChatRole;
    content: string;
    sources?: ChatSource[];
    graphContext?: { nodes: string[]; edges: string[] };
    id?: string;
  }): ChatMessage {
    const sessionExists = this.getSessionById(input.sessionId);
    if (!sessionExists) {
      throw new Error(`Chat session does not exist: ${input.sessionId}`);
    }

    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `
        INSERT INTO chat_messages (
          id,
          session_id,
          role,
          content,
          sources_json,
          graph_context_json,
          created_at
        )
        VALUES (@id, @session_id, @role, @content, @sources_json, @graph_context_json, @created_at)
        `
      )
      .run({
        id,
        session_id: input.sessionId,
        role: input.role,
        content: input.content,
        sources_json: input.sources ? JSON.stringify(input.sources) : null,
        graph_context_json: input.graphContext ? JSON.stringify(input.graphContext) : null,
        created_at: now
      });

    this.db
      .prepare(
        `
        UPDATE chat_sessions
        SET updated_at = ?
        WHERE id = ?
        `
      )
      .run(now, input.sessionId);

    const row = this.db
      .prepare(
        `
        SELECT id, session_id, role, content, sources_json, graph_context_json, created_at
        FROM chat_messages
        WHERE id = ?
        LIMIT 1
        `
      )
      .get(id) as ChatMessageRow;

    return this.mapMessageRow(row);
  }

  listMessagesBySession(sessionId: string): ChatMessage[] {
    const rows = this.db
      .prepare(
        `
        SELECT id, session_id, role, content, sources_json, graph_context_json, created_at
        FROM chat_messages
        WHERE session_id = ?
        ORDER BY created_at ASC
        `
      )
      .all(sessionId) as ChatMessageRow[];

    return rows.map((row) => this.mapMessageRow(row));
  }

  getSessionWithMessages(sessionId: string): { session: ChatSession; messages: ChatMessage[] } | null {
    const session = this.getSessionById(sessionId);
    if (!session) {
      return null;
    }

    const messages = this.listMessagesBySession(sessionId);
    return { session, messages };
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        sources_json TEXT,
        graph_context_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id
        ON chat_messages(session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated_at
        ON chat_sessions(updated_at DESC);
    `);
  }

  private mapSessionRow(row: ChatSessionRow): ChatSession {
    return {
      id: row.id,
      title: row.title,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  private mapMessageRow(row: ChatMessageRow): ChatMessage {
    const message: ChatMessage = {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      createdAt: new Date(row.created_at)
    };

    const sources = this.parseOptionalJson<ChatSource[]>(row.sources_json);
    if (sources) {
      message.sources = sources;
    }

    const graphContext = this.parseOptionalJson<{ nodes: string[]; edges: string[] }>(
      row.graph_context_json
    );
    if (graphContext) {
      message.graphContext = graphContext;
    }

    return message;
  }

  private parseOptionalJson<T>(raw: string | null): T | undefined {
    if (!raw) {
      return undefined;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }
}
