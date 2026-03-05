import { Pool } from "pg";
import { appConfig } from "../config.js";
import { applyMemoryFollowupSchema, PHASE0_MEMORY_SCHEMA_SQL } from "./pgMemorySchema.js";
import { runtimePgRequired } from "./runtimeMode.js";
import { logger } from "../utils/logger.js";

const EXTENSION_SQL = [
  "CREATE EXTENSION IF NOT EXISTS pgcrypto",
  "CREATE EXTENSION IF NOT EXISTS vector"
];

const MEMORY_SCHEMA_SQL_WITHOUT_EXTENSIONS = PHASE0_MEMORY_SCHEMA_SQL
  .split("\n")
  .filter((line) => !line.trim().toUpperCase().startsWith("CREATE EXTENSION"))
  .join("\n");

let bootstrapPromise: Promise<void> | null = null;
let bootstrapDone = false;

export function shouldBootstrapRuntimePg(): boolean {
  return appConfig.PG_AUTO_BOOTSTRAP && runtimePgRequired();
}

export async function ensureRuntimePgBootstrap(): Promise<void> {
  if (!shouldBootstrapRuntimePg() || bootstrapDone) {
    return;
  }

  if (!bootstrapPromise) {
    bootstrapPromise = runBootstrap()
      .then(() => {
        bootstrapDone = true;
      })
      .catch((error) => {
        bootstrapPromise = null;
        throw error;
      });
  }

  return bootstrapPromise;
}

async function runBootstrap(): Promise<void> {
  const bootstrapUser = resolveBootstrapUser();
  if (!bootstrapUser) {
    throw new Error(
      "PG bootstrap requires PG_BOOTSTRAP_USER (or PGUSER/USER env) to connect admin database"
    );
  }

  const adminPool = createPool({
    database: appConfig.PG_BOOTSTRAP_DATABASE,
    user: bootstrapUser,
    password: appConfig.PG_BOOTSTRAP_PASSWORD
  });

  try {
    await ensureRole(adminPool, appConfig.PG_USER, appConfig.PG_PASSWORD);
    await ensureDatabase(adminPool, appConfig.PG_DATABASE, appConfig.PG_USER);
  } finally {
    await adminPool.end();
  }

  const adminTargetPool = createPool({
    database: appConfig.PG_DATABASE,
    user: bootstrapUser,
    password: appConfig.PG_BOOTSTRAP_PASSWORD
  });
  try {
    await ensureExtensions(adminTargetPool);
    await adminTargetPool.query(
      `GRANT USAGE, CREATE ON SCHEMA public TO ${quoteIdentifier(appConfig.PG_USER)}`
    );
    await adminTargetPool.query(
      `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${quoteIdentifier(appConfig.PG_USER)}`
    );
    await adminTargetPool.query(
      `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdentifier(appConfig.PG_USER)}`
    );
  } finally {
    await adminTargetPool.end();
  }

  const runtimePool = createPool({
    database: appConfig.PG_DATABASE,
    user: appConfig.PG_USER,
    password: appConfig.PG_PASSWORD
  });
  try {
    await runtimePool.query(MEMORY_SCHEMA_SQL_WITHOUT_EXTENSIONS);
    await applyMemoryFollowupSchema(runtimePool);
  } finally {
    await runtimePool.end();
  }

  logger.info(
    {
      database: appConfig.PG_DATABASE,
      user: appConfig.PG_USER,
      host: appConfig.PG_HOST,
      port: appConfig.PG_PORT
    },
    "Runtime PostgreSQL bootstrap completed"
  );
}

function createPool(options: {
  database: string;
  user: string;
  password: string;
}): Pool {
  return new Pool({
    host: appConfig.PG_HOST,
    port: appConfig.PG_PORT,
    database: options.database,
    user: options.user,
    password: options.password,
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000
  });
}

function resolveBootstrapUser(): string {
  const configured = appConfig.PG_BOOTSTRAP_USER.trim();
  if (configured) {
    return configured;
  }
  const fromEnv = process.env.PGUSER?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const fromUser = process.env.USER?.trim();
  if (fromUser) {
    return fromUser;
  }
  return appConfig.PG_USER;
}

async function ensureRole(pool: Pool, user: string, password: string): Promise<void> {
  const roleResult = await pool.query<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [user]
  );
  const roleExists = Boolean(roleResult.rows[0]?.exists);

  if (!roleExists) {
    if (password.length > 0) {
      await pool.query(
        `CREATE ROLE ${quoteIdentifier(user)} LOGIN PASSWORD ${quoteLiteral(password)}`
      );
    } else {
      await pool.query(`CREATE ROLE ${quoteIdentifier(user)} LOGIN`);
    }
    return;
  }

  if (password.length > 0) {
    await pool.query(
      `ALTER ROLE ${quoteIdentifier(user)} WITH LOGIN PASSWORD ${quoteLiteral(password)}`
    );
  } else {
    await pool.query(`ALTER ROLE ${quoteIdentifier(user)} WITH LOGIN`);
  }
}

async function ensureDatabase(pool: Pool, database: string, owner: string): Promise<void> {
  const dbResult = await pool.query<{ owner: string | null }>(
    `
      SELECT pg_get_userbyid(datdba) AS owner
      FROM pg_database
      WHERE datname = $1
    `,
    [database]
  );

  if (!dbResult.rows[0]) {
    await pool.query(
      `CREATE DATABASE ${quoteIdentifier(database)} OWNER ${quoteIdentifier(owner)}`
    );
    return;
  }

  const currentOwner = dbResult.rows[0].owner;
  if (currentOwner !== owner) {
    await pool.query(
      `ALTER DATABASE ${quoteIdentifier(database)} OWNER TO ${quoteIdentifier(owner)}`
    );
  }
}

async function ensureExtensions(pool: Pool): Promise<void> {
  for (const sql of EXTENSION_SQL) {
    await pool.query(sql);
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
