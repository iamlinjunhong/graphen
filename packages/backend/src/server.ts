import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { appConfig } from "./config.js";
import { requestLogger } from "./middleware/logger.js";
import { apiRateLimiter } from "./middleware/rateLimiter.js";
import { chatRouter } from "./routes/chat.js";
import { configRouter } from "./routes/config.js";
import { documentsRouter } from "./routes/documents.js";
import { graphRouter } from "./routes/graph.js";
import { healthRouter } from "./routes/health.js";
import { logger } from "./utils/logger.js";

export const app = express();

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

app.use("/api/documents", documentsRouter);
app.use("/api/graph", graphRouter);
app.use("/api/chat", chatRouter);
app.use("/api/config", configRouter);
app.use("/api/health", healthRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

app.listen(appConfig.PORT, () => {
  logger.info(`Graphen backend is running on http://localhost:${appConfig.PORT}`);
});
