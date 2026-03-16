import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import type { AbstractGraphStore, CandidateFact, Document, DocumentChunk, MemoryServiceLike } from "@graphen/shared";
import type { Pool } from "pg";
import { appConfig } from "../config.js";
import { MarkdownParser, PDFParser, TextParser } from "../parsers/index.js";
import type { MemoryExtractor } from "../services/MemoryExtractor.js";
import type { LLMServiceLike } from "../services/llmTypes.js";
import { EntityResolver } from "./EntityResolver.js";
import { logger } from "../utils/logger.js";
import type {
  ChunkExtractionResult,
  DocumentPipelineOptions,
  DocumentPipelineResult,
  PipelinePhase,
  PipelineStatusEvent,
  ResolvedGraph
} from "./types.js";

const defaultOptions: DocumentPipelineOptions = {
  cacheDir: appConfig.CACHE_DIR,
  chunkSize: appConfig.CHUNK_SIZE,
  chunkOverlap: appConfig.CHUNK_OVERLAP,
  maxChunksPerDocument: appConfig.MAX_CHUNKS_PER_DOCUMENT,
  maxEstimatedTokens: appConfig.MAX_DOCUMENT_ESTIMATED_TOKENS,
  extractionConcurrency: 5,
  embeddingConcurrency: 5
};

interface DocumentWriteStoreLike {
  saveDocument(doc: Document): Promise<void>;
  saveChunks(chunks: DocumentChunk[]): Promise<void>;
}

export class DocumentPipeline {
  private readonly eventEmitter: EventEmitter;
  private readonly options: DocumentPipelineOptions;
  private readonly entityResolver: EntityResolver;
  private readonly memoryService: MemoryServiceLike | undefined;
  private readonly memoryExtractor: MemoryExtractor | undefined;
  private readonly documentStore: DocumentWriteStoreLike;
  private readonly pgPool: Pool | undefined;

  constructor(
    private readonly store: AbstractGraphStore,
    private readonly llmService: LLMServiceLike,
    eventEmitter?: EventEmitter,
    options: Partial<DocumentPipelineOptions> = {},
    deps?: {
      memoryService?: MemoryServiceLike;
      memoryExtractor?: MemoryExtractor;
      documentStore?: DocumentWriteStoreLike;
      pgPool?: Pool;
    }
  ) {
    this.eventEmitter = eventEmitter ?? new EventEmitter();
    this.options = {
      ...defaultOptions,
      ...options
    };
    this.entityResolver = new EntityResolver();
    this.memoryService = deps?.memoryService;
    this.memoryExtractor = deps?.memoryExtractor;
    this.documentStore = deps?.documentStore ?? {
      saveDocument: async () => {
        throw new Error("DocumentPipeline requires a documentStore for PG document writes");
      },
      saveChunks: async () => {
        throw new Error("DocumentPipeline requires a documentStore for PG chunk writes");
      }
    };
    this.pgPool = deps?.pgPool;
  }

  getEventEmitter(): EventEmitter {
    return this.eventEmitter;
  }

  onStatus(listener: (event: PipelineStatusEvent) => void): void {
    this.eventEmitter.on("status", listener);
  }

  async process(
    document: Document,
    fileBuffer: Buffer,
    options?: { rawText?: string; forceRebuild?: boolean }
  ): Promise<DocumentPipelineResult> {
    const forceRebuild = options?.forceRebuild ?? false;
    try {
      this.emitStatus(document.id, "parsing", 0);
      const rawText = options?.rawText ?? await this.parseFile(document.fileType, fileBuffer);

      this.emitStatus(document.id, "chunking", 20);
      const chunks = await this.loadOrCreateChunks(document.id, rawText, forceRebuild);

      const estimatedTokens = this.estimateTotalTokens(chunks);
      this.guardDocumentSize(chunks.length, estimatedTokens);

      this.emitStatus(document.id, "extracting", 30);
      const extractions = await this.loadOrExtract(document.id, chunks, forceRebuild);

      this.emitStatus(document.id, "resolving", 70);
      const resolvedGraph = this.entityResolver.resolve(extractions, document.id);

      // Reparse: 先清理旧文档关联的记忆和图谱数据，再 reconcile 和写入新数据
      // 必须在 reconcileWithExistingNodes 之前清理，否则 reconcile 会 remap 到
      // 即将被删除的旧节点 id，导致 saveNodes 重建的节点 id 与旧节点冲突。
      if (forceRebuild) {
        await this.cleanupOldDocumentData(document.id);
      }

      await this.reconcileWithExistingNodes(resolvedGraph);

      this.emitStatus(document.id, "embedding", 80);
      await this.generateEmbeddings(document.id, chunks);

      this.emitStatus(document.id, "saving", 90);
      const savedDocument = await this.saveToStore(document, chunks, resolvedGraph);

      // 记忆提取必须在 saveToStore 之后执行：
      // 1. 确保 Entity 节点已写入 Neo4j，syncSingleFact 的 OPTIONAL MATCH 能找到它们
      // 2. await 所有提取任务完成后才标记 pipeline completed
      this.emitStatus(document.id, "memory", 95, "提取记忆中...");
      if (this.memoryExtractor) {
        // 构建 nodeIdMap：将图谱节点名称映射到节点 id，
        // 让 syncSingleFact 能复用 saveNodes 创建的节点，避免重复节点。
        const nodeIdMap = new Map<string, string>();
        for (const node of resolvedGraph.nodes) {
          const lowerName = node.name.trim().toLowerCase().replace(/\s+/g, " ");
          if (!nodeIdMap.has(node.name)) {
            nodeIdMap.set(node.name, node.id);
          }
          if (!nodeIdMap.has(lowerName)) {
            nodeIdMap.set(lowerName, node.id);
          }
        }
        await this.awaitMemoryExtractions(document.id, chunks, nodeIdMap);
      } else {
        // Legacy fallback used by tests and in-memory mode.
        this.generateMemoryFacts(resolvedGraph, document.id);
      }

      this.emitStatus(document.id, "completed", 100);
      return {
        document: savedDocument,
        chunks,
        resolvedGraph,
        estimatedTokens
      };
    } catch (error) {
      this.emitStatus(document.id, "error", 100, error instanceof Error ? error.message : "Unknown error");
      throw error;
    }
  }

  private async parseFile(fileType: Document["fileType"], fileBuffer: Buffer): Promise<string> {
    switch (fileType) {
      case "pdf": {
        const result = await new PDFParser().parse(fileBuffer);
        return result.text;
      }
      case "md": {
        const result = await new MarkdownParser().parse(fileBuffer);
        return result.text;
      }
      case "txt": {
        const result = await new TextParser().parse(fileBuffer);
        return result.text;
      }
      default:
        throw new Error(`Unsupported file type: ${fileType as string}`);
    }
  }

  private async loadOrCreateChunks(documentId: string, text: string, forceRebuild = false): Promise<DocumentChunk[]> {
    const cachePath = this.getChunksCachePath(documentId);
    if (!forceRebuild) {
      const cached = await this.readJsonFile<DocumentChunk[]>(cachePath);
      if (cached && cached.length > 0) {
        return cached;
      }
    }

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: this.options.chunkSize,
      chunkOverlap: this.options.chunkOverlap
    });

    const split = await splitter.splitText(text);
    const chunks: DocumentChunk[] = split.map((content, index) => ({
      id: randomUUID(),
      documentId,
      content,
      index,
      metadata: {}
    }));

    await this.writeJsonFile(cachePath, chunks);
    return chunks;
  }

  private estimateTotalTokens(chunks: DocumentChunk[]): number {
    return chunks.reduce((sum, chunk) => sum + this.estimateTokens(chunk.content), 0);
  }

  private estimateTokens(text: string): number {
    if (typeof this.llmService.estimateTokens === "function") {
      return this.llmService.estimateTokens(text);
    }
    return Math.ceil(text.length / 4);
  }

  private guardDocumentSize(chunkCount: number, estimatedTokens: number): void {
    if (chunkCount > this.options.maxChunksPerDocument) {
      throw new Error(
        `Chunk count limit exceeded: ${chunkCount} > ${this.options.maxChunksPerDocument}. Please split the document.`
      );
    }

    if (estimatedTokens > this.options.maxEstimatedTokens) {
      throw new Error(
        `Estimated token usage too high: ${estimatedTokens} > ${this.options.maxEstimatedTokens}. Please split or trim the document.`
      );
    }
  }

  private async loadOrExtract(documentId: string, chunks: DocumentChunk[], forceRebuild = false): Promise<ChunkExtractionResult[]> {
    const cachePath = this.getExtractionsCachePath(documentId);
    const cached = forceRebuild ? [] : ((await this.readJsonFile<ChunkExtractionResult[]>(cachePath)) ?? []);
    const extractionMap = new Map<string, ChunkExtractionResult>(cached.map((item) => [item.chunkId, item]));

    const pending = chunks.filter((chunk) => !extractionMap.has(chunk.id));
    let writeQueue = Promise.resolve();

    await runWithConcurrency(pending, this.options.extractionConcurrency, async (chunk) => {
      const result = await this.llmService.extractEntitiesAndRelations(chunk.content, undefined, {
        documentId
      });

      extractionMap.set(chunk.id, {
        chunkId: chunk.id,
        chunkIndex: chunk.index,
        result
      });

      const snapshot = [...extractionMap.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
      writeQueue = writeQueue.then(() => this.writeJsonFile(cachePath, snapshot));
      await writeQueue;
    });

    return [...extractionMap.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  private async generateEmbeddings(
    documentId: string,
    chunks: DocumentChunk[]
  ): Promise<void> {
    await runWithConcurrency(chunks, this.options.embeddingConcurrency, async (chunk) => {
      chunk.embedding = await this.llmService.generateEmbedding(chunk.content, {
        documentId
      });
    });
  }

  private async saveToStore(
    document: Document,
    chunks: DocumentChunk[],
    resolvedGraph: ResolvedGraph
  ): Promise<Document> {
    const now = new Date();
    const mergedMetadata = {
      ...document.metadata,
      chunkCount: chunks.length,
      entityCount: resolvedGraph.nodes.length,
      edgeCount: resolvedGraph.edges.length
    };

    const savedDocument: Document = {
      ...document,
      status: "completed",
      parsedAt: now,
      metadata: mergedMetadata
    };

    await this.documentStore.saveDocument(savedDocument);
    await this.documentStore.saveChunks(chunks);

    // Save resolved graph nodes and edges to the graph store (Neo4j)
    if (resolvedGraph.nodes.length > 0) {
      await this.store.saveNodes(resolvedGraph.nodes);
    }
    if (resolvedGraph.edges.length > 0) {
      await this.store.saveEdges(resolvedGraph.edges);
    }

    return savedDocument;
  }

  /**
   * 等待所有 chunk 的记忆提取完成。
   * 必须在 saveToStore 之后调用，确保 Entity 节点已在 Neo4j 中。
   */
  private async awaitMemoryExtractions(
    documentId: string,
    chunks: DocumentChunk[],
    nodeIdMap?: Map<string, string>
  ): Promise<void> {
    if (!this.memoryExtractor || chunks.length === 0) {
      return;
    }

    const tasks: Array<Promise<unknown>> = [];
    for (const chunk of chunks) {
      const message = chunk.content.trim();
      if (message.length === 0) {
        continue;
      }

      tasks.push(
        this.memoryExtractor.enqueue({
          message,
          sourceType: "document",
          documentId,
          chunkId: chunk.id,
          nodeIdMap
        }).catch((error) => {
          logger.warn(
            { err: error, documentId, chunkId: chunk.id },
            "Document memory extraction failed"
          );
        })
      );
    }

    if (tasks.length > 0) {
      logger.info({ documentId, enqueued: tasks.length }, "Document memory extraction started");
      await Promise.all(tasks);
      logger.info({ documentId, completed: tasks.length }, "Document memory extraction completed");
    }
  }

  /**
   * Convert resolved edges to MemoryFact candidates and merge into memory store.
   * Each edge becomes a fact: sourceNode → relationType → targetNode.
   * Reparse is handled by MemoryService.mergeFacts() dedup logic:
   *  - auto facts get confidence updated + new evidence appended
   *  - confirmed/modified facts only get new evidence appended
   */
  private generateMemoryFacts(resolvedGraph: ResolvedGraph, documentId: string): void {
    if (!this.memoryService || resolvedGraph.edges.length === 0) return;

    const nodeById = new Map(resolvedGraph.nodes.map((n) => [n.id, n]));
    const now = new Date().toISOString();
    const candidates: CandidateFact[] = [];

    for (const edge of resolvedGraph.edges) {
      const sourceNode = nodeById.get(edge.sourceNodeId);
      const targetNode = nodeById.get(edge.targetNodeId);
      if (!sourceNode || !targetNode) continue;

      candidates.push({
        subjectNodeId: sourceNode.name,
        predicate: edge.relationType,
        objectNodeId: targetNode.name,
        valueType: "entity",
        confidence: edge.confidence,
        evidence: {
          sourceType: "document",
          documentId,
          extractedAt: now,
        },
      });
    }

    if (candidates.length === 0) return;

    try {
      const result = this.memoryService.mergeFacts(candidates);
      logger.info(
        { documentId, created: result.created, updated: result.updated, conflicted: result.conflicted },
        "Document memory facts generated"
      );
    } catch (error) {
      logger.warn({ err: error, documentId }, "Memory fact generation failed, continuing without memory");
    }
  }

  /**
   * Cross-document entity fusion: query Neo4j for existing nodes with the same
   * canonical key (type:normalizedName). If found, remap the resolved node's ID
   * to the existing one so that saveNodes (with ON MATCH append mode) merges
   * sourceDocumentIds instead of creating a duplicate.
   */
  private async reconcileWithExistingNodes(graph: ResolvedGraph): Promise<void> {
    if (graph.nodes.length === 0) {
      return;
    }

    // Build canonical keys for all resolved nodes
    const keyEntries = graph.nodes.map((node) => ({
      canonicalKey: EntityResolver.buildCanonicalKey(node.type, node.name),
      type: node.type.trim().toLowerCase(),
      lowerName: node.name.trim().toLowerCase().replace(/\s+/g, " ")
    }));

    // Query the store — only if it supports findNodeIdsByCanonicalKeys
    const storeAny = this.store as unknown as Record<string, unknown>;
    if (typeof storeAny.findNodeIdsByCanonicalKeys !== "function") {
      return;
    }

    const existingMap = await (
      storeAny.findNodeIdsByCanonicalKeys as (
        keys: Array<{ type: string; lowerName: string }>
      ) => Promise<Map<string, string>>
    )(keyEntries.map((e) => ({ type: e.type, lowerName: e.lowerName })));

    if (existingMap.size === 0) {
      return;
    }

    // Build old-id → new-id remap
    const idRemap = new Map<string, string>();
    for (let i = 0; i < graph.nodes.length; i++) {
      const node = graph.nodes[i]!;
      const key = keyEntries[i]!.canonicalKey;
      const existingId = existingMap.get(key);
      if (existingId && existingId !== node.id) {
        idRemap.set(node.id, existingId);
        node.id = existingId;
      }
    }

    if (idRemap.size === 0) {
      return;
    }

    // Remap edge references
    for (const edge of graph.edges) {
      const remappedSource = idRemap.get(edge.sourceNodeId);
      if (remappedSource) {
        edge.sourceNodeId = remappedSource;
      }
      const remappedTarget = idRemap.get(edge.targetNodeId);
      if (remappedTarget) {
        edge.targetNodeId = remappedTarget;
      }
    }
  }

  /**
   * Reparse 前清理旧文档关联的数据:
   * 1. 删除该文档关联的 memory_entries（通过 evidence.document_id 反查）
   * 2. 清理 Neo4j 中仅由该文档贡献的节点/边
   *
   * 这样重新解析时，记忆界面不会出现旧条目堆积，知识图谱不会出现重复节点。
   */
  private async cleanupOldDocumentData(documentId: string): Promise<void> {
    // 1. 清理旧的 memory entries / facts / evidence
    if (this.pgPool) {
      try {
        // 1a. 找出该文档关联的所有 entry ids
        const evidenceResult = await this.pgPool.query<{ entry_id: string }>(
          `SELECT DISTINCT entry_id FROM memory_evidence WHERE document_id = $1`,
          [documentId]
        );
        const entryIds = evidenceResult.rows.map((r) => r.entry_id);

        if (entryIds.length > 0) {
          // 1b. 删除该文档的 evidence 记录
          await this.pgPool.query(
            `DELETE FROM memory_evidence WHERE document_id = $1`,
            [documentId]
          );

          // 1c. 对于这些 entries，软删除不再有任何 evidence 的 facts
          //     （即该 fact 的所有 evidence 都来自本文档，已在 1b 中删除）
          await this.pgPool.query(
            `
              UPDATE memory_facts
              SET fact_state = 'deleted',
                  deleted_at = NOW(),
                  neo4j_synced = FALSE,
                  updated_at = NOW()
              WHERE entry_id = ANY($1::uuid[])
                AND deleted_at IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM memory_evidence ev
                  WHERE ev.fact_id = memory_facts.id
                )
            `,
            [entryIds]
          );

          // 1d. 删除不再有任何 active facts 的 entries
          await this.pgPool.query(
            `
              DELETE FROM memory_entries
              WHERE id = ANY($1::uuid[])
                AND NOT EXISTS (
                  SELECT 1 FROM memory_facts f
                  WHERE f.entry_id = memory_entries.id
                    AND f.deleted_at IS NULL
                    AND f.fact_state = 'active'
                )
            `,
            [entryIds]
          );
        }

        logger.info({ documentId, entryCount: entryIds.length }, "Reparse: cleaned up old memory data");
      } catch (error) {
        const pgErr = error as { code?: string };
        // 42P01 = undefined_table，memory 表可能不存在
        if (pgErr.code !== "42P01") {
          logger.warn({ err: error, documentId }, "Reparse: failed to clean up old memory entries");
        }
      }
    }

    // 2. 清理 Neo4j 中旧文档关联的节点和边
    const storeAny = this.store as unknown as Record<string, unknown>;
    if (typeof storeAny.removeDocumentData === "function") {
      try {
        await (storeAny.removeDocumentData as (docId: string) => Promise<void>)(documentId);
        logger.info({ documentId }, "Reparse: cleaned up old graph data");
      } catch (error) {
        logger.warn({ err: error, documentId }, "Reparse: failed to clean up old graph data");
      }
    }
  }



  private emitStatus(documentId: string, phase: PipelinePhase, progress: number, message?: string): void {
    const payload: PipelineStatusEvent = {
      documentId,
      phase,
      progress
    };
    if (message !== undefined) {
      payload.message = message;
    }

    this.eventEmitter.emit("status", payload);
  }

  private getDocumentCacheDir(documentId: string): string {
    return resolve(this.options.cacheDir, documentId);
  }

  private getChunksCachePath(documentId: string): string {
    return resolve(this.getDocumentCacheDir(documentId), "chunks.json");
  }

  private getExtractionsCachePath(documentId: string): string {
    return resolve(this.getDocumentCacheDir(documentId), "extractions.json");
  }

  private async writeJsonFile(path: string, data: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2), "utf8");
  }

  private async readJsonFile<T>(path: string): Promise<T | null> {
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const safeConcurrency = Math.max(1, concurrency);
  let current = 0;

  const runners = Array.from({ length: Math.min(safeConcurrency, items.length) }, async () => {
    while (true) {
      const index = current;
      current += 1;
      if (index >= items.length) {
        break;
      }

      const item = items[index];
      if (item === undefined) {
        break;
      }
      await worker(item, index);
    }
  });

  await Promise.all(runners);
}
