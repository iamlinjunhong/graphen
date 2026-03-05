import { appConfig } from "../config.js";
import {
  closePgPoolSingleton,
  getPgPoolSingleton
} from "../runtime/PgPool.js";
import {
  applyPhase0MemorySchema,
  assertPostgresVersion,
  ensurePgvectorExtension,
  getPostgresVersion,
  verifyPhase0Schema
} from "../runtime/pgMemorySchema.js";

async function main(): Promise<void> {
  const pool = getPgPoolSingleton();
  try {
    const version = await getPostgresVersion(pool);
    assertPostgresVersion(version);

    const pgvectorReady = await ensurePgvectorExtension(pool);
    if (!pgvectorReady) {
      throw new Error("pgvector extension is not available and could not be created");
    }

    await applyPhase0MemorySchema(pool);
    const verification = await verifyPhase0Schema(pool);
    if (verification.missingTables.length > 0 || verification.missingIndexes.length > 0) {
      throw new Error(
        `Schema verification failed: missingTables=${verification.missingTables.join(",") || "none"}, missingIndexes=${verification.missingIndexes.join(",") || "none"}`
      );
    }

    const dbInfo = await pool.query<{
      database: string;
      user_name: string;
    }>("SELECT current_database() AS database, current_user AS user_name");
    const row = dbInfo.rows[0];
    if (!row) {
      throw new Error("Unable to read current database/user from PostgreSQL");
    }

    console.log("Phase 0 completed successfully.");
    console.log(`PostgreSQL version: ${version.version} (major=${version.major})`);
    console.log(`Database: ${row.database}`);
    console.log(`User: ${row.user_name}`);
    console.log(`Configured host: ${appConfig.PG_HOST}:${appConfig.PG_PORT}`);
    console.log(`Configured database: ${appConfig.PG_DATABASE}`);
    console.log(`Configured user: ${appConfig.PG_USER}`);
    console.log(`pgvector extension: installed`);
    console.log(`Verified tables: ${verification.missingTables.length === 0 ? "ok" : "failed"}`);
    console.log(`Verified indexes: ${verification.missingIndexes.length === 0 ? "ok" : "failed"}`);
  } finally {
    await closePgPoolSingleton();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Phase 0 failed: ${message}`);
  process.exitCode = 1;
});

