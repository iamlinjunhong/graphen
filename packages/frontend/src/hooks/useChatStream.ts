import { useCallback, useRef, useState } from "react";
import type { ChatMessage, ChatSource } from "@graphen/shared";
import { apiClient } from "../services/api";
import { useChatStore } from "../stores/useChatStore";
import { useSSE } from "./useSSE";

interface QuestionAnalysis {
  intent: string;
  key_entities: string[];
  retrieval_strategy: {
    use_graph: boolean;
    use_vector: boolean;
    graph_depth: number;
    vector_top_k: number;
    need_aggregation: boolean;
  };
  rewritten_query: string;
}

interface UseChatStreamOptions {
  defaultModel?: string;
}

interface SendMessageInput {
  sessionId: string;
  content: string;
  model?: string;
}

interface DeltaEventPayload {
  type: "delta";
  delta: string;
}

interface AnalysisEventPayload {
  type: "analysis";
  analysis: QuestionAnalysis;
}

interface SourcesEventPayload {
  type: "sources";
  sources: ChatSource[];
  graphContext: { nodes: string[]; edges: string[] };
  sourcePaths: Array<{ nodes: string[]; relations: string[] }>;
}

interface DoneEventPayload {
  type: "done";
  message: ChatMessage;
}

interface ErrorEventPayload {
  error: string;
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function useChatStream(options: UseChatStreamOptions = {}) {
  const { defaultModel } = options;

  const addMessage = useChatStore((state) => state.addMessage);
  const startStreaming = useChatStore((state) => state.startStreaming);
  const appendStreamingDelta = useChatStore((state) => state.appendStreamingDelta);
  const finishStreaming = useChatStore((state) => state.finishStreaming);
  const isStreaming = useChatStore((state) => state.isStreaming);

  const sse = useSSE();
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<QuestionAnalysis | null>(null);
  const [sources, setSources] = useState<ChatSource[]>([]);
  const streamDoneRef = useRef(false);

  const stop = useCallback(() => {
    sse.stop();
    finishStreaming();
  }, [finishStreaming, sse]);

  const handleEvent = useCallback((event: { event: string; data: string }) => {
    switch (event.event) {
      case "analysis": {
        const payload = parseJson<AnalysisEventPayload>(event.data);
        if (payload?.type === "analysis") {
          setAnalysis(payload.analysis);
        }
        break;
      }
      case "delta": {
        const payload = parseJson<DeltaEventPayload>(event.data);
        if (payload?.type === "delta" && payload.delta.length > 0) {
          appendStreamingDelta(payload.delta);
        }
        break;
      }
      case "sources": {
        const payload = parseJson<SourcesEventPayload>(event.data);
        if (payload?.type === "sources") {
          setSources(payload.sources);
        }
        break;
      }
      case "done": {
        const payload = parseJson<DoneEventPayload>(event.data);
        if (payload?.type === "done") {
          addMessage(apiClient.chat.parseMessage(payload.message));
          streamDoneRef.current = true;
          finishStreaming();
        }
        break;
      }
      case "error": {
        const payload = parseJson<ErrorEventPayload>(event.data);
        setError(payload?.error ?? "Stream error");
        finishStreaming();
        break;
      }
      default:
        break;
    }
  }, [addMessage, appendStreamingDelta, finishStreaming]);

  const sendMessage = useCallback(async (input: SendMessageInput): Promise<void> => {
    const content = input.content.trim();
    if (content.length === 0) {
      return;
    }

    setError(null);
    setAnalysis(null);
    setSources([]);
    streamDoneRef.current = false;

    addMessage({
      id: globalThis.crypto.randomUUID(),
      sessionId: input.sessionId,
      role: "user",
      content,
      createdAt: new Date()
    });

    startStreaming();

    try {
      await sse.start({
        url: apiClient.chat.streamUrl(input.sessionId),
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          content,
          model: input.model ?? defaultModel
        }),
        onMessage: handleEvent,
        onError: (streamError) => {
          setError(streamError.message);
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start chat stream";
      setError(message);
    } finally {
      if (!streamDoneRef.current) {
        finishStreaming();
      }
    }
  }, [addMessage, defaultModel, finishStreaming, handleEvent, sse, startStreaming]);

  return {
    isStreaming,
    isConnecting: sse.isConnecting,
    isConnected: sse.isConnected,
    error,
    analysis,
    sources,
    sendMessage,
    stop
  };
}
