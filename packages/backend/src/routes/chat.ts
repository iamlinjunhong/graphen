import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import type {
  AbstractGraphStore,
  ChatMessage,
  ChatSessionDetailResponse,
  CreateChatMessageResponse,
  CreateChatSessionResponse,
  ListChatSessionsResponse
} from "@graphen/shared";
import { validate } from "../middleware/validator.js";
import { getChatStoreSingleton } from "../runtime/chatRuntime.js";
import {
  ensureGraphStoreConnected,
  getGraphStoreSingleton,
  getLLMServiceSingleton
} from "../runtime/graphRuntime.js";
import type { ChatStoreLike } from "../services/ChatStore.js";
import { ChatService, ChatSessionNotFoundError, type ChatStreamEvent } from "../services/ChatService.js";
import type { LLMServiceLike } from "../services/llmTypes.js";
import { logger } from "../utils/logger.js";

const sessionParamsSchema = z.object({
  id: z.string().min(1)
});

const createSessionBodySchema = z.object({
  title: z.string().min(1).max(120).optional()
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
  const ensureStoreConnected =
    options.ensureStoreConnected ??
    (options.graphStore ? () => graphStore.connect() : () => ensureGraphStoreConnected(graphStore));
  const chatService =
    options.chatService ?? new ChatService(graphStore, chatStore, llmService);

  const chatRouter = Router();

  chatRouter.post(
    "/sessions",
    validate({ body: createSessionBodySchema }),
    (req, res) => {
      const session = chatService.createSession({
        title: req.body.title ?? "New Session"
      });

      const response: CreateChatSessionResponse = { session };
      res.status(201).json(response);
    }
  );

  chatRouter.get(
    "/sessions",
    validate({ query: listSessionsQuerySchema }),
    (req, res) => {
      const { limit } = req.query as unknown as z.infer<typeof listSessionsQuerySchema>;
      const response: ListChatSessionsResponse = {
        sessions: chatService.listSessions(limit)
      };
      res.json(response);
    }
  );

  chatRouter.get(
    "/sessions/:id",
    validate({ params: sessionParamsSchema }),
    (req, res) => {
      const sessionId = req.params.id ?? "";
      const sessionWithMessages = chatService.getSessionWithMessages(sessionId);
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
    }
  );

  chatRouter.delete(
    "/sessions/:id",
    validate({ params: sessionParamsSchema }),
    (req, res) => {
      const deleted = chatService.deleteSession(req.params.id ?? "");
      if (!deleted) {
        return res.status(404).json({ error: "Session not found" });
      }

      return res.status(204).send();
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
    case "done":
      sendSseEvent(res, "done", event);
      break;
    default:
      break;
  }
}

export const chatRouter = createChatRouter();
