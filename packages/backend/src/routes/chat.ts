import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import type {
  AbstractGraphStore,
  ChatMessage,
  ChatSessionDetailResponse,
  CreateChatMessageResponse,
  CreateChatSessionResponse,
  Document,
  ChunkSearchResult,
  ListChatSessionsResponse,
  MemoryEntryStoreLike,
  MemoryServiceLike,
  TriggerChatMemoryExtractionResponse
} from "@graphen/shared";
import { validate } from "../middleware/validator.js";
import { getChatStoreSingleton } from "../runtime/chatRuntime.js";
import {
  ensureGraphStoreConnected,
  getGraphStoreSingleton,
  getLLMServiceSingleton,
  getPgDocumentStoreSingleton
} from "../runtime/graphRuntime.js";
import { getPgPoolSingleton } from "../runtime/PgPool.js";
import { getPgMemoryEntryStoreSingleton } from "../runtime/memoryRuntime.js";
import type { ChatStoreLike } from "../services/chatStoreTypes.js";
import { ChatService, ChatSessionNotFoundError, type ChatStreamEvent } from "../services/ChatService.js";
import { MemoryService } from "../services/MemoryService.js";
import { MemoryExtractor } from "../services/MemoryExtractor.js";
import type { LLMServiceLike } from "../services/llmTypes.js";
import { logger } from "../utils/logger.js";
import { recordMemoryOperationalMetric } from "../utils/memoryOperationalMetrics.js";

const sessionParamsSchema = z.object({
  id: z.string().min(1)
});

const createSessionBodySchema = z.object({
  title: z.string().min(1).max(120).optional()
});

const updateSessionBodySchema = z.object({
  title: z.string().min(1).max(120)
});

const createMessageBodySchema = z.object({
  content: z.string().min(1),
  model: z.string().min(1).optional()
});

const listSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100)
});

interface CreateChatRouterOptions {
  chatStore?: ChatStoreLike;
  graphStore?: AbstractGraphStore;
  llmService?: LLMServiceLike;
  chatService?: ChatService;
  memoryService?: MemoryServiceLike;
  memoryExtractor?: MemoryExtractor;
  entryStore?: MemoryEntryStoreLike;
  chunkContextStore?: {
    chunkVectorSearch(vector: number[], k: number): Promise<ChunkSearchResult[]>;
    getDocuments(): Promise<Document[]>;
  };
  ensureStoreConnected?: () => Promise<void>;
}

function wantsSse(req: Request): boolean {
  const accepts = req.headers.accept ?? "";
  const streamFlag = req.query.stream;
  const streamRequested =
    typeof streamFlag === "string" && streamFlag.toLowerCase() === "true";
  return accepts.includes("text/event-stream") || streamRequested;
}

function sendSseEvent(res: Response, eventName: string, payload: unknown): void {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function buildMessageResponse(sessionId: string, message: ChatMessage): CreateChatMessageResponse {
  return {
    sessionId,
    message: {
      content: message.content
    }
  };
}

export function createChatRouter(options: CreateChatRouterOptions = {}): Router {
  const chatStore = options.chatStore ?? getChatStoreSingleton();
  const graphStore = options.graphStore ?? getGraphStoreSingleton();
  const llmService = options.llmService ?? getLLMServiceSingleton();
  const pgPool = options.graphStore ? undefined : getPgPoolSingleton();
  const entryStore = options.entryStore
    ?? (options.graphStore ? undefined : getPgMemoryEntryStoreSingleton());
  const chunkContextStore = options.chunkContextStore
    ?? (options.graphStore
      ? createGraphChunkContextStore(options.graphStore)
      : getPgDocumentStoreSingleton());
  const ensureStoreConnected =
    options.ensureStoreConnected ??
    (options.graphStore ? () => graphStore.connect() : () => ensureGraphStoreConnected(graphStore));
  const recordEntryAccessLogs = pgPool
    ? async (input: { entryIds: string[]; chatSessionId: string; accessType: string }): Promise<void> => {
      const dedupedEntryIds = Array.from(
        new Set(input.entryIds.map((entryId) => entryId.trim()).filter((entryId) => entryId.length > 0))
      );
      if (dedupedEntryIds.length === 0) {
        return;
      }

      try {
        await pgPool.query(
          `
            INSERT INTO memory_access_logs (entry_id, chat_session_id, access_type)
            SELECT id::uuid, $2, $3
            FROM unnest($1::text[]) AS id
          `,
          [dedupedEntryIds, input.chatSessionId, input.accessType]
        );
        await recordMemoryOperationalMetric(pgPool, {
          metricName: "memory_access_log_write",
          outcome: "success",
          count: dedupedEntryIds.length
        });
      } catch (error) {
        await recordMemoryOperationalMetric(pgPool, {
          metricName: "memory_access_log_write",
          outcome: "failure",
          count: dedupedEntryIds.length
        });
        throw error;
      }
    }
    : undefined;

  // Wire up memory dependencies (optional, graceful fallback)
  let memoryService: MemoryServiceLike | undefined = options.memoryService;
  let memoryExtractor: MemoryExtractor | undefined = options.memoryExtractor;
  if (!memoryService && !options.chatService) {
    try {
      memoryService = entryStore ? new MemoryService(entryStore) : undefined;
      if (memoryService) {
        const extractorDeps = entryStore ? { entryStore, ...(pgPool ? { pgPool } : {}) } : undefined;
        memoryExtractor = new MemoryExtractor(llmService, memoryService, {}, extractorDeps);
      }
    } catch {
      // Memory store unavailable — continue without memory
    }
  }

  const chatDeps: {
    memoryService?: MemoryServiceLike;
    memoryExtractor?: MemoryExtractor;
    entryStore?: MemoryEntryStoreLike;
    recordEntryAccessLogs?: (input: {
      entryIds: string[];
      chatSessionId: string;
      accessType: string;
    }) => Promise<void>;
    chunkContextStore: {
      chunkVectorSearch(vector: number[], k: number): Promise<ChunkSearchResult[]>;
      getDocuments(): Promise<Document[]>;
    };
  } = {
    chunkContextStore
  };
  if (entryStore) {
    chatDeps.entryStore = entryStore;
  }
  if (memoryService) {
    chatDeps.memoryService = memoryService;
  }
  if (memoryExtractor) {
    chatDeps.memoryExtractor = memoryExtractor;
  }
  if (recordEntryAccessLogs) {
    chatDeps.recordEntryAccessLogs = recordEntryAccessLogs;
  }

  const chatService =
    options.chatService ?? new ChatService(graphStore, chatStore, llmService, {}, chatDeps);

  const chatRouter = Router();

  chatRouter.post(
    "/sessions",
    validate({ body: createSessionBodySchema }),
    async (req, res) => {
      try {
        const session = await chatService.createSession({
          title: req.body.title ?? "New Session"
        });
        const response: CreateChatSessionResponse = { session };
        res.status(201).json(response);
      } catch (error) {
        logger.error({ err: error }, "Failed to create chat session");
        res.status(500).json({ error: "Failed to create chat session" });
      }
    }
  );

  chatRouter.get(
    "/sessions",
    validate({ query: listSessionsQuerySchema }),
    async (req, res) => {
      try {
        const { limit } = req.query as unknown as z.infer<typeof listSessionsQuerySchema>;
        const response: ListChatSessionsResponse = {
          sessions: await chatService.listSessions(limit)
        };
        res.json(response);
      } catch (error) {
        logger.error({ err: error }, "Failed to list chat sessions");
        res.status(500).json({ error: "Failed to list chat sessions" });
      }
    }
  );

  chatRouter.get(
    "/sessions/:id",
    validate({ params: sessionParamsSchema }),
    async (req, res) => {
      try {
        const sessionId = req.params.id ?? "";
        const sessionWithMessages = await chatService.getSessionWithMessages(sessionId);
        if (!sessionWithMessages) {
          return res.status(404).json({ error: "Session not found" });
        }

        const response: ChatSessionDetailResponse = {
          session: {
            ...sessionWithMessages.session,
            messages: sessionWithMessages.messages
          }
        };
        return res.json(response);
      } catch (error) {
        logger.error({ err: error }, "Failed to get chat session detail");
        return res.status(500).json({ error: "Failed to get chat session" });
      }
    }
  );

  chatRouter.delete(
    "/sessions/:id",
    validate({ params: sessionParamsSchema }),
    async (req, res) => {
      try {
        const deleted = await chatService.deleteSession(req.params.id ?? "");
        if (!deleted) {
          return res.status(404).json({ error: "Session not found" });
        }

        return res.status(204).send();
      } catch (error) {
        logger.error({ err: error }, "Failed to delete chat session");
        return res.status(500).json({ error: "Failed to delete chat session" });
      }
    }
  );

  chatRouter.patch(
    "/sessions/:id",
    validate({ params: sessionParamsSchema, body: updateSessionBodySchema }),
    async (req, res) => {
      try {
        const sessionId = req.params.id ?? "";
        const updated = await chatService.updateSessionTitle(sessionId, req.body.title);
        if (!updated) {
          return res.status(404).json({ error: "Session not found" });
        }
        const session = await chatService.getSessionWithMessages(sessionId);
        return res.json({ session: session!.session });
      } catch (error) {
        logger.error({ err: error }, "Failed to update chat session");
        return res.status(500).json({ error: "Failed to update chat session" });
      }
    }
  );

  chatRouter.post(
    "/sessions/:id/generate-title",
    validate({ params: sessionParamsSchema }),
    async (req, res) => {
      try {
        const sessionId = req.params.id ?? "";
        const title = await chatService.generateSmartTitle(sessionId);
        if (!title) return res.status(422).json({ error: "Insufficient messages for title generation" });
        const session = await chatService.getSessionWithMessages(sessionId);
        return res.json({ session: session!.session, title });
      } catch (error) {
        if (error instanceof ChatSessionNotFoundError) {
          return res.status(404).json({ error: "Session not found" });
        }
        logger.error({ err: error }, "Smart title generation failed");
        return res.status(500).json({ error: "Title generation failed" });
      }
    }
  );

  chatRouter.post(
    "/sessions/:id/messages",
    validate({
      params: sessionParamsSchema,
      body: createMessageBodySchema
    }),
    async (req, res) => {
      try {
        await ensureStoreConnected();
      } catch (error) {
        logger.error({ err: error }, "Graph store connection failed");
        return res.status(503).json({ error: "Graph store unavailable" });
      }

      const sessionId = req.params.id ?? "";
      const input = {
        sessionId,
        content: req.body.content,
        model: req.body.model
      };

      if (!wantsSse(req)) {
        try {
          const assistantMessage = await chatService.completeMessage(input);
          const response = buildMessageResponse(sessionId, assistantMessage);
          return res.status(202).json(response);
        } catch (error) {
          if (error instanceof ChatSessionNotFoundError) {
            return res.status(404).json({ error: "Session not found" });
          }

          logger.error({ err: error, sessionId }, "Chat completion failed");
          return res.status(500).json({ error: "Failed to process chat message" });
        }
      }

      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      sendSseEvent(res, "ack", { sessionId });
      const heartbeat = setInterval(() => {
        res.write(": heartbeat\n\n");
      }, 15_000);

      let closed = false;
      req.on("close", () => {
        closed = true;
        clearInterval(heartbeat);
      });

      try {
        for await (const event of chatService.streamMessage(input)) {
          if (closed) {
            break;
          }
          emitChatEvent(res, event);
        }
        clearInterval(heartbeat);
        if (!closed) {
          res.end();
        }
      } catch (error) {
        clearInterval(heartbeat);
        if (error instanceof ChatSessionNotFoundError) {
          sendSseEvent(res, "error", { error: "Session not found" });
          return res.end();
        }

        logger.error({ err: error, sessionId }, "Chat stream failed");
        sendSseEvent(res, "error", { error: "Failed to process chat stream" });
        return res.end();
      }
    }
  );

  chatRouter.post(
    "/sessions/:id/memory-extraction",
    validate({ params: sessionParamsSchema }),
    async (req, res) => {
      const sessionId = req.params.id ?? "";

      try {
        const extraction = await chatService.triggerSessionMemoryExtraction(sessionId);
        const response: TriggerChatMemoryExtractionResponse = extraction;
        return res.status(202).json(response);
      } catch (error) {
        if (error instanceof ChatSessionNotFoundError) {
          return res.status(404).json({ error: "Session not found" });
        }

        logger.error({ err: error, sessionId }, "Manual session memory extraction failed");
        return res.status(500).json({ error: "Failed to trigger memory extraction" });
      }
    }
  );

  return chatRouter;
}

function emitChatEvent(res: Response, event: ChatStreamEvent): void {
  switch (event.type) {
    case "analysis":
      sendSseEvent(res, "analysis", event);
      break;
    case "delta":
      sendSseEvent(res, "delta", event);
      break;
    case "sources":
      sendSseEvent(res, "sources", event);
      break;
    case "memory":
      sendSseEvent(res, "memory", event);
      break;
    case "done":
      sendSseEvent(res, "done", event);
      break;
    default:
      break;
  }
}

function createGraphChunkContextStore(graphStore: AbstractGraphStore): {
  chunkVectorSearch: (vector: number[], k: number) => Promise<ChunkSearchResult[]>;
  getDocuments: () => Promise<Document[]>;
} {
  const graphStoreAny = graphStore as unknown as {
    chunkVectorSearch?: (vector: number[], k: number) => Promise<ChunkSearchResult[]>;
    getDocuments?: () => Promise<Document[]>;
  };
  return {
    chunkVectorSearch: (vector, k) =>
      graphStoreAny.chunkVectorSearch
        ? graphStoreAny.chunkVectorSearch(vector, k)
        : Promise.resolve([]),
    getDocuments: () =>
      graphStoreAny.getDocuments
        ? graphStoreAny.getDocuments()
        : Promise.resolve([])
  };
}
