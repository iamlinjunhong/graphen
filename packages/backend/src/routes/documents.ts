import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Request, RequestHandler, Response } from "express";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import type {
  AbstractGraphStore,
  Document,
  DocumentStatus,
  DocumentStatusResponse,
  GetDocumentContentResponse,
  GetDocumentResponse,
  ListDocumentsResponse,
  ReparseDocumentResponse,
  UploadDocumentResponse
} from "@graphen/shared";
import { DocumentContentStore } from "../services/DocumentContentStore.js";
import { appConfig } from "../config.js";
import { validate } from "../middleware/validator.js";
import { validateUploadedFile } from "../parsers/fileValidator.js";
import { DocumentPipeline } from "../pipeline/DocumentPipeline.js";
import type { PipelinePhase, PipelineStatusEvent } from "../pipeline/types.js";
import {
  ensureGraphStoreConnected,
  getDocumentPipelineSingleton,
  getGraphStoreSingleton,
  getLLMServiceSingleton
} from "../runtime/graphRuntime.js";
import type { LLMServiceLike } from "../services/llmTypes.js";
import { logger } from "../utils/logger.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: appConfig.MAX_UPLOAD_SIZE
  }
});

const documentStatuses = [
  "uploading",
  "parsing",
  "extracting",
  "embedding",
  "completed",
  "error"
] as const;

const documentParamsSchema = z.object({
  id: z.string().min(1)
});

const listDocumentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(documentStatuses).optional()
});

const reparseParamsSchema = z.object({
  id: z.string().min(1)
});

const MAX_EDITABLE_CHARS = 200_000;

const reparseBodySchema = z.object({
  content: z.string().max(MAX_EDITABLE_CHARS).optional()
});

interface DocumentStatusSnapshot {
  id: string;
  status: DocumentStatusResponse["status"];
  phase?: PipelinePhase;
  progress?: number;
  message?: string;
  updatedAt: string;
  chunkCount?: number;
  entityCount?: number;
}

interface CreateDocumentsRouterOptions {
  store?: AbstractGraphStore;
  llmService?: LLMServiceLike;
  pipeline?: DocumentPipeline;
  ensureStoreConnected?: () => Promise<void>;
  uploadsDir?: string;
  cacheDir?: string;
}

function phaseToDocumentStatus(phase: PipelinePhase): DocumentStatus {
  switch (phase) {
    case "parsing":
    case "chunking":
      return "parsing";
    case "extracting":
    case "resolving":
      return "extracting";
    case "embedding":
    case "saving":
      return "embedding";
    case "completed":
      return "completed";
    case "error":
      return "error";
    default:
      return "error";
  }
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

export function createDocumentsRouter(options: CreateDocumentsRouterOptions = {}): Router {
  const store = options.store ?? getGraphStoreSingleton();
  const llmService = options.llmService ?? getLLMServiceSingleton();
  const pipeline =
    options.pipeline ??
    (options.store || options.llmService
      ? new DocumentPipeline(store, llmService)
      : getDocumentPipelineSingleton());
  const ensureStoreConnected =
    options.ensureStoreConnected ??
    (options.store ? () => store.connect() : () => ensureGraphStoreConnected(store));
  const uploadsDir = resolve(options.uploadsDir ?? "data/uploads");
  const cacheDir = resolve(options.cacheDir ?? appConfig.CACHE_DIR);
  const contentStore = new DocumentContentStore({ uploadsDir });

  const statusSnapshots = new Map<string, DocumentStatusSnapshot>();
  const jobs = new Map<string, Promise<void>>();
  const statusEventBus = new EventEmitter();

  const rememberStatus = (snapshot: DocumentStatusSnapshot): void => {
    statusSnapshots.set(snapshot.id, snapshot);
    statusEventBus.emit("status", snapshot);
  };

  const toStatusSnapshot = (event: PipelineStatusEvent): DocumentStatusSnapshot => {
    const snapshot: DocumentStatusSnapshot = {
      id: event.documentId,
      status: phaseToDocumentStatus(event.phase),
      phase: event.phase,
      progress: event.progress,
      updatedAt: new Date().toISOString()
    };
    if (event.message !== undefined) {
      snapshot.message = event.message;
    }
    return snapshot;
  };

  pipeline.onStatus((event) => {
    rememberStatus(toStatusSnapshot(event));
  });

  const getDocumentById = async (id: string): Promise<Document | null> => {
    const documents = await store.getDocuments();
    return documents.find((item) => item.id === id) ?? null;
  };

  const getCurrentStatus = async (documentId: string): Promise<DocumentStatusSnapshot | null> => {
    const cached = statusSnapshots.get(documentId);
    if (cached) {
      return cached;
    }

    const doc = await getDocumentById(documentId);
    if (!doc) {
      return null;
    }

    const snapshot: DocumentStatusSnapshot = {
      id: documentId,
      status: doc.status,
      updatedAt: new Date().toISOString()
    };
    statusSnapshots.set(documentId, snapshot);
    return snapshot;
  };

  const runPipelineInBackground = (
    document: Document,
    fileBuffer: Buffer,
    pipelineOptions?: { rawText?: string; forceRebuild?: boolean }
  ): void => {
    if (jobs.has(document.id)) {
      return;
    }

    const task = (async () => {
      try {
        await pipeline.process(document, fileBuffer, pipelineOptions);

        const latest = await getDocumentById(document.id);
        if (latest) {
          // T11: Attach chunkCount/entityCount metadata to completed event
          let chunkCount: number | undefined;
          let entityCount: number | undefined;
          try {
            const chunks = await store.getChunksByDocument(document.id);
            chunkCount = chunks.length;
            const stats = await store.getStats();
            // entityCount from document metadata if available, otherwise omit
            entityCount = latest.metadata.entityCount as number | undefined;
          } catch {
            // Non-critical — proceed without metadata
          }

          rememberStatus({
            id: latest.id,
            status: latest.status,
            phase: "completed",
            progress: 100,
            chunkCount,
            entityCount,
            updatedAt: new Date().toISOString()
          });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error during document processing";
        logger.error(
          {
            documentId: document.id,
            err: error
          },
          "Document processing failed"
        );

        const errorDocument: Document = {
          ...document,
          status: "error",
          metadata: document.metadata,
          errorMessage: message
        };

        try {
          await store.saveDocument(errorDocument);
        } catch (saveError) {
          logger.error(
            {
              documentId: document.id,
              err: saveError
            },
            "Failed to persist errored document status"
          );
        }

        rememberStatus({
          id: document.id,
          status: "error",
          phase: "error",
          progress: 100,
          message,
          updatedAt: new Date().toISOString()
        });
      } finally {
        jobs.delete(document.id);
      }
    })();

    jobs.set(document.id, task);
  };

  const documentsRouter = Router();

  /** Wrap multer middleware to catch MulterError (e.g. file too large) gracefully */
  const handleUpload: RequestHandler = (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err) {
        const message = err instanceof multer.MulterError
          ? (err.code === "LIMIT_FILE_SIZE"
            ? `File too large. Maximum allowed size is ${Math.round(appConfig.MAX_UPLOAD_SIZE / 1024 / 1024)}MB`
            : err.message)
          : (err instanceof Error ? err.message : "File upload failed");
        return res.status(400).json({ error: message });
      }
      next();
    });
  };

  documentsRouter.post("/upload", handleUpload, async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    try {
      await ensureStoreConnected();
    } catch (error) {
      logger.error({ err: error }, "Graph store connection failed");
      return res.status(503).json({ error: "Graph store unavailable" });
    }

    let validatedFile: Awaited<ReturnType<typeof validateUploadedFile>>;
    try {
      validatedFile = await validateUploadedFile(req.file, {
        maxSizeBytes: appConfig.MAX_UPLOAD_SIZE
      });
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : "File validation failed"
      });
    }

    const documentId = randomUUID();
    const documentUploadDir = resolve(uploadsDir, documentId);
    const savedFilePath = resolve(documentUploadDir, validatedFile.sanitizedFilename);

    const initialDocument: Document = {
      id: documentId,
      filename: validatedFile.sanitizedFilename,
      fileType: validatedFile.fileType,
      fileSize: validatedFile.size,
      status: "uploading",
      uploadedAt: new Date(),
      metadata: {}
    };

    try {
      await mkdir(documentUploadDir, { recursive: true });
      await writeFile(savedFilePath, req.file.buffer);
      await store.saveDocument(initialDocument);
    } catch (error) {
      await rm(documentUploadDir, { recursive: true, force: true });
      logger.error({ err: error }, "Failed to persist uploaded file");
      return res.status(500).json({ error: "Failed to store uploaded file" });
    }

    rememberStatus({
      id: documentId,
      status: "uploading",
      progress: 0,
      updatedAt: new Date().toISOString()
    });
    runPipelineInBackground(initialDocument, req.file.buffer);

    const response: UploadDocumentResponse = {
      message: "File upload accepted",
      documentId,
      file: {
        originalName: req.file.originalname,
        mimeType: validatedFile.mimeType,
        size: req.file.size
      }
    };

    res.setHeader("x-document-id", documentId);
    return res.status(202).json(response);
  });

  documentsRouter.get(
    "/",
    validate({ query: listDocumentsQuerySchema }),
    async (req, res) => {
      try {
        await ensureStoreConnected();
      } catch (error) {
        logger.error({ err: error }, "Graph store connection failed");
        return res.status(503).json({ error: "Graph store unavailable" });
      }

      const { page, pageSize, status } = req.query as unknown as z.infer<
        typeof listDocumentsQuerySchema
      >;
      const offset = (page - 1) * pageSize;

      const allDocuments = await store.getDocuments();
      const filtered =
        status === undefined
          ? allDocuments
          : allDocuments.filter((document) => document.status === status);
      const documents = filtered.slice(offset, offset + pageSize);

      res.setHeader("x-total-count", String(filtered.length));
      res.setHeader("x-page", String(page));
      res.setHeader("x-page-size", String(pageSize));

      const response: ListDocumentsResponse = { documents };
      return res.json(response);
    }
  );

  documentsRouter.get(
    "/:id",
    validate({ params: documentParamsSchema }),
    async (req, res) => {
      try {
        await ensureStoreConnected();
      } catch (error) {
        logger.error({ err: error }, "Graph store connection failed");
        return res.status(503).json({ error: "Graph store unavailable" });
      }

      const documentId = req.params.id ?? "";
      const document = await getDocumentById(documentId);
      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      const response: GetDocumentResponse = { document };
      return res.json(response);
    }
  );

  documentsRouter.get(
    "/:id/content",
    validate({ params: documentParamsSchema }),
    async (req, res) => {
      try {
        await ensureStoreConnected();
      } catch (error) {
        logger.error({ err: error }, "Graph store connection failed");
        return res.status(503).json({ error: "Graph store unavailable" });
      }

      const documentId = req.params.id ?? "";
      const document = await getDocumentById(documentId);
      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      const documentUploadDir = resolve(uploadsDir, documentId);
      let fileName: string | null = null;
      try {
        const entries = await readdir(documentUploadDir, { withFileTypes: true });
        fileName = entries.find((e) => e.isFile() && !e.name.startsWith("."))?.name ?? null;
      } catch {
        fileName = null;
      }

      if (!fileName) {
        return res.status(404).json({
          error: "Original uploaded file not found. Please upload the document again."
        });
      }

      try {
        const response: GetDocumentContentResponse = await contentStore.getContent(documentId, {
          filePath: resolve(documentUploadDir, fileName),
          fileType: document.fileType,
        });
        return res.json(response);
      } catch (error) {
        logger.error({ documentId, err: error }, "Failed to load document content");
        return res.status(500).json({ error: "Failed to load document content" });
      }
    }
  );

  documentsRouter.delete(
    "/:id",
    validate({ params: documentParamsSchema }),
    async (req, res) => {
      try {
        await ensureStoreConnected();
      } catch (error) {
        logger.error({ err: error }, "Graph store connection failed");
        return res.status(503).json({ error: "Graph store unavailable" });
      }

      const documentId = req.params.id ?? "";
      const document = await getDocumentById(documentId);
      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      if (jobs.has(documentId)) {
        return res.status(409).json({
          error: "Document is currently being processed and cannot be deleted"
        });
      }

      await store.deleteDocumentAndRelated(documentId);
      await rm(resolve(uploadsDir, documentId), { recursive: true, force: true });
      await rm(resolve(cacheDir, documentId), { recursive: true, force: true });
      statusSnapshots.delete(documentId);

      return res.status(204).send();
    }
  );

  documentsRouter.get(
    "/:id/status",
    validate({ params: documentParamsSchema }),
    async (req, res) => {
      try {
        await ensureStoreConnected();
      } catch (error) {
        logger.error({ err: error }, "Graph store connection failed");
        return res.status(503).json({ error: "Graph store unavailable" });
      }

      const documentId = req.params.id ?? "";
      const snapshot = await getCurrentStatus(documentId);
      if (!snapshot) {
        return res.status(404).json({ error: "Document not found" });
      }

      if (!wantsSse(req)) {
        const response: DocumentStatusResponse = {
          id: snapshot.id,
          status: snapshot.status
        };
        return res.json(response);
      }

      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      sendSseEvent(res, "status", snapshot);
      if (snapshot.status === "completed" || snapshot.status === "error") {
        return res.end();
      }
      const heartbeat = setInterval(() => {
        res.write(": heartbeat\n\n");
      }, 15_000);

      const onStatus = (eventSnapshot: DocumentStatusSnapshot): void => {
        if (eventSnapshot.id !== documentId) {
          return;
        }
        sendSseEvent(res, "status", eventSnapshot);
        if (eventSnapshot.status === "completed" || eventSnapshot.status === "error") {
          clearInterval(heartbeat);
          statusEventBus.off("status", onStatus);
          res.end();
        }
      };

      statusEventBus.on("status", onStatus);
      req.on("close", () => {
        clearInterval(heartbeat);
        statusEventBus.off("status", onStatus);
      });
    }
  );

  documentsRouter.post(
    "/:id/reparse",
    validate({ params: reparseParamsSchema }),
    async (req, res) => {
      try {
        await ensureStoreConnected();
      } catch (error) {
        logger.error({ err: error }, "Graph store connection failed");
        return res.status(503).json({ error: "Graph store unavailable" });
      }

      const documentId = req.params.id ?? "";
      if (jobs.has(documentId)) {
        return res.status(409).json({
          error: "Document is already being processed"
        });
      }

      // Validate body
      const bodyResult = reparseBodySchema.safeParse(req.body);
      if (!bodyResult.success) {
        const firstIssue = bodyResult.error.issues[0];
        // content exceeds MAX_EDITABLE_CHARS → 413
        if (firstIssue?.code === "too_big") {
          return res.status(413).json({
            error: `Content exceeds maximum editable length of ${MAX_EDITABLE_CHARS} characters`
          });
        }
        return res.status(400).json({ error: "Invalid request body", details: bodyResult.error.issues });
      }

      const { content } = bodyResult.data;

      const existing = await getDocumentById(documentId);
      if (!existing) {
        return res.status(404).json({ error: "Document not found" });
      }

      const documentUploadDir = resolve(uploadsDir, documentId);
      let fileName: string | null = null;
      try {
        const entries = await readdir(documentUploadDir, { withFileTypes: true });
        fileName = entries.find((entry) => entry.isFile() && !entry.name.startsWith("."))?.name ?? null;
      } catch {
        fileName = null;
      }

      if (!fileName) {
        return res.status(404).json({
          error: "Original uploaded file not found. Please upload the document again."
        });
      }

      const fileBuffer = await readFile(resolve(documentUploadDir, fileName));
      await rm(resolve(cacheDir, documentId), { recursive: true, force: true });

      // If content provided, write sidecar and pass rawText + forceRebuild to pipeline
      let pipelineOptions: { rawText?: string; forceRebuild?: boolean } | undefined;
      if (content !== undefined) {
        await contentStore.writeSidecar(documentId, content);
        pipelineOptions = { rawText: content, forceRebuild: true };
      }

      const reparseDocument: Document = {
        id: existing.id,
        filename: existing.filename,
        fileType: existing.fileType,
        fileSize: existing.fileSize,
        status: "uploading",
        uploadedAt: existing.uploadedAt,
        metadata: {}
      };

      await store.saveDocument(reparseDocument);
      rememberStatus({
        id: documentId,
        status: "uploading",
        progress: 0,
        updatedAt: new Date().toISOString()
      });
      runPipelineInBackground(reparseDocument, fileBuffer, pipelineOptions);

      const response: ReparseDocumentResponse = {
        message: "Reparse job queued",
        id: documentId
      };
      return res.status(202).json(response);
    }
  );

  // T10: Document preview endpoint
  documentsRouter.get(
    "/:id/preview",
    validate({ params: documentParamsSchema }),
    async (req, res) => {
      try {
        await ensureStoreConnected();
      } catch (error) {
        logger.error({ err: error }, "Graph store connection failed");
        return res.status(503).json({ error: "Graph store unavailable" });
      }

      const documentId = req.params.id ?? "";
      const document = await getDocumentById(documentId);
      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      const chunks = await store.getChunksByDocument(documentId);
      const previewChunks = chunks
        .sort((a, b) => a.index - b.index)
        .slice(0, 3);

      let preview = previewChunks.map((c) => c.content).join("\n\n");
      if (preview.length > 5000) {
        preview = preview.slice(0, 5000) + "\n…（已截断）";
      }

      return res.json({ documentId, preview });
    }
  );

  return documentsRouter;
}

export const documentsRouter = createDocumentsRouter();
