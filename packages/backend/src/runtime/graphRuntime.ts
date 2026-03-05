import type { AbstractGraphStore } from "@graphen/shared";
import { DocumentPipeline } from "../pipeline/DocumentPipeline.js";
import type { LLMServiceLike } from "../services/llmTypes.js";
import { LLMService } from "../services/LLMService.js";
import { MemoryExtractor } from "../services/MemoryExtractor.js";
import { MemoryService } from "../services/MemoryService.js";
import type { PgDocumentStoreLike } from "../services/PgDocumentStore.js";
import { PgDocumentStore } from "../services/PgDocumentStore.js";
import { Neo4jGraphStore } from "../store/Neo4jGraphStore.js";
import { getPgPoolSingleton } from "./PgPool.js";
import { getPgMemoryEntryStoreSingleton } from "./memoryRuntime.js";

let graphStoreSingleton: AbstractGraphStore | null = null;
let llmServiceSingleton: LLMServiceLike | null = null;
let pgDocumentStoreSingleton: PgDocumentStoreLike | null = null;
let documentPipelineSingleton: DocumentPipeline | null = null;
let memoryServiceSingleton: MemoryService | null = null;
let memoryExtractorSingleton: MemoryExtractor | null = null;
let connectPromise: Promise<void> | null = null;

export function getGraphStoreSingleton(): AbstractGraphStore {
  if (!graphStoreSingleton) {
    graphStoreSingleton = Neo4jGraphStore.fromEnv();
  }

  return graphStoreSingleton;
}

export function getLLMServiceSingleton(): LLMServiceLike {
  if (!llmServiceSingleton) {
    llmServiceSingleton = LLMService.fromEnv();
  }

  return llmServiceSingleton;
}

export function getPgDocumentStoreSingleton(): PgDocumentStoreLike {
  if (!pgDocumentStoreSingleton) {
    pgDocumentStoreSingleton = new PgDocumentStore();
  }
  return pgDocumentStoreSingleton;
}

function getMemoryServiceSingleton(): MemoryService {
  if (!memoryServiceSingleton) {
    memoryServiceSingleton = new MemoryService(getPgMemoryEntryStoreSingleton());
  }
  return memoryServiceSingleton;
}

function getMemoryExtractorSingleton(): MemoryExtractor {
  if (!memoryExtractorSingleton) {
    const entryStore = getPgMemoryEntryStoreSingleton();
    memoryExtractorSingleton = new MemoryExtractor(
      getLLMServiceSingleton(),
      getMemoryServiceSingleton(),
      {},
      { entryStore, pgPool: getPgPoolSingleton() }
    );
  }
  return memoryExtractorSingleton;
}

export function getDocumentPipelineSingleton(): DocumentPipeline {
  if (!documentPipelineSingleton) {
    const pipelineDeps: {
      documentStore: PgDocumentStoreLike;
      memoryExtractor: MemoryExtractor;
    } = {
      documentStore: getPgDocumentStoreSingleton(),
      memoryExtractor: getMemoryExtractorSingleton()
    };

    documentPipelineSingleton = new DocumentPipeline(
      getGraphStoreSingleton(),
      getLLMServiceSingleton(),
      undefined,
      {},
      pipelineDeps
    );
  }

  return documentPipelineSingleton;
}

export async function ensureGraphStoreConnected(
  store: AbstractGraphStore = getGraphStoreSingleton()
): Promise<void> {
  if (connectPromise) {
    return connectPromise;
  }

  connectPromise = store.connect().catch((error) => {
    connectPromise = null;
    throw error;
  });

  return connectPromise;
}

export async function disconnectGraphStoreSingleton(): Promise<void> {
  if (!graphStoreSingleton) {
    connectPromise = null;
    return;
  }

  const store = graphStoreSingleton;
  graphStoreSingleton = null;
  connectPromise = null;
  await store.disconnect();
}
