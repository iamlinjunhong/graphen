import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Neo4jGraphStore } from "../store/Neo4jGraphStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function assertFileMissing(path: string): Promise<void> {
  try {
    await access(path);
    throw new Error(`expected file to be removed: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function main(): Promise<void> {
  const repoRoot = resolve(__dirname, "../../../..");
  const backendRoot = resolve(repoRoot, "packages/backend");
  const store = new Neo4jGraphStore({
    uri: "bolt://localhost:7687",
    user: "neo4j",
    password: "",
    database: "neo4j",
    embeddingDimensions: 1024
  });
  const neo4jStore = store as unknown as Record<string, unknown>;

  const removedNeo4jMethods = [
    "saveDocument",
    "saveChunks",
    "saveEmbeddings",
    "vectorSearch",
    "chunkVectorSearch"
  ];
  for (const method of removedNeo4jMethods) {
    if (typeof neo4jStore[method] === "function") {
      throw new Error(`Neo4jGraphStore should not expose ${method}() in Phase 5`);
    }
  }

  const keptNeo4jMethods = ["getSubgraph", "getNeighbors"];
  for (const method of keptNeo4jMethods) {
    if (typeof neo4jStore[method] !== "function") {
      throw new Error(`Neo4jGraphStore should keep ${method}() in Phase 5`);
    }
  }

  const backendPackageJson = await readFile(resolve(backendRoot, "package.json"), "utf8");
  if (backendPackageJson.includes("better-sqlite3")) {
    throw new Error("packages/backend/package.json still contains better-sqlite3");
  }

  const lockfile = await readFile(resolve(repoRoot, "pnpm-lock.yaml"), "utf8");
  if (lockfile.includes("better-sqlite3")) {
    throw new Error("pnpm-lock.yaml still contains better-sqlite3");
  }

  await assertFileMissing(resolve(backendRoot, "src/services/ChatStore.ts"));
  await assertFileMissing(resolve(backendRoot, "src/services/MemoryStore.ts"));

  const envExample = await readFile(resolve(repoRoot, ".env.example"), "utf8");
  if (envExample.includes("CHAT_DB_PATH") || envExample.includes("MEMORY_DB_PATH")) {
    throw new Error(".env.example still documents SQLite env vars");
  }

  const readme = await readFile(resolve(repoRoot, "README.md"), "utf8");
  if (readme.includes("CHAT_DB_PATH")) {
    throw new Error("README.md still contains CHAT_DB_PATH");
  }
  if (!readme.includes("PG_HOST")) {
    throw new Error("README.md missing PostgreSQL env documentation");
  }

  console.log("Phase 5 completed successfully.");
  console.log("T5.1 Neo4jGraphStore write/vector methods removed: ok");
  console.log("T5.2 SQLite dependency and legacy stores removed: ok");
  console.log("T5.3 environment variable docs updated: ok");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Phase 5 failed: ${message}`);
  process.exitCode = 1;
});
