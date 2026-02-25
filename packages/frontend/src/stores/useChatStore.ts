import { create } from "zustand";
import type { ChatMessage, ChatSession } from "@graphen/shared";

interface ChatState {
  sessions: ChatSession[];
  currentSessionId: string | null;
  messagesBySession: Record<string, ChatMessage[]>;
  isStreaming: boolean;
  streamingMessage: string;
  setSessions: (sessions: ChatSession[]) => void;
  upsertSession: (session: ChatSession) => void;
  removeSession: (sessionId: string) => void;
  setCurrentSessionId: (sessionId: string | null) => void;
  setMessages: (sessionId: string, messages: ChatMessage[]) => void;
  addMessage: (message: ChatMessage) => void;
  startStreaming: () => void;
  appendStreamingDelta: (delta: string) => void;
  finishStreaming: () => void;
  reset: () => void;
}

function sortSessions(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export const useChatStore = create<ChatState>((set) => ({
  sessions: [],
  currentSessionId: null,
  messagesBySession: {},
  isStreaming: false,
  streamingMessage: "",
  setSessions: (sessions) =>
    set((state) => {
      const nextSessions = sortSessions(sessions);
      const sessionIds = new Set(nextSessions.map((session) => session.id));
      const nextMessagesBySession = Object.fromEntries(
        Object.entries(state.messagesBySession).filter(([sessionId]) =>
          sessionIds.has(sessionId)
        )
      );
      const currentSessionId =
        state.currentSessionId && sessionIds.has(state.currentSessionId)
          ? state.currentSessionId
          : nextSessions[0]?.id ?? null;

      return {
        sessions: nextSessions,
        messagesBySession: nextMessagesBySession,
        currentSessionId
      };
    }),
  upsertSession: (session) =>
    set((state) => {
      const nextSessions = state.sessions.filter((item) => item.id !== session.id);
      nextSessions.push(session);
      return {
        sessions: sortSessions(nextSessions),
        currentSessionId: state.currentSessionId ?? session.id
      };
    }),
  removeSession: (sessionId) =>
    set((state) => {
      const nextSessions = state.sessions.filter((session) => session.id !== sessionId);
      const { [sessionId]: _removed, ...remainingMessages } = state.messagesBySession;
      const nextCurrentSessionId =
        state.currentSessionId === sessionId
          ? nextSessions[0]?.id ?? null
          : state.currentSessionId;

      return {
        sessions: nextSessions,
        currentSessionId: nextCurrentSessionId,
        messagesBySession: remainingMessages
      };
    }),
  setCurrentSessionId: (sessionId) => set({ currentSessionId: sessionId }),
  setMessages: (sessionId, messages) =>
    set((state) => ({
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: [...messages]
      }
    })),
  addMessage: (message) =>
    set((state) => {
      const sessionMessages = state.messagesBySession[message.sessionId] ?? [];
      const nextSessionMessages = [...sessionMessages, message];
      return {
        messagesBySession: {
          ...state.messagesBySession,
          [message.sessionId]: nextSessionMessages
        }
      };
    }),
  startStreaming: () =>
    set({
      isStreaming: true,
      streamingMessage: ""
    }),
  appendStreamingDelta: (delta) =>
    set((state) => ({
      streamingMessage: `${state.streamingMessage}${delta}`
    })),
  finishStreaming: () =>
    set({
      isStreaming: false,
      streamingMessage: ""
    }),
  reset: () =>
    set({
      sessions: [],
      currentSessionId: null,
      messagesBySession: {},
      isStreaming: false,
      streamingMessage: ""
    })
}));
