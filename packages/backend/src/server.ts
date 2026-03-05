import { pathToFileURL } from "node:url";
import type { Server as HttpServer } from "node:http";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { appConfig } from "./config.js";
import { requestLogger } from "./middleware/logger.js";
import { apiRateLimiter } from "./middleware/rateLimiter.js";
import { createChatRouter } from "./routes/chat.js";
import { createConfigRouter } from "./routes/config.js";
import { createDocumentsRouter } from "./routes/documents.js";
import { createGraphRouter } from "./routes/graph.js";
import { createHealthRouter } from "./routes/health.js";
import { createMemoryRouter } from "./routes/memory.js";
import { closePgPoolSingleton, getPgPoolSingleton } from "./runtime/PgPool.js";
import {
  disconnectGraphStoreSingleton,
  ensureGraphStoreConnected,
  getGraphStoreSingleton,
  getLLMServiceSingleton
} from "./runtime/graphRuntime.js";
import { ensureRuntimePgBootstrap } from "./runtime/pgBootstrap.js";
import { graphSyncEnabled, runtimePgRequired } from "./runtime/runtimeMode.js";
import { Neo4jGraphStore } from "./store/Neo4jGraphStore.js";
import { logger } from "./utils/logger.js";
import { EntryRewriteWorker } from "./workers/EntryRewriteWorker.js";
import { GraphSyncWorker } from "./workers/GraphSyncWorker.js";

export function createApp(): Express {
  const app = express();

  app.use(requestLogger);
  app.use(
    cors({
      origin: appConfig.CORS_ORIGIN,
      exposedHeaders: ["x-document-id", "x-total-count", "x-page", "x-page-size"]
    })
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(apiRateLimiter);

  app.use("/api/documents", createDocumentsRouter());
  app.use("/api/graph", createGraphRouter());
  app.use("/api/chat", createChatRouter());
  app.use("/api/memory", createMemoryRouter());
  app.use("/api/config", createConfigRouter());
  app.use("/api/health", createHealthRouter());

  app.use((_req, res) => {
    res.status(404).json({ error: "Route not found" });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, "Unhandled error");
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

export interface StartedServer {
  app: Express;
  server: HttpServer;
  shutdown: (signal: NodeJS.Signals) => Promise<void>;
}

export async function startServer(): Promise<StartedServer> {
  await ensureRuntimePgBootstrap();

  const app = createApp();
  const server = app.listen(appConfig.PORT, () => {
    logger.info(`Graphen backend is running on http://localhost:${appConfig.PORT}`);
  });

  let graphSyncWorker: GraphSyncWorker | null = null;
  let entryRewriteWorker: EntryRewriteWorker | null = null;
  let shuttingDown = false;

  const startGraphSyncWorker = async (): Promise<void> => {
    if (!graphSyncEnabled()) {
      logger.info("GraphSyncWorker disabled by config");
      return;
    }

    const graphStore = getGraphStoreSingleton();
    if (!(graphStore instanceof Neo4jGraphStore)) {
      logger.warn("GraphSyncWorker disabled: graph store is not Neo4jGraphStore");
      return;
    }

    try {
      await ensureGraphStoreConnected(graphStore);
      graphSyncWorker = new GraphSyncWorker(getPgPoolSingleton(), graphStore);
      graphSyncWorker.start();
    } catch (error) {
      logger.error({ err: error }, "Failed to start GraphSyncWorker");
    }
  };

  const startEntryRewriteWorker = (): void => {
    if (!runtimePgRequired()) {
      logger.info("EntryRewriteWorker disabled: runtime PG is optional for this environment");
      return;
    }
    if (!appConfig.MEMORY_REWRITE_ENABLED) {
      logger.info("EntryRewriteWorker disabled by config");
      return;
    }

    entryRewriteWorker = new EntryRewriteWorker(getPgPoolSingleton(), {
      intervalMs: appConfig.MEMORY_REWRITE_POLL_INTERVAL_MS,
      maxAttempts: appConfig.MEMORY_REWRITE_MAX_RETRIES,
      baseBackoffMs: appConfig.MEMORY_REWRITE_BASE_BACKOFF_MS,
      useLlm: appConfig.MEMORY_REWRITE_USE_LLM,
      ...(appConfig.MEMORY_REWRITE_USE_LLM
        ? { llmService: getLLMServiceSingleton() }
        : {})
    });
    entryRewriteWorker.start();
  };

  startEntryRewriteWorker();
  await startGraphSyncWorker();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "Shutting down backend server");

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    const graphSyncStopPromise = graphSyncWorker ? graphSyncWorker.stop() : Promise.resolve();
    graphSyncWorker = null;
    const rewriteStopPromise = entryRewriteWorker ? entryRewriteWorker.stop() : Promise.resolve();
    entryRewriteWorker = null;

    const results = await Promise.allSettled([
      graphSyncStopPromise,
      rewriteStopPromise,
      closePgPoolSingleton(),
      disconnectGraphStoreSingleton()
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        logger.error({ err: result.reason }, "Error during shutdown cleanup");
      }
    }
  };

  const gracefulShutdown = (signal: NodeJS.Signals): void => {
    void shutdown(signal).finally(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", () => {
    gracefulShutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    gracefulShutdown("SIGTERM");
  });

  return {
    app,
    server,
    shutdown
  };
}

function isExecutedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return pathToFileURL(entry).href === import.meta.url;
}

if (isExecutedDirectly()) {
  void startServer().catch((error: unknown) => {
    logger.error({ err: error }, "Failed to start Graphen backend");
    process.exit(1);
  });
}
