import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";
import { appConfig } from "../config.js";
import { logger } from "../utils/logger.js";

export interface PgPoolRuntimeConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  maxConnections: number;
}

function buildPoolConfig(
  overrides: Partial<PgPoolRuntimeConfig> = {}
): PoolConfig {
  const config: PgPoolRuntimeConfig = {
    host: overrides.host ?? appConfig.PG_HOST,
    port: overrides.port ?? appConfig.PG_PORT,
    database: overrides.database ?? appConfig.PG_DATABASE,
    user: overrides.user ?? appConfig.PG_USER,
    password: overrides.password ?? appConfig.PG_PASSWORD,
    maxConnections: overrides.maxConnections ?? appConfig.PG_MAX_CONNECTIONS
  };

  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  };
}

let pgPoolSingleton: Pool | null = null;

export function createPgPool(overrides: Partial<PgPoolRuntimeConfig> = {}): Pool {
  const pool = new Pool(buildPoolConfig(overrides));
  pool.on("error", (error) => {
    logger.error(
      { err: error },
      "Unexpected error on idle PostgreSQL client"
    );
  });
  return pool;
}

export function getPgPoolSingleton(): Pool {
  if (!pgPoolSingleton) {
    pgPoolSingleton = createPgPool();
  }
  return pgPoolSingleton;
}

export async function closePgPoolSingleton(): Promise<void> {
  if (!pgPoolSingleton) {
    return;
  }
  const pool = pgPoolSingleton;
  pgPoolSingleton = null;
  await pool.end();
}

export async function checkPgPoolHealth(pool: Pool = getPgPoolSingleton()): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function queryPg<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
  pool: Pool = getPgPoolSingleton()
): Promise<QueryResult<T>> {
  return pool.query<T>(text, values as unknown[]);
}

