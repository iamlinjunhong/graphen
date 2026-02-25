import type { AbstractGraphStore } from "@graphen/shared";
import { DocumentPipeline } from "../pipeline/DocumentPipeline.js";
import type { LLMServiceLike } from "../services/llmTypes.js";
import { LLMService } from "../services/LLMService.js";
import { Neo4jGraphStore } from "../store/Neo4jGraphStore.js";

let graphStoreSingleton: AbstractGraphStore | null = null;
let llmServiceSingleton: LLMServiceLike | null = null;
let documentPipelineSingleton: DocumentPipeline | null = null;
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

export function getDocumentPipelineSingleton(): DocumentPipeline {
  if (!documentPipelineSingleton) {
    documentPipelineSingleton = new DocumentPipeline(
      getGraphStoreSingleton(),
      getLLMServiceSingleton()
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
