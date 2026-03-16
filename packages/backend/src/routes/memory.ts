import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import type {
  FactReviewStatus,
  FactValueType,
  MemoryEntry,
  MemoryEntryCreateMetadata,
  MemoryEntryFact,
  MemoryEntrySearchFilters,
  MemoryEntrySearchQuery,
  MemoryEntryStoreLike,
  MemoryEntryUpdateMetadata,
  MemoryEntryUpsertFactInput,
  MemoryFact,
  MemoryServiceLike,
  MemorySourceType
} from "@graphen/shared";
import type { Pool } from "pg";
import { appConfig } from "../config.js";
import { validate } from "../middleware/validator.js";
import {
  buildMemoryExtractionUserPrompt,
  MEMORY_EXTRACTION_SYSTEM_PROMPT
} from "../prompts/memoryPrompt.js";
import { getLLMServiceSingleton, getNeo4jSyncTarget } from "../runtime/graphRuntime.js";
import { getPgPoolSingleton } from "../runtime/PgPool.js";
import { graphSyncEnabled } from "../runtime/runtimeMode.js";
import { syncFactsToNeo4jInline, deleteFactsFromNeo4jInline } from "../utils/syncFactsToNeo4j.js";
import type { DeleteFactInfo } from "../utils/syncFactsToNeo4j.js";
import { getPgMemoryEntryStoreSingleton } from "../runtime/memoryRuntime.js";
import { applyMemoryFollowupSchema } from "../runtime/pgMemorySchema.js";
import { MemoryService } from "../services/MemoryService.js";
import { buildFallbackTextEmbedding } from "../utils/fallbackEmbedding.js";
import { buildMemoryEvidenceHash } from "../utils/memoryEvidence.js";
import type { LLMServiceLike } from "../services/llmTypes.js";
import { logger } from "../utils/logger.js";
import { recordMemoryOperationalMetric } from "../utils/memoryOperationalMetrics.js";

interface RawExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  valueType?: FactValueType;
  confidence?: number;
}

interface ExtractFactsFromContentResult {
  shouldStore: boolean;
  rejectionReason: string;
  facts: MemoryEntryUpsertFactInput[];
}

interface CategoryRow {
  name: string;
  description: string | null;
  count: number;
}

interface EntryIdRow {
  id: string;
}

interface AccessLogRow {
  id: string;
  entry_id: string;
  fact_id: string | null;
  chat_session_id: string;
  accessed_at: string;
  access_type: string;
}

interface CountKeyRow {
  key: string;
  count: number;
}

interface FactCompatRow {
  id: string;
  entry_id: string;
  subject_node_id: string | null;
  subject_text: string;
  predicate: string;
  object_node_id: string | null;
  object_text: string | null;
  value_type: FactValueType;
  normalized_fact_key: string;
  confidence: number;
  fact_state: "active" | "deleted";
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  neo4j_synced: boolean;
  neo4j_synced_at: string | null;
  neo4j_retry_count: number;
  neo4j_last_error: string | null;
  review_status: FactReviewStatus;
  review_note: string | null;
}

interface CompatUsageMetricRow {
  metric_date: string;
  endpoint: string;
  method: string;
  caller: string;
  hits: number;
  blocked_hits: number;
}

interface RewriteJobRow {
  id: string;
  entry_id: string;
  entry_revision: number;
  status: "pending" | "running" | "succeeded" | "failed" | "dead";
  trigger_reason: string;
  attempts: number;
  max_attempts: number;
  next_retry_at: string;
  old_content: string | null;
  new_content: string | null;
  model: string | null;
  confidence: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface RewriteEligibilityRow {
  content_revision: number;
  review_status: FactReviewStatus;
  active_fact_count: number;
}

const factIdParamsSchema = z.object({
  id: z.string().uuid()
});

const entryIdParamsSchema = z.object({
  id: z.string().uuid()
});

const entriesFilterBodySchema = z.object({
  query: z.string().trim().optional(),
  filters: z
    .object({
      states: z.array(z.enum(["active", "paused", "archived", "deleted"])).optional(),
      reviewStatus: z
        .array(z.enum(["auto", "confirmed", "modified", "rejected", "conflicted"]))
        .optional(),
      sourceTypes: z
        .array(z.enum(["document", "chat_user", "chat_assistant", "manual"]))
        .optional(),
      categories: z.array(z.string().min(1)).optional(),
      includeDeleted: z.boolean().optional()
    })
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.enum(["content", "sourceType", "createdAt", "updatedAt", "lastSeenAt"]).default("updatedAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc")
});

const entryMetadataSchema = z.object({
  categories: z.array(z.string().min(1)).optional(),
  sourceType: z.enum(["document", "chat_user", "chat_assistant", "manual"]).optional(),
  state: z.enum(["active", "paused", "archived", "deleted"]).optional(),
  reviewStatus: z.enum(["auto", "confirmed", "modified", "rejected", "conflicted"]).optional(),
  reviewNote: z.string().optional()
});

const entryFactSchema = z.object({
  subjectNodeId: z.string().optional(),
  subjectText: z.string().optional(),
  predicate: z.string().min(1),
  objectNodeId: z.string().optional(),
  objectText: z.string().optional(),
  valueType: z.enum(["entity", "text", "number", "date"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
  factState: z.enum(["active", "deleted"]).optional()
});

const createEntryBodySchema = z.object({
  content: z.string().trim().min(1),
  metadata: entryMetadataSchema.optional(),
  facts: z.array(entryFactSchema).optional(),
  reextract: z.boolean().default(true)
});

const updateEntryBodySchema = z.object({
  content: z.string().trim().min(1),
  metadata: entryMetadataSchema.optional(),
  facts: z.array(entryFactSchema).optional(),
  reextract: z.boolean().default(true),
  replaceFacts: z.boolean().default(true)
});

const batchEntriesBodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
  action: z.enum(["pause", "archive", "resume", "delete", "confirm", "reject"]),
  note: z.string().optional(),
  sync_facts: z.boolean().default(false)
});

const deleteEntriesBodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1)
});

const accessLogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
});

const createAccessLogBodySchema = z.object({
  accessType: z.string().trim().min(1).max(64).default("manual_view"),
  chatSessionId: z.string().trim().min(1).max(200).optional()
});

const relatedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5),
  chatSessionId: z.string().trim().min(1).max(200).optional()
});

const factsQuerySchema = z.object({
  status: z.string().optional(),
  subjectNodeId: z.string().optional(),
  sourceType: z.string().optional(),
  documentId: z.string().optional(),
  chatSessionId: z.string().optional(),
  since: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
});

const createFactBodySchema = z.object({
  subjectNodeId: z.string().min(1),
  predicate: z.string().min(1),
  objectNodeId: z.string().optional(),
  objectText: z.string().optional(),
  valueType: z.enum(["entity", "text", "number", "date"]).default("text")
});

const updateFactBodySchema = z.object({
  predicate: z.string().min(1).optional(),
  objectNodeId: z.string().optional(),
  objectText: z.string().optional(),
  valueType: z.enum(["entity", "text", "number", "date"]).optional(),
  confidence: z.number().min(0).max(1).optional()
});

const reviewFactBodySchema = z.object({
  action: z.enum(["confirm", "reject", "resolve"]),
  note: z.string().optional()
});

const rewriteJobsQuerySchema = z.object({
  entryId: z.string().uuid().optional(),
  status: z.enum(["pending", "running", "succeeded", "failed", "dead"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
});

export interface CreateMemoryRouterOptions {
  entryStore?: MemoryEntryStoreLike;
  service?: MemoryServiceLike;
  llmService?: LLMServiceLike;
  pgPool?: Pool;
}

export function createMemoryRouter(options: CreateMemoryRouterOptions = {}): Router {
  const entryStore = options.entryStore ?? getPgMemoryEntryStoreSingleton();
  const service = options.service ?? new MemoryService(entryStore);
  const pgPool = options.pgPool ?? getPgPoolSingleton();
  const router = Router();
  const compatAllowlist = parseCompatCallerAllowlist(appConfig.MEMORY_FACTS_COMPAT_ALLOWLIST);
  let followupSchemaReady: Promise<void> | null = null;

  const resolveLLMService = (): LLMServiceLike => options.llmService ?? getLLMServiceSingleton();
  const resolveOptionalLLMService = (): LLMServiceLike | undefined => {
    try {
      return resolveLLMService();
    } catch {
      return undefined;
    }
  };

  const ensureFollowupSchema = async (): Promise<void> => {
    if (!followupSchemaReady) {
      followupSchemaReady = applyMemoryFollowupSchema(pgPool).catch((error) => {
        followupSchemaReady = null;
        throw error;
      });
    }
    await followupSchemaReady;
  };

  router.use(async (_req, res, next) => {
    try {
      await ensureFollowupSchema();
      next();
    } catch (error) {
      logger.error({ err: error }, "Failed to ensure memory followup schema");
      res.status(500).json({ error: "Memory followup schema is not ready" });
    }
  });

  router.post(
    "/entries/filter",
    validate({ body: entriesFilterBodySchema }),
    async (req, res) => {
      try {
        const body = req.body as z.infer<typeof entriesFilterBodySchema>;
        const searchInput: MemoryEntrySearchQuery = {
          page: body.page,
          pageSize: body.pageSize,
          sortBy: body.sortBy,
          sortOrder: body.sortOrder
        };
        if (body.query !== undefined) {
          searchInput.query = body.query;
        }
        const filters = toEntrySearchFilters(body.filters);
        if (filters) {
          searchInput.filters = filters;
        }

        const result = await entryStore.searchEntries(searchInput);
        res.setHeader("x-total-count", String(result.total));
        res.setHeader("x-page", String(result.page));
        res.setHeader("x-page-size", String(result.pageSize));
        res.json(result);
      } catch (error) {
        return handleMemoryRouteError(res, error, "Failed to filter memory entries");
      }
    }
  );

  router.post(
    "/entries",
    validate({ body: createEntryBodySchema }),
    async (req, res) => {
      try {
        const body = req.body as z.infer<typeof createEntryBodySchema>;
        const createMetadata = toEntryCreateMetadata(body.metadata);
        if (createMetadata.embedding === undefined) {
          const generatedEmbedding = await maybeGenerateEntryEmbedding(resolveOptionalLLMService(), body.content);
          if (generatedEmbedding && generatedEmbedding.length > 0) {
            createMetadata.embedding = generatedEmbedding;
          }
        }

        let extractedFacts: MemoryEntryUpsertFactInput[] = [];
        let extractionError: string | undefined;
        let extractionRejected = false;
        let extractionRejectionReason = "";
        let upsertResult:
          | {
              created: number;
              updated: number;
            }
          | undefined;
        let upsertedFacts: MemoryEntryFact[] = [];

        if (body.facts && body.facts.length > 0) {
          extractedFacts = mapEntryFactInputs(body.facts);
        } else if (body.reextract) {
          try {
            const extraction = await extractFactsFromContent(resolveLLMService(), body.content);
            extractedFacts = extraction.facts;
            extractionRejected = !extraction.shouldStore;
            extractionRejectionReason = extraction.rejectionReason;
            if (extractionRejected && createMetadata.reviewStatus === undefined) {
              createMetadata.reviewStatus = "rejected";
              if (createMetadata.reviewNote === undefined && extractionRejectionReason.length > 0) {
                createMetadata.reviewNote = extractionRejectionReason;
              }
            }
          } catch (error) {
            extractionError = error instanceof Error ? error.message : String(error);
            logger.warn({ err: error }, "Entry fact extraction failed");
          }
        }

        const entry = await service.createEntry(body.content, createMetadata);

        if (extractedFacts.length > 0) {
          const result = await entryStore.upsertFacts(entry.id, extractedFacts);
          upsertResult = { created: result.created, updated: result.updated };
          upsertedFacts = result.facts;
        }

        if (upsertedFacts.length > 0) {
          // PG 后续操作（evidence + 冲突检测）与 Neo4j 写入并行执行
          const pgFollowupPromise = (async () => {
            await persistEntryFactsEvidence(pgPool, upsertedFacts, {
              sourceType: entry.sourceType,
              excerpt: body.content
            });

            try {
              await detectAndResolveFactConflicts(pgPool, entry.id, upsertedFacts);
            } catch (conflictErr) {
              logger.warn({ err: conflictErr }, "Write-time conflict detection failed (non-fatal)");
            }
          })();

          const neo4jSyncPromise = (async () => {
            if (!graphSyncEnabled()) return;
            const neo4jTarget = getNeo4jSyncTarget();
            if (!neo4jTarget) return;
            try {
              await syncFactsToNeo4jInline(neo4jTarget, upsertedFacts, pgPool);
            } catch (err) {
              logger.warn({ err }, "Inline Neo4j sync failed (GraphSyncWorker will retry)");
            }
          })();

          await Promise.all([pgFollowupPromise, neo4jSyncPromise]);
        }

        const detail = await service.getEntryWithFacts(entry.id);
        if (!detail) {
          return res.status(404).json({ error: "Entry not found after creation" });
        }

        return res.status(201).json({
          entry: detail.entry,
          facts: detail.facts,
          extraction: {
            requested: body.reextract,
            generated: extractedFacts.length,
            upsert: upsertResult,
            rejected: extractionRejected,
            rejectionReason: extractionRejectionReason,
            error: extractionError
          }
        });
      } catch (error) {
        return handleMemoryRouteError(res, error, "Failed to create memory entry");
      }
    }
  );

  router.get(
    "/entries/:id([0-9a-fA-F-]{36})",
    validate({ params: entryIdParamsSchema }),
    async (req, res) => {
      try {
        const entryId = req.params.id ?? "";
        const entry = await entryStore.getEntry(entryId);
        if (!entry) {
          return res.status(404).json({ error: "Entry not found" });
        }
        return res.json(entry);
      } catch (error) {
        return handleMemoryRouteError(res, error, "Failed to get memory entry");
      }
    }
  );

  router.put(
    "/entries/:id([0-9a-fA-F-]{36})",
    validate({ params: entryIdParamsSchema, body: updateEntryBodySchema }),
    async (req, res) => {
      try {
        const entryId = req.params.id ?? "";
        const body = req.body as z.infer<typeof updateEntryBodySchema>;
        const updateMetadata = toEntryUpdateMetadata(body.metadata);
        if (updateMetadata.embedding === undefined) {
          const generatedEmbedding = await maybeGenerateEntryEmbedding(resolveOptionalLLMService(), body.content);
          if (generatedEmbedding && generatedEmbedding.length > 0) {
            updateMetadata.embedding = generatedEmbedding;
          }
        }

        const updated = await service.updateEntry(entryId, body.content, updateMetadata);
        if (!updated) {
          return res.status(404).json({ error: "Entry not found" });
        }

        let extractedFacts: MemoryEntryUpsertFactInput[] | undefined;
        let extractionError: string | undefined;
        let extractionRejected = false;
        let extractionRejectionReason = "";
        let upsertResult:
          | {
              created: number;
              updated: number;
            }
          | undefined;
        let replacedFacts = false;
        let upsertedFacts: MemoryEntryFact[] = [];

        if (body.facts && body.facts.length > 0) {
          extractedFacts = mapEntryFactInputs(body.facts);
        } else if (body.reextract) {
          try {
            const extraction = await extractFactsFromContent(resolveLLMService(), body.content);
            extractedFacts = extraction.facts;
            extractionRejected = !extraction.shouldStore;
            extractionRejectionReason = extraction.rejectionReason;
            if (extractionRejected && updateMetadata.reviewStatus === undefined) {
              updateMetadata.reviewStatus = "rejected";
              if (updateMetadata.reviewNote === undefined && extractionRejectionReason.length > 0) {
                updateMetadata.reviewNote = extractionRejectionReason;
              }
            }
          } catch (error) {
            extractionError = error instanceof Error ? error.message : String(error);
            logger.warn({ err: error, entryId }, "Entry re-extraction failed");
          }
        }

        if (extractedFacts !== undefined) {
          if (body.replaceFacts) {
            await markEntryFactsDeleted(pgPool, entryId);
            replacedFacts = true;
          }
          if (extractedFacts.length > 0) {
            const result = await entryStore.upsertFacts(entryId, extractedFacts);
            upsertResult = { created: result.created, updated: result.updated };
            upsertedFacts = result.facts;
          }
        }

        if (upsertedFacts.length > 0) {
          // PG 后续操作（evidence + 冲突检测）与 Neo4j 写入并行执行
          const pgFollowupPromise = (async () => {
            await persistEntryFactsEvidence(pgPool, upsertedFacts, {
              sourceType: updated.sourceType,
              excerpt: body.content
            });

            try {
              await detectAndResolveFactConflicts(pgPool, entryId, upsertedFacts);
            } catch (conflictErr) {
              logger.warn({ err: conflictErr }, "Write-time conflict detection failed (non-fatal)");
            }
          })();

          const neo4jSyncPromise = (async () => {
            if (!graphSyncEnabled()) return;
            const neo4jTarget = getNeo4jSyncTarget();
            if (!neo4jTarget) return;
            try {
              await syncFactsToNeo4jInline(neo4jTarget, upsertedFacts, pgPool);
            } catch (err) {
              logger.warn({ err }, "Inline Neo4j sync failed (GraphSyncWorker will retry)");
            }
          })();

          await Promise.all([pgFollowupPromise, neo4jSyncPromise]);
        }

        const detail = await service.getEntryWithFacts(entryId);
        if (!detail) {
          return res.status(404).json({ error: "Entry not found after update" });
        }

        return res.json({
          entry: detail.entry,
          facts: detail.facts,
          extraction: {
            requested: body.reextract,
            replacedFacts,
            generated: extractedFacts?.length ?? 0,
            upsert: upsertResult,
            rejected: extractionRejected,
            rejectionReason: extractionRejectionReason,
            error: extractionError
          }
        });
      } catch (error) {
        return handleMemoryRouteError(res, error, "Failed to update memory entry");
      }
    }
  );

  router.post(
    "/entries/batch",
    validate({ body: batchEntriesBodySchema }),
    async (req, res) => {
      try {
        const body = req.body as z.infer<typeof batchEntriesBodySchema>;
        const ids = dedupeStrings(body.ids);
        if (ids.length === 0) {
          return res.status(400).json({ error: "ids must not be empty" });
        }

        let affected = 0;
        switch (body.action) {
          case "pause":
            affected = await entryStore.updateEntryState(ids, "paused", "entries-batch");
            break;
          case "archive":
            affected = await entryStore.updateEntryState(ids, "archived", "entries-batch");
            break;
          case "resume":
            affected = await entryStore.updateEntryState(ids, "active", "entries-batch");
            break;
          case "delete": {
            // 先查出即将删除的 entries 关联的 active facts
            const factsSnapshot = await queryActiveFactsForEntries(pgPool, ids);
            affected = await entryStore.deleteEntries(ids);
            // 内联清理 Neo4j
            if (factsSnapshot.length > 0 && graphSyncEnabled()) {
              const neo4jTarget = getNeo4jSyncTarget();
              if (neo4jTarget) {
                try {
                  await deleteFactsFromNeo4jInline(neo4jTarget, factsSnapshot, pgPool);
                } catch (err) {
                  logger.warn({ err }, "Inline Neo4j delete after batch entry delete failed (Worker will retry)");
                }
              }
            }
            break;
          }
          case "confirm":
          case "reject":
            affected = await applyEntryReviewBatch(
              pgPool,
              ids,
              body.action === "confirm" ? "confirmed" : "rejected",
              body.note,
              body.sync_facts
            );
            break;
          default:
            return res.status(400).json({ error: "Unsupported batch action" });
        }

        if (body.action === "confirm" && affected > 0) {
          for (const entryId of ids) {
            try {
              await maybeEnqueueEntryRewriteJob(pgPool, entryId, "entries_batch_confirm");
            } catch (error) {
              logger.warn({ err: error, entryId }, "Failed to enqueue rewrite job after batch confirm");
            }
          }
        }

        return res.json({
          action: body.action,
          affected,
          sync_facts: body.sync_facts
        });
      } catch (error) {
        return handleMemoryRouteError(res, error, "Failed to execute memory entry batch action");
      }
    }
  );

  router.delete(
    "/entries",
    validate({ body: deleteEntriesBodySchema }),
    async (req, res) => {
      try {
        const body = req.body as z.infer<typeof deleteEntriesBodySchema>;
        const ids = dedupeStrings(body.ids);
        if (ids.length === 0) {
          return res.status(400).json({ error: "ids must not be empty" });
        }

        // 先查出即将删除的 entries 关联的 active facts
        const factsSnapshot = await queryActiveFactsForEntries(pgPool, ids);

        const affected = await entryStore.deleteEntries(ids);

        // 内联清理 Neo4j 中的对应边和孤儿节点
        if (factsSnapshot.length > 0 && graphSyncEnabled()) {
          const neo4jTarget = getNeo4jSyncTarget();
          if (neo4jTarget) {
            try {
              await deleteFactsFromNeo4jInline(neo4jTarget, factsSnapshot, pgPool);
            } catch (err) {
              logger.warn({ err }, "Inline Neo4j delete after entry delete failed (Worker will retry)");
            }
          }
        }

        return res.json({ affected });
      } catch (error) {
        return handleMemoryRouteError(res, error, "Failed to delete memory entries");
      }
    }
  );

  router.get(
    "/entries/:id([0-9a-fA-F-]{36})/facts",
    validate({ params: entryIdParamsSchema }),
    async (req, res) => {
      try {
        const entryId = req.params.id ?? "";
        const entry = await entryStore.getEntry(entryId);
        if (!entry) {
          return res.status(404).json({ error: "Entry not found" });
        }
        const facts = await entryStore.getEntryFacts(entryId);
        return res.json(facts);
      } catch (error) {
        return handleMemoryRouteError(res, error, "Failed to get entry facts");
      }
    }
  );

  router.get(
    "/entries/:id([0-9a-fA-F-]{36})/access-log",
    validate({ params: entryIdParamsSchema, query: accessLogQuerySchema }),
    async (req, res) => {
      try {
        const entryId = req.params.id ?? "";
        const query = req.query as unknown as z.infer<typeof accessLogQuerySchema>;

        const entry = await entryStore.getEntry(entryId);
        if (!entry) {
          return res.status(404).json({ error: "Entry not found" });
        }

        const offset = (query.page - 1) * query.pageSize;
        const totalResult = await pgPool.query<{ total: number }>(
          `
            SELECT COUNT(*)::int AS total
            FROM memory_access_logs
            WHERE entry_id = $1::uuid
          `,
          [entryId]
        );
        const total = totalResult.rows[0]?.total ?? 0;

        const rows = await pgPool.query<AccessLogRow>(
          `
            SELECT
              id,
              entry_id,
              fact_id,
              chat_session_id,
              accessed_at,
              access_type
            FROM memory_access_logs
            WHERE entry_id = $1::uuid
            ORDER BY accessed_at DESC
            LIMIT $2
            OFFSET $3
          `,
          [entryId, query.pageSize, offset]
        );

        res.setHeader("x-total-count", String(total));
        res.setHeader("x-page", String(query.page));
        res.setHeader("x-page-size", String(query.pageSize));
        return res.json({
          logs: rows.rows,
          total,
          page: query.page,
          pageSize: query.pageSize
        });
      } catch (error) {
        return handleMemoryRouteError(res, error, "Failed to get entry access logs");
      }
    }
  );

  router.post(
    "/entries/:id([0-9a-fA-F-]{36})/access-log",
    validate({ params: entryIdParamsSchema, body: createAccessLogBodySchema }),
    async (req, res) => {
      try {
        const entryId = req.params.id ?? "";
        const body = req.body as z.infer<typeof createAccessLogBodySchema>;
        const entry = await entryStore.getEntry(entryId);
        if (!entry) {
          return res.status(404).json({ error: "Entry not found" });
        }

        const chatSessionId = body.chatSessionId ?? "ui:memory-weaving";
        await recordAccessLogs(
          pgPool,
          [entryId],
          chatSessionId,
          body.accessType
        );

        return res.status(201).json({
          entryId,
          accessType: body.accessType,
          chatSessionId,
          recorded: 1
        });
      } catch (error) {
        return handleMemoryRouteError(res, error, "Failed to record entry access log");
      }
    }
  );

  router.get(
    "/entries/:id([0-9a-fA-F-]{36})/related",
    validate({ params: entryIdParamsSchema, query: relatedQuerySchema }),
    async (req, res) => {
      try {
        const entryId = req.params.id ?? "";
        const query = req.query as unknown as z.infer<typeof relatedQuerySchema>;
        const entry = await entryStore.getEntry(entryId);
        if (!entry) {
          return res.status(404).json({ error: "Entry not found" });
        }

        const relatedIdsResult = await pgPool.query<EntryIdRow>(
          `
            SELECT e2.id
            FROM memory_entries e2
            JOIN memory_facts f2
              ON f2.entry_id = e2.id
             AND f2.deleted_at IS NULL
             AND f2.fact_state = 'active'
            WHERE e2.id <> $1::uuid
              AND e2.deleted_at IS NULL
              AND e2.state = 'active'
              AND EXISTS (
                SELECT 1
                FROM memory_facts f1
                WHERE f1.entry_id = $1::uuid
                  AND f1.deleted_at IS NULL
                  AND f1.fact_state = 'active'
                  AND (
                    (
                      f1.subject_node_id IS NOT NULL
                      AND f1.subject_node_id <> ''
                      AND f1.subject_node_id = f2.subject_node_id
                    )
                    OR (
                      (f1.subject_node_id IS NULL OR f1.subject_node_id = '')
                      AND (f2.subject_node_id IS NULL OR f2.subject_node_id = '')
                      AND lower(trim(f1.subject_text)) = lower(trim(f2.subject_text))
                    )
                  )
              )
            GROUP BY e2.id, e2.updated_at
            ORDER BY COUNT(*) DESC, MAX(e2.updated_at) DESC
            LIMIT $2
          `,
          [entryId, query.limit]
        );

        const relatedEntries = await hydrateEntriesById(entryStore, relatedIdsResult.rows.map((row) => row.id));
        const seenIds = new Set(relatedEntries.map((item) => item.id));

        if (relatedEntries.length < query.limit && entry.embedding && entry.embedding.length > 0) {
          const candidates = await entryStore.searchEntriesByVector(
            entry.embedding,
            Math.max(10, query.limit * 3)
          );
          for (const candidate of candidates) {
            if (candidate.id === entryId) {
              continue;
            }
            if (seenIds.has(candidate.id)) {
              continue;
            }
            seenIds.add(candidate.id);
            relatedEntries.push(candidate);
            if (relatedEntries.length >= query.limit) {
              break;
            }
          }
        }

        if (query.chatSessionId && relatedEntries.length > 0) {
          await recordAccessLogs(
            pgPool,
            relatedEntries.map((item) => item.id),
            query.chatSessionId,
            "related_memory"
          );
        }

        return res.json(relatedEntries.slice(0, query.limit));
      } catch (error) {
        return handleMemoryRouteError(res, error, "Failed to get related memory entries");
      }
    }
  );

  router.get("/categories", async (_req, res) => {
    try {
      const result = await pgPool.query<CategoryRow>(
        `
          WITH entry_categories AS (
            SELECT
              cat AS name,
              COUNT(*)::int AS count
            FROM (
              SELECT unnest(categories) AS cat
              FROM memory_entries
              WHERE deleted_at IS NULL
            ) t
            WHERE cat IS NOT NULL
              AND cat <> ''
            GROUP BY cat
          ),
          category_rows AS (
            SELECT
              c.name,
              c.description,
              COALESCE(ec.count, 0)::int AS count
            FROM memory_categories c
            LEFT JOIN entry_categories ec
              ON ec.name = c.name
          ),
          entry_only_rows AS (
            SELECT
              ec.name,
              NULL::text AS description,
              ec.count
            FROM entry_categories ec
            WHERE NOT EXISTS (
              SELECT 1
              FROM memory_categories c
              WHERE c.name = ec.name
            )
          )
          SELECT name, description, count
          FROM category_rows
          UNION ALL
          SELECT name, description, count
          FROM entry_only_rows
          ORDER BY count DESC, name ASC
        `
      );

      return res.json({
        categories: result.rows
      });
    } catch (error) {
      return handleMemoryRouteError(res, error, "Failed to get memory categories");
    }
  });

  router.get("/stats", async (_req, res) => {
    try {
      const [totalResult, reviewRows, sourceRows, stateRows] = await Promise.all([
        pgPool.query<{ total: number }>(
          `
            SELECT COUNT(*)::int AS total
            FROM memory_entries
            WHERE deleted_at IS NULL
          `
        ),
        pgPool.query<CountKeyRow>(
          `
            SELECT review_status AS key, COUNT(*)::int AS count
            FROM memory_entries
            WHERE deleted_at IS NULL
            GROUP BY review_status
            ORDER BY count DESC, review_status ASC
          `
        ),
        pgPool.query<CountKeyRow>(
          `
            SELECT source_type AS key, COUNT(*)::int AS count
            FROM memory_entries
            WHERE deleted_at IS NULL
            GROUP BY source_type
            ORDER BY count DESC, source_type ASC
          `
        ),
        pgPool.query<CountKeyRow>(
          `
            SELECT state AS key, COUNT(*)::int AS count
            FROM memory_entries
            WHERE deleted_at IS NULL
            GROUP BY state
            ORDER BY count DESC, state ASC
          `
        )
      ]);

      return res.json({
        total: totalResult.rows[0]?.total ?? 0,
        byReviewStatus: rowsToCountMap(reviewRows.rows),
        bySourceType: rowsToCountMap(sourceRows.rows),
        byState: rowsToCountMap(stateRows.rows)
      });
    } catch (error) {
      return handleMemoryRouteError(res, error, "Failed to get memory stats");
    }
  });

  router.get("/compat/facts-usage-baseline", async (_req, res) => {
    try {
      const rows = await pgPool.query<CompatUsageMetricRow>(
        `
          SELECT
            metric_date::text,
            endpoint,
            method,
            caller,
            SUM(hit_count)::int AS hits,
            SUM(CASE WHEN blocked THEN hit_count ELSE 0 END)::int AS blocked_hits
          FROM memory_fact_compat_metrics
          WHERE metric_date >= (CURRENT_DATE - 13)
          GROUP BY metric_date, endpoint, method, caller
          ORDER BY metric_date DESC, hits DESC
        `
      );

      const totalHits = rows.rows.reduce((acc, row) => acc + row.hits, 0);
      const externalHits = rows.rows
        .filter((row) => !compatAllowlist.has(row.caller))
        .reduce((acc, row) => acc + row.hits, 0);

      return res.json({
        windowDays: 14,
        compatStage: appConfig.MEMORY_FACTS_COMPAT_STAGE,
        migrationReady: externalHits === 0,
        totalHits,
        externalHits,
        records: rows.rows
      });
    } catch (error) {
      return handleMemoryRouteError(res, error, "Failed to get facts compatibility usage baseline");
    }
  });

  const factsRouter = Router();

  factsRouter.get(
    "/",
    validate({ query: factsQuerySchema }),
    async (req, res) => {
      try {
        const q = req.query as unknown as z.infer<typeof factsQuerySchema>;
        const reviewStatus = q.status
          ? (q.status.split(",").filter(Boolean) as FactReviewStatus[])
          : undefined;

        const conditions: string[] = [
          "f.deleted_at IS NULL",
          "f.fact_state = 'active'",
          "e.deleted_at IS NULL"
        ];
        const params: unknown[] = [];

        if (q.subjectNodeId) {
          params.push(q.subjectNodeId);
          conditions.push(`f.subject_node_id = $${params.length}`);
        }
        if (reviewStatus && reviewStatus.length > 0) {
          params.push(reviewStatus);
          conditions.push(`e.review_status = ANY($${params.length}::text[])`);
        }
        if (q.sourceType) {
          params.push(q.sourceType as MemorySourceType);
          conditions.push(`e.source_type = $${params.length}`);
        }
        if (q.since) {
          params.push(q.since);
          conditions.push(`f.updated_at >= $${params.length}::timestamptz`);
        }
        if (q.documentId) {
          params.push(q.documentId);
          conditions.push(
            `EXISTS (
              SELECT 1
              FROM memory_evidence ev
              WHERE ev.fact_id = f.id
                AND ev.document_id = $${params.length}
            )`
          );
        }
        if (q.chatSessionId) {
          params.push(q.chatSessionId);
          conditions.push(
            `EXISTS (
              SELECT 1
              FROM memory_evidence ev
              WHERE ev.fact_id = f.id
                AND ev.chat_session_id = $${params.length}
            )`
          );
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const offset = (q.page - 1) * q.pageSize;
        const countResult = await pgPool.query<{ total: number }>(
          `
            SELECT COUNT(*)::int AS total
            FROM memory_facts f
            JOIN memory_entries e
              ON e.id = f.entry_id
            ${whereClause}
          `,
          params
        );
        const total = countResult.rows[0]?.total ?? 0;

        const pageParams = [...params, q.pageSize, offset];
        const dataResult = await pgPool.query<FactCompatRow>(
          `
            SELECT
              f.id,
              f.entry_id,
              f.subject_node_id,
              f.subject_text,
              f.predicate,
              f.object_node_id,
              f.object_text,
              f.value_type,
              f.normalized_fact_key,
              f.confidence,
              f.fact_state,
              f.created_at,
              f.updated_at,
              f.deleted_at,
              f.neo4j_synced,
              f.neo4j_synced_at,
              f.neo4j_retry_count,
              f.neo4j_last_error,
              e.review_status,
              e.review_note
            FROM memory_facts f
            JOIN memory_entries e
              ON e.id = f.entry_id
            ${whereClause}
            ORDER BY f.updated_at DESC, f.created_at DESC
            LIMIT $${params.length + 1}
            OFFSET $${params.length + 2}
          `,
          pageParams
        );

        res.setHeader("x-total-count", String(total));
        res.setHeader("x-page", String(q.page));
        res.setHeader("x-page-size", String(q.pageSize));
        return res.json(dataResult.rows.map(mapCompatFactRow));
      } catch (error) {
        return handleMemoryRouteError(res, error, "Failed to list memory facts");
      }
    }
  );

  factsRouter.post(
    "/",
    validate({ body: createFactBodySchema }),
    async (req, res) => {
      try {
        const body = req.body as z.infer<typeof createFactBodySchema>;
        const entry = await service.createEntry(
          `${body.subjectNodeId} ${body.predicate} ${body.objectText ?? body.objectNodeId ?? ""}`.trim(),
          {
            sourceType: "manual",
            reviewStatus: "confirmed"
          }
        );

        const input: MemoryEntryUpsertFactInput = {
          subjectNodeId: body.subjectNodeId,
          subjectText: body.subjectNodeId,
          predicate: body.predicate,
          valueType: body.valueType,
          confidence: 1
        };
        if (body.objectNodeId) {
          input.objectNodeId = body.objectNodeId;
        }
        if (body.objectText) {
          input.objectText = body.objectText;
        }

        const result = await entryStore.upsertFacts(entry.id, [input]);

        // rewrite job + 冲突检测与 Neo4j 内联同步并行执行
        const pgFollowupPromise = (async () => {
          await maybeEnqueueEntryRewriteJob(pgPool, entry.id, "fact_create");
          try {
            await detectAndResolveFactConflicts(pgPool, entry.id, result.facts);
          } catch (conflictErr) {
            logger.warn({ err: conflictErr }, "Write-time conflict detection failed (non-fatal)");
          }
        })();

        const neo4jSyncPromise = (async () => {
          if (!graphSyncEnabled()) return;
          const neo4jTarget = getNeo4jSyncTarget();
          if (!neo4jTarget) return;
          try {
            await syncFactsToNeo4jInline(neo4jTarget, result.facts, pgPool);
          } catch (err) {
            logger.warn({ err }, "Inline Neo4j sync failed (GraphSyncWorker will retry)");
          }
        })();

        await Promise.all([pgFollowupPromise, neo4jSyncPromise]);

        const createdFact = result.facts[0];
        if (!createdFact) {
          return res.status(201).json({ merged: true });
        }

        const fact = await fetchCompatFactById(pgPool, createdFact.id);
        if (!fact) {
          return res.status(201).json({ merged: true });
        }
        return res.status(201).json(fact);
      } catch (error) {
        return handleMemoryRouteError(res, error, "Failed to create memory fact");
      }
    }
  );

  factsRouter.patch(
    "/:id",
    validate({ params: factIdParamsSchema, body: updateFactBodySchema }),
    async (req, res) => {
      try {
        const { id } = req.params as z.infer<typeof factIdParamsSchema>;
        const body = req.body as z.infer<typeof updateFactBodySchema>;
        const existingRow = await pgPool.query<{
          id: string;
          entry_id: string;
          subject_node_id: string | null;
          subject_text: string;
          predicate: string;
          object_node_id: string | null;
          object_text: string | null;
          value_type: FactValueType;
          confidence: number;
        }>(
          `
            SELECT
              id,
              entry_id,
              subject_node_id,
              subject_text,
              predicate,
              object_node_id,
              object_text,
              value_type,
              confidence
            FROM memory_facts
            WHERE id = $1::uuid
              AND deleted_at IS NULL
            LIMIT 1
          `,
          [id]
        );
        const existing = existingRow.rows[0];
        if (!existing) {
          return res.status(404).json({ error: "Fact not found" });
        }

        const nextPredicate = body.predicate ?? existing.predicate;
        const nextObjectNodeId = body.objectNodeId === undefined
          ? existing.object_node_id
          : (body.objectNodeId || null);
        const nextObjectText = body.objectText === undefined
          ? existing.object_text
          : (body.objectText || null);
        const nextValueType = body.valueType ?? existing.value_type;
        const nextConfidence = body.confidence ?? existing.confidence;
        const normalizedFactKey = buildNormalizedFactKey({
          subjectText: existing.subject_text,
          predicate: nextPredicate,
          objectNodeId: nextObjectNodeId,
          objectText: nextObjectText,
          ...(existing.subject_node_id ? { subjectNodeId: existing.subject_node_id } : {})
        });

        await pgPool.query(
          `
            UPDATE memory_facts
            SET predicate = $2,
                object_node_id = $3,
                object_text = $4,
                value_type = $5,
                confidence = $6,
                normalized_fact_key = $7,
                updated_at = NOW(),
                neo4j_synced = FALSE,
                neo4j_synced_at = NULL
            WHERE id = $1::uuid
          `,
          [id, nextPredicate, nextObjectNodeId, nextObjectText, nextValueType, nextConfidence, normalizedFactKey]
        );

        await pgPool.query(
          `
            UPDATE memory_entries
            SET review_status = 'modified',
                updated_at = NOW()
            WHERE id = $1::uuid
              AND deleted_at IS NULL
          `,
          [existing.entry_id]
        );
        await maybeEnqueueEntryRewriteJob(pgPool, existing.entry_id, "fact_update");

        // 内联同步更新到 Neo4j（更新 = 重新 MERGE，会覆盖旧值）
        if (graphSyncEnabled()) {
          const neo4jTarget = getNeo4jSyncTarget();
          if (neo4jTarget) {
            try {
              const syncRow = await pgPool.query<{
                id: string;
                entry_id: string;
                subject_node_id: string | null;
                subject_text: string;
                predicate: string;
                object_node_id: string | null;
                object_text: string | null;
                value_type: FactValueType;
                normalized_fact_key: string;
                confidence: number;
                fact_state: "active" | "deleted";
                created_at: string;
                updated_at: string;
              }>(
                `
                  SELECT id, entry_id, subject_node_id, subject_text, predicate,
                         object_node_id, object_text, value_type, normalized_fact_key,
                         confidence, fact_state, created_at, updated_at
                  FROM memory_facts
                  WHERE id = $1::uuid
                  LIMIT 1
                `,
                [id]
              );
              const row = syncRow.rows[0];
              if (row) {
                const syncFact: import("@graphen/shared").MemoryEntryFact = {
                  id: row.id,
                  entryId: row.entry_id,
                  subjectText: row.subject_text,
                  predicate: row.predicate,
                  valueType: row.value_type,
                  normalizedFactKey: row.normalized_fact_key,
                  confidence: row.confidence,
                  factState: row.fact_state,
                  createdAt: row.created_at,
                  updatedAt: row.updated_at,
                  neo4jSynced: false,
                  neo4jRetryCount: 0,
                  ...(row.subject_node_id ? { subjectNodeId: row.subject_node_id } : {}),
                  ...(row.object_node_id ? { objectNodeId: row.object_node_id } : {}),
                  ...(row.object_text ? { objectText: row.object_text } : {})
                };
                await syncFactsToNeo4jInline(neo4jTarget, [syncFact], pgPool);
              }
            } catch (err) {
              logger.warn({ err, factId: id }, "Inline Neo4j sync after fact update failed (Worker will retry)");
            }
          }
        }

        const updated = await fetchCompatFactById(pgPool, id);
        if (!updated) {
          return res.status(404).json({ error: "Fact not found" });
        }
        return res.json(updated);
      } catch (error) {
        return handleMemoryRouteError(res, error, "Failed to update memory fact");
      }
    }
  );

  factsRouter.patch(
    "/:id/review",
    validate({ params: factIdParamsSchema, body: reviewFactBodySchema }),
    async (req, res) => {
      try {
        const { id } = req.params as z.infer<typeof factIdParamsSchema>;
        const { action, note } = req.body as z.infer<typeof reviewFactBodySchema>;
        const factRow = await pgPool.query<{ entry_id: string }>(
          `
            SELECT entry_id
            FROM memory_facts
            WHERE id = $1::uuid
              AND deleted_at IS NULL
            LIMIT 1
          `,
          [id]
        );
        const entryId = factRow.rows[0]?.entry_id;
        if (!entryId) {
          return res.status(404).json({ error: "Fact not found" });
        }

        const reviewStatus: FactReviewStatus = action === "reject"
          ? "rejected"
          : "confirmed";
        await pgPool.query(
          `
            UPDATE memory_entries
            SET review_status = $2,
                review_note = COALESCE($3, review_note),
                updated_at = NOW()
            WHERE id = $1::uuid
              AND deleted_at IS NULL
          `,
          [entryId, reviewStatus, note ?? null]
        );
        await maybeEnqueueEntryRewriteJob(pgPool, entryId, "fact_review");

        const reviewed = await fetchCompatFactById(pgPool, id);
        if (!reviewed) {
          return res.status(404).json({ error: "Fact not found" });
        }
        return res.json(reviewed);
      } catch (error) {
        return handleMemoryRouteError(res, error, "Failed to review memory fact");
      }
    }
  );

  factsRouter.delete(
    "/:id",
    validate({ params: factIdParamsSchema }),
    async (req, res) => {
      try {
        const { id } = req.params as z.infer<typeof factIdParamsSchema>;

        // 先查出 fact 的同步信息，用于后续 Neo4j 清理
        const factInfoResult = await pgPool.query<{
          id: string;
          entry_id: string;
          subject_node_id: string | null;
          subject_text: string;
          normalized_fact_key: string;
        }>(
          `
            SELECT id, entry_id, subject_node_id, subject_text, normalized_fact_key
            FROM memory_facts
            WHERE id = $1::uuid
              AND deleted_at IS NULL
            LIMIT 1
          `,
          [id]
        );
        const factInfo = factInfoResult.rows[0];
        if (!factInfo) {
          return res.status(404).json({ error: "Fact not found" });
        }

        // 软删除 fact
        await pgPool.query(
          `
            UPDATE memory_facts
            SET fact_state = 'deleted',
                deleted_at = COALESCE(deleted_at, NOW()),
                updated_at = NOW(),
                neo4j_synced = FALSE,
                neo4j_synced_at = NULL
            WHERE id = $1::uuid
              AND deleted_at IS NULL
          `,
          [id]
        );

        await pgPool.query(
          `
            UPDATE memory_entries
            SET review_status = 'modified',
                updated_at = NOW()
            WHERE id = $1::uuid
              AND deleted_at IS NULL
          `,
          [factInfo.entry_id]
        );
        await maybeEnqueueEntryRewriteJob(pgPool, factInfo.entry_id, "fact_delete");

        // 内联同步：从 Neo4j 中删除对应的边和孤儿节点
        if (graphSyncEnabled()) {
          const neo4jTarget = getNeo4jSyncTarget();
          if (neo4jTarget) {
            try {
              await deleteFactsFromNeo4jInline(neo4jTarget, [{
                id: factInfo.id,
                entryId: factInfo.entry_id,
                subjectNodeId: factInfo.subject_node_id,
                subjectText: factInfo.subject_text,
                normalizedFactKey: factInfo.normalized_fact_key
              }], pgPool);
            } catch (err) {
              logger.warn({ err, factId: id }, "Inline Neo4j delete failed (Worker will retry)");
            }
          }
        }

        return res.status(204).send();
      } catch (error) {
        return handleMemoryRouteError(res, error, "Failed to delete memory fact");
      }
    }
  );

  factsRouter.get(
    "/:id/evidence",
    validate({ params: factIdParamsSchema }),
    async (req, res) => {
      try {
        const { id } = req.params as z.infer<typeof factIdParamsSchema>;
        const factResult = await pgPool.query<{ id: string }>(
          `
            SELECT id
            FROM memory_facts
            WHERE id = $1::uuid
              AND deleted_at IS NULL
            LIMIT 1
          `,
          [id]
        );
        if (!factResult.rows[0]) {
          return res.status(404).json({ error: "Fact not found" });
        }
        const evidence = await pgPool.query(
          `
            SELECT
              id,
              fact_id AS "factId",
              source_type AS "sourceType",
              document_id AS "documentId",
              chunk_id AS "chunkId",
              chat_session_id AS "chatSessionId",
              chat_message_id AS "chatMessageId",
              excerpt,
              extracted_at AS "extractedAt"
            FROM memory_evidence
            WHERE fact_id = $1::uuid
            ORDER BY extracted_at DESC
          `,
          [id]
        );
        return res.json(evidence.rows);
      } catch (error) {
        return handleMemoryRouteError(res, error, "Failed to get evidence");
      }
    }
  );

  router.use("/entries/facts", factsRouter);

  if (appConfig.MEMORY_FACTS_COMPAT_STAGE !== "stage3") {
    router.use("/facts", async (req, res, next) => {
      const caller = resolveCompatCaller(req);
      const compatStage = appConfig.MEMORY_FACTS_COMPAT_STAGE;
      const blocked = compatStage === "stage2" && !compatAllowlist.has(caller);

      res.setHeader("Deprecation", "true");
      res.setHeader("Link", '</api/memory/entries/facts>; rel="successor-version"');
      res.setHeader("Sunset", "Wed, 30 Sep 2026 00:00:00 GMT");
      res.setHeader("X-Memory-Facts-Compat-Stage", compatStage);

      const endpoint = `/api/memory/facts${req.path === "/" ? "" : req.path}`;
      try {
        await recordCompatMetric(pgPool, {
          endpoint,
          method: req.method,
          caller,
          stage: compatStage,
          blocked
        });
      } catch (error) {
        logger.warn({ err: error, endpoint, caller }, "Failed to record facts compatibility metric");
      }

      if (blocked) {
        return res.status(410).json({
          error: "Facts compatibility endpoint has been sunset",
          stage: compatStage,
          successor: "/api/memory/entries/facts"
        });
      }

      return next();
    });

    router.use("/facts", factsRouter);
  } else {
    logger.info("Facts compatibility routes disabled at stage3");
  }

  router.get(
    "/rewrite-jobs",
    validate({ query: rewriteJobsQuerySchema }),
    async (req, res) => {
      try {
        const query = req.query as unknown as z.infer<typeof rewriteJobsQuerySchema>;
        const conditions: string[] = [];
        const params: unknown[] = [];
        if (query.entryId) {
          params.push(query.entryId);
          conditions.push(`entry_id = $${params.length}::uuid`);
        }
        if (query.status) {
          params.push(query.status);
          conditions.push(`status = $${params.length}`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const offset = (query.page - 1) * query.pageSize;

        const [countResult, dataResult] = await Promise.all([
          pgPool.query<{ total: number }>(
            `
              SELECT COUNT(*)::int AS total
              FROM entry_rewrite_jobs
              ${whereClause}
            `,
            params
          ),
          pgPool.query<RewriteJobRow>(
            `
              SELECT
                id,
                entry_id,
                entry_revision,
                status,
                trigger_reason,
                attempts,
                max_attempts,
                next_retry_at,
                old_content,
                new_content,
                model,
                confidence,
                last_error,
                created_at,
                updated_at,
                finished_at
              FROM entry_rewrite_jobs
              ${whereClause}
              ORDER BY created_at DESC
              LIMIT $${params.length + 1}
              OFFSET $${params.length + 2}
            `,
            [...params, query.pageSize, offset]
          )
        ]);

        res.setHeader("x-total-count", String(countResult.rows[0]?.total ?? 0));
        res.setHeader("x-page", String(query.page));
        res.setHeader("x-page-size", String(query.pageSize));
        return res.json(dataResult.rows.map(mapRewriteJobRow));
      } catch (error) {
        return handleMemoryRouteError(res, error, "Failed to list rewrite jobs");
      }
    }
  );

  router.post(
    "/rewrite-jobs/:id/retry",
    validate({ params: factIdParamsSchema }),
    async (req, res) => {
      try {
        const { id } = req.params as z.infer<typeof factIdParamsSchema>;
        const retryResult = await pgPool.query<RewriteJobRow>(
          `
            UPDATE entry_rewrite_jobs
            SET status = 'pending',
                next_retry_at = NOW(),
                last_error = NULL,
                updated_at = NOW(),
                finished_at = NULL
            WHERE id = $1::uuid
              AND status IN ('failed', 'dead')
            RETURNING
              id,
              entry_id,
              entry_revision,
              status,
              trigger_reason,
              attempts,
              max_attempts,
              next_retry_at,
              old_content,
              new_content,
              model,
              confidence,
              last_error,
              created_at,
              updated_at,
              finished_at
          `,
          [id]
        );
        const row = retryResult.rows[0];
        if (row) {
          return res.json(mapRewriteJobRow(row));
        }

        const exists = await pgPool.query<{ status: string }>(
          `
            SELECT status
            FROM entry_rewrite_jobs
            WHERE id = $1::uuid
            LIMIT 1
          `,
          [id]
        );
        const status = exists.rows[0]?.status;
        if (!status) {
          return res.status(404).json({ error: "Rewrite job not found" });
        }
        return res.status(409).json({ error: `Rewrite job cannot be retried from status=${status}` });
      } catch (error) {
        return handleMemoryRouteError(res, error, "Failed to retry rewrite job");
      }
    }
  );

  return router;
}

function toEntrySearchFilters(
  input: z.infer<typeof entriesFilterBodySchema>["filters"]
): MemoryEntrySearchFilters | undefined {
  if (!input) {
    return undefined;
  }
  const filters: MemoryEntrySearchFilters = {};
  if (input.states !== undefined) {
    filters.states = input.states;
  }
  if (input.reviewStatus !== undefined) {
    filters.reviewStatus = input.reviewStatus;
  }
  if (input.sourceTypes !== undefined) {
    filters.sourceTypes = input.sourceTypes;
  }
  if (input.categories !== undefined) {
    filters.categories = input.categories;
  }
  if (input.includeDeleted !== undefined) {
    filters.includeDeleted = input.includeDeleted;
  }
  return Object.keys(filters).length > 0 ? filters : undefined;
}

function toEntryCreateMetadata(
  input: z.infer<typeof entryMetadataSchema> | undefined
): MemoryEntryCreateMetadata {
  const metadata: MemoryEntryCreateMetadata = {};
  if (!input) {
    return metadata;
  }
  if (input.categories !== undefined) {
    metadata.categories = input.categories;
  }
  if (input.sourceType !== undefined) {
    metadata.sourceType = input.sourceType;
  }
  if (input.state !== undefined) {
    metadata.state = input.state;
  }
  if (input.reviewStatus !== undefined) {
    metadata.reviewStatus = input.reviewStatus;
  }
  if (input.reviewNote !== undefined) {
    metadata.reviewNote = input.reviewNote;
  }
  return metadata;
}

function toEntryUpdateMetadata(
  input: z.infer<typeof entryMetadataSchema> | undefined
): MemoryEntryUpdateMetadata {
  const metadata: MemoryEntryUpdateMetadata = {};
  if (!input) {
    return metadata;
  }
  if (input.categories !== undefined) {
    metadata.categories = input.categories;
  }
  if (input.sourceType !== undefined) {
    metadata.sourceType = input.sourceType;
  }
  if (input.state !== undefined) {
    metadata.state = input.state;
  }
  if (input.reviewStatus !== undefined) {
    metadata.reviewStatus = input.reviewStatus;
  }
  if (input.reviewNote !== undefined) {
    metadata.reviewNote = input.reviewNote;
  }
  return metadata;
}

function mapEntryFactInputs(
  facts: z.infer<typeof entryFactSchema>[]
): MemoryEntryUpsertFactInput[] {
  return facts.map((fact) => {
    const mapped: MemoryEntryUpsertFactInput = {
      predicate: fact.predicate
    };
    if (fact.subjectNodeId !== undefined) {
      mapped.subjectNodeId = fact.subjectNodeId;
    }
    if (fact.subjectText !== undefined) {
      mapped.subjectText = fact.subjectText;
    }
    if (fact.objectNodeId !== undefined) {
      mapped.objectNodeId = fact.objectNodeId;
    }
    if (fact.objectText !== undefined) {
      mapped.objectText = fact.objectText;
    }
    if (fact.valueType !== undefined) {
      mapped.valueType = fact.valueType;
    }
    if (fact.confidence !== undefined) {
      mapped.confidence = fact.confidence;
    }
    if (fact.factState !== undefined) {
      mapped.factState = fact.factState;
    }
    return mapped;
  });
}

async function extractFactsFromContent(
  llmService: LLMServiceLike,
  content: string
): Promise<ExtractFactsFromContentResult> {
  const prompt = buildMemoryExtractionUserPrompt(content);
  let rawResponse = "";

  for await (const delta of llmService.chatCompletion(
    [
      {
        id: "",
        sessionId: "",
        role: "user",
        content: prompt,
        createdAt: new Date()
      }
    ],
    {
      graphContext: MEMORY_EXTRACTION_SYSTEM_PROMPT,
      retrievedChunks: ""
    }
  )) {
    rawResponse += delta;
  }

  const match = rawResponse.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      shouldStore: true,
      rejectionReason: "",
      facts: []
    };
  }

  const parsed = JSON.parse(match[0]) as {
    should_store?: boolean;
    rejection_reason?: string;
    facts?: unknown[];
  };
  const shouldStore = parsed.should_store !== false;
  const rejectionReason = typeof parsed.rejection_reason === "string"
    ? parsed.rejection_reason.trim()
    : "";
  if (!Array.isArray(parsed.facts)) {
    return {
      shouldStore,
      rejectionReason,
      facts: []
    };
  }

  const facts: MemoryEntryUpsertFactInput[] = [];
  for (const item of parsed.facts) {
    const raw = item as Partial<RawExtractedFact>;
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof raw.subject !== "string" ||
      typeof raw.predicate !== "string" ||
      typeof raw.object !== "string"
    ) {
      continue;
    }

    const subjectText = raw.subject.trim();
    const predicate = raw.predicate.trim();
    const objectText = raw.object.trim();
    if (!subjectText || !predicate || !objectText) {
      continue;
    }

    const valueType = normalizeValueType(raw.valueType);
    const confidence = clampConfidence(raw.confidence ?? 0.7);
    facts.push({
      subjectText,
      predicate,
      objectText,
      valueType,
      confidence,
      factState: "active"
    });
  }

  return {
    shouldStore,
    rejectionReason,
    facts
  };
}

async function maybeGenerateEntryEmbedding(
  llmService: LLMServiceLike | undefined,
  content: string
): Promise<number[] | undefined> {
  const fallback = buildFallbackTextEmbedding(content);

  if (!llmService) {
    return fallback.length > 0 ? fallback : undefined;
  }

  try {
    const embedding = await llmService.generateEmbedding(content);
    if (
      Array.isArray(embedding)
      && embedding.length === appConfig.EMBEDDING_DIMENSIONS
      && embedding.every((value) => Number.isFinite(value))
    ) {
      return embedding;
    }
  } catch (error) {
    logger.warn({ err: error }, "Failed to generate memory entry embedding");
  }

  return fallback.length > 0 ? fallback : undefined;
}

function normalizeValueType(value: unknown): FactValueType {
  if (value === "entity" || value === "text" || value === "number" || value === "date") {
    return value;
  }
  return "text";
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.7;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

async function markEntryFactsDeleted(pgPool: Pool, entryId: string): Promise<void> {
  // 先查出即将删除的 facts 的同步信息
  const factsInfoResult = await pgPool.query<{
    id: string;
    entry_id: string;
    subject_node_id: string | null;
    subject_text: string;
    normalized_fact_key: string;
  }>(
    `
      SELECT id, entry_id, subject_node_id, subject_text, normalized_fact_key
      FROM memory_facts
      WHERE entry_id = $1::uuid
        AND deleted_at IS NULL
    `,
    [entryId]
  );

  // 软删除 facts
  await pgPool.query(
    `
      UPDATE memory_facts
      SET fact_state = 'deleted',
          deleted_at = COALESCE(deleted_at, NOW()),
          updated_at = NOW(),
          neo4j_synced = FALSE,
          neo4j_synced_at = NULL
      WHERE entry_id = $1::uuid
        AND deleted_at IS NULL
    `,
    [entryId]
  );

  // 内联同步：从 Neo4j 中删除对应的边和孤儿节点
  if (factsInfoResult.rows.length > 0 && graphSyncEnabled()) {
    const neo4jTarget = getNeo4jSyncTarget();
    if (neo4jTarget) {
      const deleteInfos: DeleteFactInfo[] = factsInfoResult.rows.map((row) => ({
        id: row.id,
        entryId: row.entry_id,
        subjectNodeId: row.subject_node_id,
        subjectText: row.subject_text,
        normalizedFactKey: row.normalized_fact_key
      }));
      try {
        await deleteFactsFromNeo4jInline(neo4jTarget, deleteInfos, pgPool);
      } catch (err) {
        logger.warn({ err, entryId }, "Inline Neo4j delete for entry facts failed (Worker will retry)");
      }
    }
  }
}

/**
 * 查询指定 entry IDs 关联的所有 active facts 的同步信息。
 * 用于在 entry 删除前快照 facts 信息，以便后续清理 Neo4j。
 */
async function queryActiveFactsForEntries(pgPool: Pool, entryIds: string[]): Promise<DeleteFactInfo[]> {
  if (entryIds.length === 0) {
    return [];
  }

  const result = await pgPool.query<{
    id: string;
    entry_id: string;
    subject_node_id: string | null;
    subject_text: string;
    normalized_fact_key: string;
  }>(
    `
      SELECT id, entry_id, subject_node_id, subject_text, normalized_fact_key
      FROM memory_facts
      WHERE entry_id = ANY($1::uuid[])
        AND deleted_at IS NULL
        AND fact_state = 'active'
    `,
    [entryIds]
  );

  return result.rows.map((row) => ({
    id: row.id,
    entryId: row.entry_id,
    subjectNodeId: row.subject_node_id,
    subjectText: row.subject_text,
    normalizedFactKey: row.normalized_fact_key
  }));
}

async function applyEntryReviewBatch(
  pgPool: Pool,
  ids: string[],
  reviewStatus: FactReviewStatus,
  note: string | undefined,
  syncFacts: boolean
): Promise<number> {
  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<EntryIdRow>(
      `
        UPDATE memory_entries
        SET review_status = $2,
            review_note = COALESCE($3, review_note),
            updated_at = NOW()
        WHERE id = ANY($1::uuid[])
          AND deleted_at IS NULL
        RETURNING id
      `,
      [ids, reviewStatus, note ?? null]
    );

    const affected = result.rowCount ?? result.rows.length;
    if (syncFacts && affected > 0) {
      if (reviewStatus === "rejected") {
        await client.query(
          `
            UPDATE memory_facts
            SET fact_state = 'deleted',
                deleted_at = COALESCE(deleted_at, NOW()),
                updated_at = NOW(),
                neo4j_synced = FALSE,
                neo4j_synced_at = NULL
            WHERE entry_id = ANY($1::uuid[])
              AND deleted_at IS NULL
          `,
          [ids]
        );
      } else {
        await client.query(
          `
            UPDATE memory_facts
            SET fact_state = 'active',
                deleted_at = NULL,
                updated_at = NOW(),
                neo4j_synced = FALSE,
                neo4j_synced_at = NULL
            WHERE entry_id = ANY($1::uuid[])
          `,
          [ids]
        );
      }
    }

    await client.query("COMMIT");
    return affected;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function hydrateEntriesById(
  entryStore: MemoryEntryStoreLike,
  ids: string[]
): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = [];
  for (const id of ids) {
    const entry = await entryStore.getEntry(id);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function rowsToCountMap(rows: CountKeyRow[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.key] = row.count;
  }
  return result;
}

function handleMemoryRouteError(
  res: Response,
  error: unknown,
  fallbackMessage: string
): Response {
  const mapped = mapMemoryRouteError(error);
  if (mapped) {
    logger.warn({ err: error, pgCode: mapped.pgCode, status: mapped.status }, fallbackMessage);
    return res.status(mapped.status).json({ error: mapped.error });
  }

  logger.error({ err: error }, fallbackMessage);
  return res.status(500).json({ error: fallbackMessage });
}

function mapMemoryRouteError(
  error: unknown
): {
  status: number;
  error: string;
  pgCode?: string;
} | null {
  if (error instanceof Error) {
    const message = error.message.trim();
    const normalized = message.toLowerCase();
    if (
      normalized.includes("must not be empty")
      || normalized.includes("is required")
      || normalized.includes("invalid input")
      || normalized.includes("invalid uuid")
      || normalized.includes("malformed")
    ) {
      return { status: 400, error: message };
    }
  }

  const pgError = asPgError(error);
  if (!pgError?.code) {
    return null;
  }

  switch (pgError.code) {
    case "22P02":
      return { status: 400, error: "Invalid input format", pgCode: pgError.code };
    case "22001":
      return { status: 400, error: "Input is too long", pgCode: pgError.code };
    case "22007":
      return { status: 400, error: "Invalid datetime format", pgCode: pgError.code };
    case "23502":
      return { status: 400, error: "Missing required field", pgCode: pgError.code };
    case "23503":
      return { status: 409, error: "Referenced resource does not exist", pgCode: pgError.code };
    case "23505":
    case "23P01":
      return { status: 409, error: "Resource conflict", pgCode: pgError.code };
    case "23514":
      return { status: 400, error: "Invalid input value", pgCode: pgError.code };
    default:
      return null;
  }
}

function asPgError(
  error: unknown
): {
  code?: string;
} | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const candidate = error as { code?: unknown };
  if (typeof candidate.code !== "string" || candidate.code.length === 0) {
    return null;
  }
  return { code: candidate.code };
}

async function persistEntryFactsEvidence(
  pgPool: Pool,
  facts: MemoryEntryFact[],
  input: {
    sourceType: MemorySourceType;
    excerpt?: string;
    documentId?: string;
    chunkId?: string;
    chatSessionId?: string;
    chatMessageId?: string;
  }
): Promise<void> {
  if (facts.length === 0) {
    return;
  }

  const excerpt = input.excerpt?.trim().slice(0, 500) || null;
  const extractedAt = new Date().toISOString();
  let insertedCount = 0;
  let deduplicatedCount = 0;
  let failedCount = 0;

  for (const fact of facts) {
    const evidenceHash = buildMemoryEvidenceHash({
      sourceType: input.sourceType,
      documentId: input.documentId ?? null,
      chunkId: input.chunkId ?? null,
      chatSessionId: input.chatSessionId ?? null,
      chatMessageId: input.chatMessageId ?? null,
      excerpt
    });

    try {
      const result = await pgPool.query(
        `
          INSERT INTO memory_evidence (
            fact_id,
            entry_id,
            source_type,
            evidence_hash,
            document_id,
            chunk_id,
            chat_session_id,
            chat_message_id,
            excerpt,
            extracted_at
          )
          VALUES (
            $1::uuid,
            $2::uuid,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10::timestamptz
          )
          ON CONFLICT (fact_id, evidence_hash)
          WHERE evidence_hash IS NOT NULL
          DO NOTHING
          RETURNING id
        `,
        [
          fact.id,
          fact.entryId,
          input.sourceType,
          evidenceHash,
          input.documentId ?? null,
          input.chunkId ?? null,
          input.chatSessionId ?? null,
          input.chatMessageId ?? null,
          excerpt,
          extractedAt
        ]
      );
      if ((result.rowCount ?? 0) > 0) {
        insertedCount += 1;
      } else {
        deduplicatedCount += 1;
      }
    } catch (error) {
      failedCount += 1;
      logger.warn(
        { err: error, factId: fact.id, entryId: fact.entryId },
        "Failed to persist memory evidence"
      );
    }
  }

  await recordMemoryOperationalMetric(pgPool, {
    metricName: "memory_evidence_write",
    sourceType: input.sourceType,
    outcome: "success",
    count: insertedCount
  });
  await recordMemoryOperationalMetric(pgPool, {
    metricName: "memory_evidence_write",
    sourceType: input.sourceType,
    outcome: "deduplicated",
    count: deduplicatedCount
  });
  await recordMemoryOperationalMetric(pgPool, {
    metricName: "memory_evidence_write",
    sourceType: input.sourceType,
    outcome: "failure",
    count: failedCount
  });
}

function normalizeForKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Write-time conflict detection: given a list of newly upserted facts for an entry,
 * find existing active facts with the same subject+predicate but different object,
 * and mark them (and their parent entries) as conflicted/deleted.
 * Non-fatal: errors are logged but do not propagate.
 */
async function detectAndResolveFactConflicts(
  pgPool: Pool,
  newEntryId: string,
  facts: MemoryEntryFact[]
): Promise<void> {
  if (facts.length === 0) return;

  const allConflictFactIds: string[] = [];
  const allConflictEntryIds: string[] = [];

  for (const fact of facts) {
    const subjectNorm = normalizeForKey(fact.subjectText ?? "");
    const predicateNorm = normalizeForKey(fact.predicate);
    const newObjectNorm = normalizeForKey(fact.objectText ?? fact.objectNodeId ?? "");

    if (!subjectNorm || !predicateNorm) continue;

    const conflicting = await pgPool.query<{
      id: string;
      entry_id: string;
      object_text: string | null;
      object_node_id: string | null;
    }>(
      `
        SELECT f.id, f.entry_id, f.object_text, f.object_node_id
        FROM memory_facts f
        JOIN memory_entries e ON e.id = f.entry_id
        WHERE LOWER(TRIM(f.subject_text)) = $1
          AND LOWER(TRIM(f.predicate)) = $2
          AND f.entry_id != $3
          AND f.deleted_at IS NULL
          AND f.fact_state = 'active'
          AND e.state = 'active'
          AND e.review_status NOT IN ('rejected', 'conflicted')
      `,
      [subjectNorm, predicateNorm, newEntryId]
    );

    for (const row of conflicting.rows) {
      const existingObj = normalizeForKey(row.object_text ?? row.object_node_id ?? "");
      if (existingObj !== newObjectNorm) {
        allConflictFactIds.push(row.id);
        allConflictEntryIds.push(row.entry_id);
      }
    }
  }

  if (allConflictFactIds.length > 0) {
    await pgPool.query(
      `UPDATE memory_facts SET fact_state = 'deleted', deleted_at = COALESCE(deleted_at, NOW()), updated_at = NOW(), neo4j_synced = FALSE WHERE id = ANY($1::uuid[])`,
      [allConflictFactIds]
    );
    const uniqueEntryIds = [...new Set(allConflictEntryIds)];
    await pgPool.query(
      `UPDATE memory_entries SET review_status = 'conflicted', updated_at = NOW() WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [uniqueEntryIds]
    );
    logger.info(
      { conflictFactIds: allConflictFactIds, conflictEntryIds: uniqueEntryIds },
      "Write-time conflict: marked old facts as deleted and entries as conflicted"
    );
  }
}

async function recordAccessLogs(
  pgPool: Pool,
  entryIds: string[],
  chatSessionId: string,
  accessType: string
): Promise<void> {
  const ids = dedupeStrings(entryIds);
  if (ids.length === 0) {
    return;
  }

  try {
    await pgPool.query(
      `
        INSERT INTO memory_access_logs (entry_id, chat_session_id, access_type)
        SELECT id::uuid, $2, $3
        FROM unnest($1::text[]) AS id
      `,
      [ids, chatSessionId, accessType]
    );
    await recordMemoryOperationalMetric(pgPool, {
      metricName: "memory_access_log_write",
      outcome: "success",
      count: ids.length
    });
  } catch (error) {
    await recordMemoryOperationalMetric(pgPool, {
      metricName: "memory_access_log_write",
      outcome: "failure",
      count: ids.length
    });
    throw error;
  }
}

async function fetchCompatFactById(pgPool: Pool, id: string): Promise<MemoryFact | null> {
  const result = await pgPool.query<FactCompatRow>(
    `
      SELECT
        f.id,
        f.entry_id,
        f.subject_node_id,
        f.subject_text,
        f.predicate,
        f.object_node_id,
        f.object_text,
        f.value_type,
        f.normalized_fact_key,
        f.confidence,
        f.fact_state,
        f.created_at,
        f.updated_at,
        f.deleted_at,
        f.neo4j_synced,
        f.neo4j_synced_at,
        f.neo4j_retry_count,
        f.neo4j_last_error,
        e.review_status,
        e.review_note
      FROM memory_facts f
      JOIN memory_entries e
        ON e.id = f.entry_id
      WHERE f.id = $1::uuid
      LIMIT 1
    `,
    [id]
  );

  const row = result.rows[0];
  return row ? mapCompatFactRow(row) : null;
}

function mapCompatFactRow(row: FactCompatRow): MemoryFact {
  const fact: MemoryFact = {
    id: row.id,
    entryId: row.entry_id,
    subjectNodeId: row.subject_node_id ?? row.subject_text,
    subjectText: row.subject_text,
    predicate: row.predicate,
    valueType: row.value_type,
    normalizedKey: row.normalized_fact_key,
    confidence: row.confidence,
    factState: row.fact_state,
    reviewStatus: row.review_status,
    firstSeenAt: row.created_at,
    lastSeenAt: row.updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    neo4jSynced: row.neo4j_synced,
    neo4jRetryCount: row.neo4j_retry_count
  };

  if (row.object_node_id) {
    fact.objectNodeId = row.object_node_id;
  }
  if (row.object_text) {
    fact.objectText = row.object_text;
  }
  if (row.review_note) {
    fact.reviewNote = row.review_note;
  }
  if (row.deleted_at) {
    fact.deletedAt = row.deleted_at;
  }
  if (row.neo4j_synced_at) {
    fact.neo4jSyncedAt = row.neo4j_synced_at;
  }
  if (row.neo4j_last_error) {
    fact.neo4jLastError = row.neo4j_last_error;
  }

  return fact;
}

function parseCompatCallerAllowlist(input: string): Set<string> {
  return new Set(
    input
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0)
  );
}

function resolveCompatCaller(req: Request): string {
  const explicit =
    req.header("x-memory-compat-caller")
    ?? req.header("x-caller")
    ?? req.header("x-client-id");
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim().toLowerCase();
  }

  const userAgent = req.header("user-agent");
  if (userAgent && userAgent.trim().length > 0) {
    return `ua:${userAgent.trim().toLowerCase().slice(0, 120)}`;
  }

  return "unknown";
}

async function recordCompatMetric(
  pgPool: Pool,
  input: {
    endpoint: string;
    method: string;
    caller: string;
    stage: string;
    blocked: boolean;
  }
): Promise<void> {
  await pgPool.query(
    `
      INSERT INTO memory_fact_compat_metrics (
        endpoint,
        method,
        caller,
        stage,
        blocked,
        metric_date,
        hit_count,
        first_called_at,
        last_called_at
      )
      VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, 1, NOW(), NOW())
      ON CONFLICT (metric_date, endpoint, method, caller, stage, blocked)
      DO UPDATE SET
        hit_count = memory_fact_compat_metrics.hit_count + 1,
        last_called_at = NOW()
    `,
    [input.endpoint, input.method, input.caller, input.stage, input.blocked]
  );
}

async function maybeEnqueueEntryRewriteJob(
  pgPool: Pool,
  entryId: string,
  triggerReason: string
): Promise<boolean> {
  const eligibility = await pgPool.query<RewriteEligibilityRow>(
    `
      SELECT
        e.content_revision,
        e.review_status,
        COUNT(f.id)::int AS active_fact_count
      FROM memory_entries e
      LEFT JOIN memory_facts f
        ON f.entry_id = e.id
       AND f.deleted_at IS NULL
       AND f.fact_state = 'active'
      WHERE e.id = $1::uuid
        AND e.deleted_at IS NULL
      GROUP BY e.id, e.content_revision, e.review_status
      LIMIT 1
    `,
    [entryId]
  );

  const row = eligibility.rows[0];
  if (!row) {
    return false;
  }
  if (!isRewriteEligibleStatus(row.review_status)) {
    return false;
  }
  if (row.active_fact_count <= 0) {
    return false;
  }

  const enqueueResult = await pgPool.query(
    `
      INSERT INTO entry_rewrite_jobs (
        entry_id,
        entry_revision,
        status,
        trigger_reason,
        attempts,
        max_attempts,
        next_retry_at
      )
      VALUES (
        $1::uuid,
        $2,
        'pending',
        $3,
        0,
        $4,
        NOW()
      )
      ON CONFLICT (entry_id, entry_revision) DO NOTHING
    `,
    [entryId, row.content_revision, triggerReason, appConfig.MEMORY_REWRITE_MAX_RETRIES]
  );

  return (enqueueResult.rowCount ?? 0) > 0;
}

function isRewriteEligibleStatus(status: FactReviewStatus): boolean {
  return status === "confirmed" || status === "modified";
}

function mapRewriteJobRow(row: RewriteJobRow): Record<string, unknown> {
  return {
    id: row.id,
    entryId: row.entry_id,
    entryRevision: row.entry_revision,
    status: row.status,
    triggerReason: row.trigger_reason,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextRetryAt: row.next_retry_at,
    oldContent: row.old_content,
    newContent: row.new_content,
    model: row.model,
    confidence: row.confidence,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at
  };
}

function buildNormalizedFactKey(input: {
  subjectNodeId?: string;
  subjectText: string;
  predicate: string;
  objectNodeId: string | null;
  objectText: string | null;
}): string {
  const subject = normalizeForKey(input.subjectNodeId ?? input.subjectText);
  const predicate = normalizeForKey(input.predicate);
  const object = normalizeForKey(input.objectNodeId ?? input.objectText ?? "");
  return `${subject}|${predicate}|${object}`;
}
