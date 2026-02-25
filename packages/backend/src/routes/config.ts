import { Router } from "express";
import { z } from "zod";
import type {
  ConfigModelsResponse,
  GetConfigResponse,
  TestConnectionResponse,
  UpdateConfigResponse
} from "@graphen/shared";
import type { AbstractGraphStore } from "@graphen/shared";
import { appConfig } from "../config.js";
import { validate } from "../middleware/validator.js";
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

const updateConfigSchema = z
  .object({
    corsOrigin: z.string().min(1).optional(),
    maxUploadSize: z.coerce.number().int().positive().optional(),
    rateLimitMax: z.coerce.number().int().positive().optional(),
    logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional()
  })
  .strict();

interface RuntimeConfigSnapshot {
  corsOrigin: string;
  maxUploadSize: number;
  rateLimitMax: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
}

interface CreateConfigRouterOptions {
  store?: AbstractGraphStore;
  llmService?: LLMServiceLike;
  ensureStoreConnected?: () => Promise<void>;
  checkNeo4j?: () => Promise<ServiceConnectionStatus>;
  checkLlm?: () => Promise<ServiceConnectionStatus>;
}

export function createConfigRouter(options: CreateConfigRouterOptions = {}): Router {
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

  const runtimeConfig: RuntimeConfigSnapshot = {
    corsOrigin: appConfig.CORS_ORIGIN,
    maxUploadSize: appConfig.MAX_UPLOAD_SIZE,
    rateLimitMax: appConfig.RATE_LIMIT_MAX,
    logLevel: appConfig.LOG_LEVEL
  };

  const configRouter = Router();

  configRouter.get("/", (_req, res) => {
    const response: GetConfigResponse = {
      config: {
        nodeEnv: appConfig.NODE_ENV,
        corsOrigin: runtimeConfig.corsOrigin,
        maxUploadSize: runtimeConfig.maxUploadSize,
        rateLimitWindowMs: appConfig.RATE_LIMIT_WINDOW_MS,
        rateLimitMax: runtimeConfig.rateLimitMax,
        logLevel: runtimeConfig.logLevel
      }
    };
    res.json(response);
  });

  configRouter.put("/", validate({ body: updateConfigSchema }), (req, res) => {
    const nextConfig = req.body as z.infer<typeof updateConfigSchema>;
    if (nextConfig.corsOrigin !== undefined) {
      runtimeConfig.corsOrigin = nextConfig.corsOrigin;
    }
    if (nextConfig.maxUploadSize !== undefined) {
      runtimeConfig.maxUploadSize = nextConfig.maxUploadSize;
    }
    if (nextConfig.rateLimitMax !== undefined) {
      runtimeConfig.rateLimitMax = nextConfig.rateLimitMax;
    }
    if (nextConfig.logLevel !== undefined) {
      runtimeConfig.logLevel = nextConfig.logLevel;
    }

    const requested: UpdateConfigResponse["requested"] = {};
    if (nextConfig.corsOrigin !== undefined) {
      requested.corsOrigin = nextConfig.corsOrigin;
    }
    if (nextConfig.maxUploadSize !== undefined) {
      requested.maxUploadSize = nextConfig.maxUploadSize;
    }
    if (nextConfig.rateLimitMax !== undefined) {
      requested.rateLimitMax = nextConfig.rateLimitMax;
    }
    if (nextConfig.logLevel !== undefined) {
      requested.logLevel = nextConfig.logLevel;
    }

    const response: UpdateConfigResponse = {
      message: "Config update accepted",
      requested
    };
    res.json(response);
  });

  configRouter.get("/models", (_req, res) => {
    const response: ConfigModelsResponse = {
      models: {
        chat: [appConfig.QWEN_CHAT_MODEL],
        embedding: [appConfig.QWEN_EMBEDDING_MODEL]
      }
    };
    res.json(response);
  });

  configRouter.post("/test-connection", async (_req, res) => {
    const [neo4j, llm] = await Promise.all([checkNeo4j(), checkLlm()]);

    const response: TestConnectionResponse = {
      neo4j,
      llm
    };
    res.json(response);
  });

  return configRouter;
}

export const configRouter = createConfigRouter();
