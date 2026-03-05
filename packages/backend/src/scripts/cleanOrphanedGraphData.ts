/**
 * 清理脚本：移除 Neo4j 中引用了已删除文档的孤立图数据。
 *
 * 逻辑：
 * 1. 从 Neo4j 收集所有节点/边上的 sourceDocumentIds
 * 2. 从 PostgreSQL 查询哪些文档 ID 仍然存在
 * 3. 对于已不存在的文档 ID，从节点/边的 sourceDocumentIds 中移除
 * 4. 如果节点/边的 sourceDocumentIds 变为空，则整个删除
 *
 * 用法: npx tsx src/scripts/cleanOrphanedGraphData.ts
 */

import { appConfig } from "../config.js";
import { Neo4jGraphStore } from "../store/Neo4jGraphStore.js";
import { getPgPoolSingleton, closePgPoolSingleton } from "../runtime/PgPool.js";

async function main() {
  console.log("=== 清理 Neo4j 孤立图数据 ===\n");

  const neo4j = Neo4jGraphStore.fromEnv();
  await neo4j.connect();
  console.log(`Neo4j 已连接: ${appConfig.NEO4J_URI}`);

  const pool = getPgPoolSingleton();
  console.log(`PostgreSQL 已连接: ${appConfig.PG_HOST}:${appConfig.PG_PORT}/${appConfig.PG_DATABASE}\n`);

  // Step 1: 从 Neo4j 收集所有 sourceDocumentIds
  console.log("[1/4] 从 Neo4j 收集所有 sourceDocumentIds...");

  const allDocIds = new Set<string>();

  const nodeResult = await (neo4j as unknown as {
    runCypherRead<T>(query: string, params?: Record<string, unknown>): Promise<T[]>;
  }).runCypherRead?.(
    `MATCH (e:Entity) WHERE e.sourceDocumentIds IS NOT NULL UNWIND e.sourceDocumentIds AS docId RETURN DISTINCT docId`
  ) ?? [];

  // Use the public runCypher or withSession — let me use a direct approach via the driver
  // Actually, Neo4jGraphStore doesn't expose a read query method, so let me use the driver directly
  const neo4jDriver = await import("neo4j-driver");
  const driver = neo4jDriver.default.driver(
    appConfig.NEO4J_URI,
    neo4jDriver.default.auth.basic(appConfig.NEO4J_USER, appConfig.NEO4J_PASSWORD)
  );

  const sessionConfig: Record<string, unknown> = {
    defaultAccessMode: neo4jDriver.default.session.READ
  };
  if (appConfig.NEO4J_DATABASE) {
    sessionConfig.database = appConfig.NEO4J_DATABASE;
  }

  const session = driver.session(sessionConfig);

  try {
    const nodeDocResult = await session.run(
      `MATCH (e:Entity)
       WHERE e.sourceDocumentIds IS NOT NULL AND size(e.sourceDocumentIds) > 0
       UNWIND e.sourceDocumentIds AS docId
       RETURN DISTINCT docId`
    );
    for (const record of nodeDocResult.records) {
      allDocIds.add(record.get("docId") as string);
    }

    const edgeDocResult = await session.run(
      `MATCH ()-[r:RELATED_TO]-()
       WHERE r.sourceDocumentIds IS NOT NULL AND size(r.sourceDocumentIds) > 0
       UNWIND r.sourceDocumentIds AS docId
       RETURN DISTINCT docId`
    );
    for (const record of edgeDocResult.records) {
      allDocIds.add(record.get("docId") as string);
    }
  } finally {
    await session.close();
  }

  console.log(`  找到 ${allDocIds.size} 个不同的文档 ID 引用\n`);

  if (allDocIds.size === 0) {
    console.log("没有文档引用，无需清理。");
    await cleanup(driver, neo4j);
    return;
  }

  // Step 2: 查询 PostgreSQL 中哪些文档仍然存在
  console.log("[2/4] 查询 PostgreSQL 中现存的文档...");

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const validUuids = Array.from(allDocIds).filter((id) => uuidPattern.test(id));
  const nonUuids = Array.from(allDocIds).filter((id) => !uuidPattern.test(id));

  if (nonUuids.length > 0) {
    console.log(`  跳过 ${nonUuids.length} 个非 UUID 格式的 ID: ${nonUuids.slice(0, 5).join(", ")}${nonUuids.length > 5 ? "..." : ""}`);
  }

  const existingDocIds = new Set<string>();
  if (validUuids.length > 0) {
    const pgResult = await pool.query<{ id: string }>(
      `SELECT id FROM documents WHERE id = ANY($1::uuid[])`,
      [validUuids]
    );
    for (const row of pgResult.rows) {
      existingDocIds.add(row.id);
    }
  }

  const orphanedDocIds = validUuids.filter((id) => !existingDocIds.has(id));
  console.log(`  PostgreSQL 中存在: ${existingDocIds.size} 个文档`);
  console.log(`  已删除（孤立）: ${orphanedDocIds.length} 个文档\n`);

  if (orphanedDocIds.length === 0) {
    console.log("没有孤立的文档引用，无需清理。");
    await cleanup(driver, neo4j);
    return;
  }

  console.log("  孤立文档 ID:");
  for (const id of orphanedDocIds) {
    console.log(`    - ${id}`);
  }
  console.log();

  // Step 3: 清理边
  console.log("[3/4] 清理 Neo4j 中的孤立边...");

  const writeSessionConfig: Record<string, unknown> = {
    defaultAccessMode: neo4jDriver.default.session.WRITE
  };
  if (appConfig.NEO4J_DATABASE) {
    writeSessionConfig.database = appConfig.NEO4J_DATABASE;
  }

  const writeSession = driver.session(writeSessionConfig);

  try {
    for (const docId of orphanedDocIds) {
      // 删除仅由该文档产生的边，或从多来源边中移除该文档 ID
      const edgeResult = await writeSession.run(
        `MATCH ()-[r:RELATED_TO]-()
         WHERE $docId IN r.sourceDocumentIds
         WITH r, [x IN r.sourceDocumentIds WHERE x <> $docId] AS remaining
         WITH r, remaining, CASE WHEN size(remaining) = 0 THEN true ELSE false END AS shouldDelete
         FOREACH (_ IN CASE WHEN shouldDelete THEN [1] ELSE [] END | DELETE r)
         FOREACH (_ IN CASE WHEN NOT shouldDelete THEN [1] ELSE [] END | SET r.sourceDocumentIds = remaining)
         RETURN count(r) AS affected, sum(CASE WHEN shouldDelete THEN 1 ELSE 0 END) AS deleted`,
        { docId }
      );
      const rec = edgeResult.records[0];
      if (rec) {
        const affected = (rec.get("affected") as { toNumber?: () => number })?.toNumber?.() ?? rec.get("affected");
        const deleted = (rec.get("deleted") as { toNumber?: () => number })?.toNumber?.() ?? rec.get("deleted");
        if ((affected as number) > 0) {
          console.log(`  文档 ${docId.slice(0, 8)}…: ${affected} 条边受影响, ${deleted} 条删除`);
        }
      }
    }

    // Step 4: 清理节点
    console.log("\n[4/4] 清理 Neo4j 中的孤立节点...");

    for (const docId of orphanedDocIds) {
      const nodeResult = await writeSession.run(
        `MATCH (e:Entity)
         WHERE $docId IN e.sourceDocumentIds
         WITH e, [x IN e.sourceDocumentIds WHERE x <> $docId] AS remaining
         WITH e, remaining, CASE WHEN size(remaining) = 0 THEN true ELSE false END AS shouldDelete
         FOREACH (_ IN CASE WHEN shouldDelete THEN [1] ELSE [] END | DETACH DELETE e)
         FOREACH (_ IN CASE WHEN NOT shouldDelete THEN [1] ELSE [] END | SET e.sourceDocumentIds = remaining)
         RETURN count(e) AS affected, sum(CASE WHEN shouldDelete THEN 1 ELSE 0 END) AS deleted`,
        { docId }
      );
      const rec = nodeResult.records[0];
      if (rec) {
        const affected = (rec.get("affected") as { toNumber?: () => number })?.toNumber?.() ?? rec.get("affected");
        const deleted = (rec.get("deleted") as { toNumber?: () => number })?.toNumber?.() ?? rec.get("deleted");
        if ((affected as number) > 0) {
          console.log(`  文档 ${docId.slice(0, 8)}…: ${affected} 个节点受影响, ${deleted} 个删除`);
        }
      }
    }
  } finally {
    await writeSession.close();
  }

  console.log("\n=== 清理完成 ===");
  await cleanup(driver, neo4j);
}

async function cleanup(driver: { close(): Promise<void> }, neo4j: Neo4jGraphStore) {
  await driver.close();
  await neo4j.disconnect();
  await closePgPoolSingleton();
}

main().catch((err) => {
  console.error("清理脚本失败:", err);
  process.exit(1);
});
