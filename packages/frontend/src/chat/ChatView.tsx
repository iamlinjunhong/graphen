import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatSession, ChatSource } from "@graphen/shared";
import { useNavigate } from "react-router-dom";
import { useChatStream } from "../hooks/useChatStream";
import { apiClient } from "../services/api";
import { useChatStore } from "../stores/useChatStore";
import { useDocumentStore } from "../stores/useDocumentStore";
import { useGraphStore } from "../stores/useGraphStore";
import { ChatInput } from "./ChatInput";
import { ChatMessages } from "./ChatMessages";
import { ChatSidebar } from "./ChatSidebar";

function createDefaultSessionTitle(): string {
  return `Session ${new Date().toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  })}`;
}

export function ChatView() {
  const navigate = useNavigate();

  const sessions = useChatStore((state) => state.sessions);
  const currentSessionId = useChatStore((state) => state.currentSessionId);
  const messagesBySession = useChatStore((state) => state.messagesBySession);
  const streamingMessage = useChatStore((state) => state.streamingMessage);
  const setSessions = useChatStore((state) => state.setSessions);
  const upsertSession = useChatStore((state) => state.upsertSession);
  const removeSession = useChatStore((state) => state.removeSession);
  const setCurrentSessionId = useChatStore((state) => state.setCurrentSessionId);
  const setMessages = useChatStore((state) => state.setMessages);

  const setSelectedDocumentId = useDocumentStore((state) => state.setSelectedDocumentId);

  const [searchQuery, setSearchQuery] = useState("");
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>(["qwen-max"]);
  const [selectedModel, setSelectedModel] = useState("qwen-max");

  const {
    sendMessage,
    isStreaming,
    isConnecting,
    error: streamError
  } = useChatStream({
    defaultModel: selectedModel
  });

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await apiClient.config.getModels(signal);
      const chatModels = response.models.chat.length > 0 ? response.models.chat : ["qwen-max"];
      setModels(chatModels);
      const fallbackModel = chatModels[0] ?? "qwen-max";
      setSelectedModel((current) => (chatModels.includes(current) ? current : fallbackModel));
    } catch {
      setModels(["qwen-max"]);
      setSelectedModel("qwen-max");
    }
  }, []);

  const loadSessions = useCallback(
    async (signal?: AbortSignal) => {
      setIsLoadingSessions(true);
      setViewError(null);

      try {
        const params: {
          limit: number;
          signal?: AbortSignal;
        } = {
          limit: 120
        };
        if (signal) {
          params.signal = signal;
        }

        const fetchedSessions = await apiClient.chat.listSessions(params);
        setSessions(fetchedSessions);

        const selectedId = useChatStore.getState().currentSessionId;
        if (!selectedId && fetchedSessions.length > 0) {
          setCurrentSessionId(fetchedSessions[0]?.id ?? null);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }

        const message = error instanceof Error ? error.message : "Failed to load sessions";
        setViewError(message);
      } finally {
        setIsLoadingSessions(false);
      }
    },
    [setCurrentSessionId, setSessions]
  );

  const loadSessionDetail = useCallback(
    async (sessionId: string, signal?: AbortSignal) => {
      setIsLoadingMessages(true);
      setViewError(null);

      try {
        const detail = await apiClient.chat.getSessionDetail(sessionId, signal);
        setMessages(sessionId, detail.messages);
        upsertSession(detail.session);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        const message = error instanceof Error ? error.message : "Failed to load messages";
        setViewError(message);
      } finally {
        setIsLoadingMessages(false);
      }
    },
    [setMessages, upsertSession]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadModels(controller.signal);
    void loadSessions(controller.signal);
    return () => controller.abort();
  }, [loadModels, loadSessions]);

  useEffect(() => {
    if (!currentSessionId) {
      return;
    }

    const controller = new AbortController();
    void loadSessionDetail(currentSessionId, controller.signal);
    return () => controller.abort();
  }, [currentSessionId, loadSessionDetail]);

  const filteredSessions = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (normalized.length === 0) {
      return sessions;
    }

    return sessions.filter((session) => session.title.toLowerCase().includes(normalized));
  }, [searchQuery, sessions]);

  const currentMessages = currentSessionId ? (messagesBySession[currentSessionId] ?? []) : [];

  const handleCreateSession = useCallback(async () => {
    setViewError(null);

    try {
      const session = await apiClient.chat.createSession({
        title: createDefaultSessionTitle()
      });
      upsertSession(session);
      setCurrentSessionId(session.id);
      setMessages(session.id, []);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create session";
      setViewError(message);
    }
  }, [setCurrentSessionId, setMessages, upsertSession]);

  const handleDeleteSession = useCallback(
    async (session: ChatSession) => {
      const confirmed = window.confirm(`Delete session \"${session.title}\"?`);
      if (!confirmed) {
        return;
      }

      setViewError(null);
      try {
        await apiClient.chat.deleteSession(session.id);
        removeSession(session.id);

        const state = useChatStore.getState();
        if (!state.currentSessionId && state.sessions.length > 0) {
          const firstSession = state.sessions[0];
          if (firstSession) {
            setCurrentSessionId(firstSession.id);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to delete session";
        setViewError(message);
      }
    },
    [removeSession, setCurrentSessionId]
  );

  const handleSend = useCallback(
    async (content: string) => {
      if (!currentSessionId) {
        return;
      }

      await sendMessage({
        sessionId: currentSessionId,
        content,
        model: selectedModel
      });

      await loadSessions();
    },
    [currentSessionId, loadSessions, selectedModel, sendMessage]
  );

  const handleOpenDocument = useCallback(
    (source: ChatSource) => {
      setSelectedDocumentId(source.documentId);
      navigate("/documents");
    },
    [navigate, setSelectedDocumentId]
  );

  const handleOpenGraph = useCallback(
    (source: ChatSource) => {
      const graphStore = useGraphStore.getState();
      if (!graphStore.filters.documentIds.includes(source.documentId)) {
        graphStore.toggleDocumentFilter(source.documentId);
      }
      graphStore.setSearchQuery(source.documentName);
      navigate("/graph");
    },
    [navigate]
  );

  const activeError = viewError ?? streamError;

  return (
    <section className="page-shell chat-page-shell" style={{ flex: 1, overflow: "hidden" }}>

      <div className="chat-layout" style={{ height: "100%" }}>
        <ChatSidebar
          sessions={filteredSessions}
          currentSessionId={currentSessionId}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onCreateSession={handleCreateSession}
          onSelectSession={setCurrentSessionId}
          onDeleteSession={handleDeleteSession}
        />

        <div className="chat-main-column">
          <div className="chat-container-inner">
            {/* Column header — title + model selector (single, no duplicate) */}
            <div className="chat-column-header">
              <h2 className="chat-column-title">GraphRAG 智能对话</h2>
              <label className="chat-model-badge" htmlFor="chat-model-select">
                模型:
                <select
                  id="chat-model-select"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.currentTarget.value)}
                  disabled={models.length === 0}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "inherit",
                    font: "inherit",
                    fontSize: "0.85rem",
                    cursor: "pointer",
                    outline: "none",
                    marginLeft: 4,
                    maxWidth: 140
                  }}
                >
                  {models.map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              </label>
            </div>

            <ChatMessages
              messages={currentMessages}
              isStreaming={isStreaming || isConnecting}
              streamingMessage={streamingMessage}
              onOpenDocument={handleOpenDocument}
              onOpenGraph={handleOpenGraph}
            />

            <ChatInput
              disabled={!currentSessionId || isLoadingSessions || isLoadingMessages}
              isStreaming={isStreaming || isConnecting}
              models={models}
              selectedModel={selectedModel}
              onModelChange={setSelectedModel}
              onSend={handleSend}
            />
          </div>
        </div>
      </div>

      {activeError ? <p className="docs-error-banner">{activeError}</p> : null}
    </section>
  );
}
