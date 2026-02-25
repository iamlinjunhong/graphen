import type { AbstractGraphStore } from "@graphen/shared";
import { appConfig } from "../config.js";
import {
  ensureGraphStoreConnected,
  getGraphStoreSingleton,
  getLLMServiceSingleton
} from "./graphRuntime.js";
import type { LLMServiceLike } from "../services/llmTypes.js";

export type ServiceConnectionStatus = "ok" | "failed" | "not_configured";

export function isNeo4jConfigured(): boolean {
  return (
    appConfig.NEO4J_URI.trim().length > 0 &&
    appConfig.NEO4J_USER.trim().length > 0 &&
    appConfig.NEO4J_PASSWORD.trim().length > 0
  );
}

export function isLlmConfigured(): boolean {
  return appConfig.QWEN_API_KEY.trim().length > 0;
}

interface Neo4jConnectionOptions {
  store?: AbstractGraphStore;
  ensureStoreConnected?: () => Promise<void>;
}

interface LlmConnectionOptions {
  llmService?: LLMServiceLike;
  probeQuestion?: string;
}

export async function checkNeo4jConnection(
  options: Neo4jConnectionOptions = {}
): Promise<ServiceConnectionStatus> {
  if (!isNeo4jConfigured()) {
    return "not_configured";
  }

  const store = options.store ?? getGraphStoreSingleton();
  const ensureStoreConnected =
    options.ensureStoreConnected ??
    (options.store ? () => store.connect() : () => ensureGraphStoreConnected(store));

  try {
    await ensureStoreConnected();
    const healthy = await store.healthCheck();
    return healthy ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

export async function checkLlmConnection(
  options: LlmConnectionOptions = {}
): Promise<ServiceConnectionStatus> {
  if (!isLlmConfigured()) {
    return "not_configured";
  }

  const llmService = options.llmService ?? getLLMServiceSingleton();

  try {
    await llmService.analyzeQuestion(options.probeQuestion ?? "ping");
    return "ok";
  } catch {
    return "failed";
  }
}
