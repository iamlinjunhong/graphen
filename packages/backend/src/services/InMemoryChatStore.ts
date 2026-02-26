import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatRole, ChatSession, ChatSource, InferredRelation, SourcePath } from "@graphen/shared";
import type { ChatStoreLike } from "./ChatStore.js";

export class InMemoryChatStore implements ChatStoreLike {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly sessionMessages = new Map<string, ChatMessage[]>();

  close(): void {
    this.sessions.clear();
    this.sessionMessages.clear();
  }

  createSession(input: { title: string; id?: string }): ChatSession {
    const now = new Date();
    const session: ChatSession = {
      id: input.id ?? randomUUID(),
      title: input.title,
      createdAt: now,
      updatedAt: now
    };

    this.sessions.set(session.id, session);
    this.sessionMessages.set(session.id, []);
    return session;
  }

  listSessions(limit = 100): ChatSession[] {
    const safeLimit = Math.max(1, limit);
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, safeLimit);
  }

  getSessionById(id: string): ChatSession | null {
    return this.sessions.get(id) ?? null;
  }

  deleteSession(id: string): boolean {
    const existed = this.sessions.delete(id);
    this.sessionMessages.delete(id);
    return existed;
  }

  addMessage(input: {
    sessionId: string;
    role: ChatRole;
    content: string;
    sources?: ChatSource[];
    graphContext?: { nodes: string[]; edges: string[] };
    sourcePaths?: SourcePath[];
    inferredRelations?: InferredRelation[];
    id?: string;
  }): ChatMessage {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      throw new Error(`Chat session does not exist: ${input.sessionId}`);
    }

    const message: ChatMessage = {
      id: input.id ?? randomUUID(),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: new Date()
    };
    if (input.sources) {
      message.sources = input.sources;
    }
    if (input.graphContext) {
      message.graphContext = input.graphContext;
    }
    if (input.sourcePaths && input.sourcePaths.length > 0) {
      message.sourcePaths = input.sourcePaths;
    }
    if (input.inferredRelations && input.inferredRelations.length > 0) {
      message.inferredRelations = input.inferredRelations;
    }

    const messages = this.sessionMessages.get(input.sessionId) ?? [];
    messages.push(message);
    this.sessionMessages.set(input.sessionId, messages);

    this.sessions.set(input.sessionId, {
      ...session,
      updatedAt: message.createdAt
    });

    return message;
  }

  listMessagesBySession(sessionId: string): ChatMessage[] {
    return [...(this.sessionMessages.get(sessionId) ?? [])];
  }

  getSessionWithMessages(sessionId: string): { session: ChatSession; messages: ChatMessage[] } | null {
    const session = this.getSessionById(sessionId);
    if (!session) {
      return null;
    }

    return {
      session,
      messages: this.listMessagesBySession(sessionId)
    };
  }
}
