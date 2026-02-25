import { Router } from "express";
import type { HealthResponse } from "@graphen/shared";
import type { AbstractGraphStore } from "@graphen/shared";
import {
  checkLlmConnection,
  checkNeo4jConnection,
  type ServiceConnectionStatus
} from "../runtime/connectivity.js";
import {
  ensureGraphStoreConnected,
  getGraphStoreSingleton,
  getLLMServiceSingleton
} from "../runtime/graphRuntime.js";
import type { LLMServiceLike } from "../services/llmTypes.js";

interface CreateHealthRouterOptions {
  store?: AbstractGraphStore;
  llmService?: LLMServiceLike;
  ensureStoreConnected?: () => Promise<void>;
  checkNeo4j?: () => Promise<ServiceConnectionStatus>;
  checkLlm?: () => Promise<ServiceConnectionStatus>;
  startTime?: number;
}

export function createHealthRouter(options: CreateHealthRouterOptions = {}): Router {
  const store = options.store ?? getGraphStoreSingleton();
  const llmService = options.llmService ?? getLLMServiceSingleton();
  const ensureStoreConnected =
    options.ensureStoreConnected ??
    (options.store ? () => store.connect() : () => ensureGraphStoreConnected(store));
  const checkNeo4j =
    options.checkNeo4j ??
    (() =>
      checkNeo4jConnection({
        store,
        ensureStoreConnected
      }));
  const checkLlm =
    options.checkLlm ??
    (() =>
      checkLlmConnection({
        llmService
      }));
  const startTime = options.startTime ?? Date.now();

  const healthRouter = Router();

  healthRouter.get("/", async (_req, res) => {
    const [neo4j, llm] = await Promise.all([checkNeo4j(), checkLlm()]);
    const status: HealthResponse["status"] =
      neo4j === "failed" || llm === "failed" ? "degraded" : "ok";

    const mem = process.memoryUsage();
    const response: HealthResponse = {
      status,
      timestamp: new Date().toISOString(),
      uptimeSec: Math.max(0, Math.floor((Date.now() - startTime) / 1000)),
      checks: {
        neo4j,
        llm
      },
      memoryUsage: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal
      }
    };
    res.json(response);
  });

  return healthRouter;
}

export const healthRouter = createHealthRouter();
