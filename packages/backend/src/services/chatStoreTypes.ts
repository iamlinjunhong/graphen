import type {
  ChatMessage,
  ChatRole,
  ChatSession,
  ChatSource,
  InferredRelation,
  SourcePath
} from "@graphen/shared";

type Awaitable<T> = T | Promise<T>;

export interface ChatStoreLike {
  close(): Awaitable<void>;
  createSession(input: { title: string; id?: string }): Awaitable<ChatSession>;
  listSessions(limit?: number): Awaitable<ChatSession[]>;
  getSessionById(id: string): Awaitable<ChatSession | null>;
  deleteSession(id: string): Awaitable<boolean>;
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
  }): Awaitable<ChatMessage>;
  listMessagesBySession(sessionId: string): Awaitable<ChatMessage[]>;
  getSessionWithMessages(sessionId: string): Awaitable<{ session: ChatSession; messages: ChatMessage[] } | null>;
  updateSessionTitle(id: string, title: string): Awaitable<boolean>;
}
