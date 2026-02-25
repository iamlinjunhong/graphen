import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import type { AbstractGraphStore, Document, DocumentChunk } from "@graphen/shared";
import { appConfig } from "../config.js";
import { MarkdownParser, PDFParser, TextParser } from "../parsers/index.js";
import type { LLMServiceLike } from "../services/llmTypes.js";
import { EntityResolver } from "./EntityResolver.js";
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

export class DocumentPipeline {
  private readonly eventEmitter: EventEmitter;
  private readonly options: DocumentPipelineOptions;
  private readonly entityResolver: EntityResolver;

  constructor(
    private readonly store: AbstractGraphStore,
    private readonly llmService: LLMServiceLike,
    eventEmitter?: EventEmitter,
    options: Partial<DocumentPipelineOptions> = {}
  ) {
    this.eventEmitter = eventEmitter ?? new EventEmitter();
    this.options = {
      ...defaultOptions,
      ...options
    };
    this.entityResolver = new EntityResolver();
  }

  getEventEmitter(): EventEmitter {
    return this.eventEmitter;
  }

  onStatus(listener: (event: PipelineStatusEvent) => void): void {
    this.eventEmitter.on("status", listener);
  }

  async process(document: Document, fileBuffer: Buffer): Promise<DocumentPipelineResult> {
    try {
      this.emitStatus(document.id, "parsing", 0);
      const rawText = await this.parseFile(document.fileType, fileBuffer);

      this.emitStatus(document.id, "chunking", 20);
      const chunks = await this.loadOrCreateChunks(document.id, rawText);

      const estimatedTokens = this.estimateTotalTokens(chunks);
      this.guardDocumentSize(chunks.length, estimatedTokens);

      this.emitStatus(document.id, "extracting", 30);
      const extractions = await this.loadOrExtract(document.id, chunks);

      this.emitStatus(document.id, "resolving", 70);
      const resolvedGraph = this.entityResolver.resolve(extractions, document.id);

      this.emitStatus(document.id, "embedding", 80);
      await this.generateEmbeddings(document.id, resolvedGraph, chunks);

      this.emitStatus(document.id, "saving", 90);
      const savedDocument = await this.saveToStore(document, chunks, resolvedGraph);

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

  private async loadOrCreateChunks(documentId: string, text: string): Promise<DocumentChunk[]> {
    const cachePath = this.getChunksCachePath(documentId);
    const cached = await this.readJsonFile<DocumentChunk[]>(cachePath);
    if (cached && cached.length > 0) {
      return cached;
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

  private async loadOrExtract(documentId: string, chunks: DocumentChunk[]): Promise<ChunkExtractionResult[]> {
    const cachePath = this.getExtractionsCachePath(documentId);
    const cached = (await this.readJsonFile<ChunkExtractionResult[]>(cachePath)) ?? [];
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
    resolvedGraph: ResolvedGraph,
    chunks: DocumentChunk[]
  ): Promise<void> {
    await runWithConcurrency(
      resolvedGraph.nodes,
      this.options.embeddingConcurrency,
      async (node) => {
        const embedding = await this.llmService.generateEmbedding(
          `${node.name}\n${node.description}`,
          { documentId }
        );
        node.embedding = embedding;
      }
    );

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

    await this.store.saveDocument(savedDocument);
    await this.store.saveChunks(chunks);
    await this.store.saveNodes(resolvedGraph.nodes);
    await this.store.saveEdges(resolvedGraph.edges);

    for (const node of resolvedGraph.nodes) {
      if (node.embedding && node.embedding.length > 0) {
        await this.store.saveEmbeddings(node.id, node.embedding);
      }
    }

    return savedDocument;
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
