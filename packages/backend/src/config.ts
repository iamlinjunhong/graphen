import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, "../../../.env") });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  MAX_UPLOAD_SIZE: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  CHAT_DB_PATH: z.string().default("data/chat.db"),
  CACHE_DIR: z.string().default("data/cache"),
  MAX_CHUNKS_PER_DOCUMENT: z.coerce.number().int().positive().default(500),
  CHUNK_SIZE: z.coerce.number().int().positive().default(1500),
  CHUNK_OVERLAP: z.coerce.number().int().min(0).default(200),
  MAX_DOCUMENT_ESTIMATED_TOKENS: z.coerce.number().int().positive().default(500_000),
  LLM_PROVIDER: z.enum(["gemini", "qwen", "openai"]).default("gemini"),
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_BASE_URL: z.string().default("https://generativelanguage.googleapis.com/v1beta/openai/"),
  GEMINI_CHAT_MODEL: z.string().default("gemini-3-flash-preview"),
  GEMINI_EMBEDDING_MODEL: z.string().default("text-embedding-004"),
  QWEN_API_KEY: z.string().default(""),
  QWEN_BASE_URL: z.string().default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  QWEN_CHAT_MODEL: z.string().default("qwen3.5-plus"),
  QWEN_EMBEDDING_MODEL: z.string().default("text-embedding-v3"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  OPENAI_CHAT_MODEL: z.string().default("gpt-5.3-codex"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDING_API_KEY: z.string().default(""),
  EMBEDDING_BASE_URL: z.string().default(""),
  LLM_MAX_CONCURRENT: z.coerce.number().int().positive().default(5),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  LLM_RETRY_DELAY_MS: z.coerce.number().int().positive().default(1000),
  LLM_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(30),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  NEO4J_URI: z.string().default("bolt://localhost:7687"),
  NEO4J_USER: z.string().default("neo4j"),
  NEO4J_PASSWORD: z.string().default(""),
  NEO4J_DATABASE: z.string().default("neo4j"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024)
});

export type AppConfig = z.infer<typeof envSchema>;
export const appConfig: AppConfig = envSchema.parse(process.env);
