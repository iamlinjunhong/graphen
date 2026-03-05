import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { closePgPoolSingleton } from "../runtime/PgPool.js";
import { createMemoryRouter } from "../routes/memory.js";
import { MemoryService } from "../services/MemoryService.js";
import { PgMemoryStore } from "../services/PgMemoryStore.js";

async function main(): Promise<void> {
  const runTag = randomUUID().slice(0, 8);
  const entryStore = new PgMemoryStore();
  const service = new MemoryService(entryStore);
  const app = express();
  app.use(express.json());
  app.use(
    "/api/memory",
    createMemoryRouter({
      entryStore,
      service
    })
  );

  const cleanupIds: string[] = [];

  try {
    // T2.1.2 POST /entries
    const createPrimary = await request(app).post("/api/memory/entries").send({
      content: `Phase2 primary ${runTag}`,
      metadata: {
        categories: ["phase2", "manual"],
        sourceType: "manual"
      },
      reextract: false
    });
    if (createPrimary.status !== 201) {
      throw new Error(`create primary entry failed: status=${createPrimary.status}`);
    }
    const primaryId = createPrimary.body?.entry?.id as string | undefined;
    if (!primaryId) {
      throw new Error("create primary entry failed: missing entry id");
    }
    cleanupIds.push(primaryId);

    // T2.1.4 PUT /entries/:id (trigger re-extract path via facts replacement)
    const updatePrimary = await request(app)
      .put(`/api/memory/entries/${primaryId}`)
      .send({
        content: `Phase2 primary updated ${runTag}`,
        reextract: false,
        replaceFacts: true,
        facts: [
          {
            subjectText: "张三",
            predicate: "职位",
            objectText: "CTO",
            valueType: "text",
            confidence: 0.95
          }
        ]
      });
    if (updatePrimary.status !== 200) {
      throw new Error(`update primary entry failed: status=${updatePrimary.status}`);
    }

    // Secondary entry to validate related lookup
    const createSecondary = await request(app).post("/api/memory/entries").send({
      content: `Phase2 secondary ${runTag}`,
      metadata: {
        categories: ["phase2", "team"],
        sourceType: "manual"
      },
      reextract: false,
      facts: [
        {
          subjectText: "张三",
          predicate: "负责",
          objectText: "技术部门",
          valueType: "text",
          confidence: 0.9
        }
      ]
    });
    if (createSecondary.status !== 201) {
      throw new Error(`create secondary entry failed: status=${createSecondary.status}`);
    }
    const secondaryId = createSecondary.body?.entry?.id as string | undefined;
    if (!secondaryId) {
      throw new Error("create secondary entry failed: missing entry id");
    }
    cleanupIds.push(secondaryId);

    // Phase C regression seed: multi-page entries with different content/sourceType
    const sortFixtures = [
      { content: `Phase2 sort ${runTag} A`, sourceType: "document" },
      { content: `Phase2 sort ${runTag} B`, sourceType: "chat_user" },
      { content: `Phase2 sort ${runTag} C`, sourceType: "manual" },
      { content: `Phase2 sort ${runTag} D`, sourceType: "chat_assistant" },
    ] as const;
    const sortFixtureEntries: Array<{ id: string; content: string; sourceType: string }> = [];
    for (const fixture of sortFixtures) {
      const created = await request(app).post("/api/memory/entries").send({
        content: fixture.content,
        metadata: {
          categories: ["phase2-sort", runTag],
          sourceType: fixture.sourceType
        },
        reextract: false
      });
      if (created.status !== 201) {
        throw new Error(`create sort fixture failed: status=${created.status}`);
      }
      const id = created.body?.entry?.id as string | undefined;
      if (!id) {
        throw new Error("create sort fixture failed: missing entry id");
      }
      cleanupIds.push(id);
      sortFixtureEntries.push({ id, content: fixture.content, sourceType: fixture.sourceType });
    }

    // T2.1.1 POST /entries/filter
    const filterResp = await request(app).post("/api/memory/entries/filter").send({
      query: "Phase2",
      page: 1,
      pageSize: 20,
      sortBy: "updatedAt",
      sortOrder: "desc",
      filters: {
        categories: ["phase2"]
      }
    });
    if (filterResp.status !== 200 || (filterResp.body?.total ?? 0) < 2) {
      throw new Error(`entries/filter failed: status=${filterResp.status}, total=${filterResp.body?.total}`);
    }

    // T2.1.1.1 entries/filter supports content sort with stable cross-page order
    const contentSortPage1 = await request(app).post("/api/memory/entries/filter").send({
      page: 1,
      pageSize: 2,
      sortBy: "content",
      sortOrder: "asc",
      filters: {
        categories: ["phase2-sort", runTag]
      }
    });
    const contentSortPage2 = await request(app).post("/api/memory/entries/filter").send({
      page: 2,
      pageSize: 2,
      sortBy: "content",
      sortOrder: "asc",
      filters: {
        categories: ["phase2-sort", runTag]
      }
    });
    if (contentSortPage1.status !== 200 || contentSortPage2.status !== 200) {
      throw new Error(
        `content sort pagination failed: p1=${contentSortPage1.status}, p2=${contentSortPage2.status}`
      );
    }

    const expectedContentOrder = [...sortFixtureEntries]
      .sort((a, b) => a.content.localeCompare(b.content, "zh-CN"))
      .map((item) => item.id);
    const contentCombinedIds = [
      ...(contentSortPage1.body?.entries ?? []).map((entry: { id: string }) => entry.id),
      ...(contentSortPage2.body?.entries ?? []).map((entry: { id: string }) => entry.id)
    ];
    if (contentCombinedIds.length !== expectedContentOrder.length) {
      throw new Error(
        `content sort pagination size mismatch: expected=${expectedContentOrder.length}, got=${contentCombinedIds.length}`
      );
    }
    if (JSON.stringify(contentCombinedIds) !== JSON.stringify(expectedContentOrder)) {
      throw new Error(
        `content sort pagination order mismatch: expected=${expectedContentOrder.join(",")}, got=${contentCombinedIds.join(",")}`
      );
    }

    // T2.1.1.2 entries/filter supports sourceType sort with stable cross-page order
    const sourceSortPage1 = await request(app).post("/api/memory/entries/filter").send({
      page: 1,
      pageSize: 2,
      sortBy: "sourceType",
      sortOrder: "asc",
      filters: {
        categories: ["phase2-sort", runTag]
      }
    });
    const sourceSortPage2 = await request(app).post("/api/memory/entries/filter").send({
      page: 2,
      pageSize: 2,
      sortBy: "sourceType",
      sortOrder: "asc",
      filters: {
        categories: ["phase2-sort", runTag]
      }
    });
    if (sourceSortPage1.status !== 200 || sourceSortPage2.status !== 200) {
      throw new Error(
        `sourceType sort pagination failed: p1=${sourceSortPage1.status}, p2=${sourceSortPage2.status}`
      );
    }

    const expectedSourceOrder = [...sortFixtureEntries]
      .sort((a, b) => a.sourceType.localeCompare(b.sourceType))
      .map((item) => item.id);
    const sourceCombinedIds = [
      ...(sourceSortPage1.body?.entries ?? []).map((entry: { id: string }) => entry.id),
      ...(sourceSortPage2.body?.entries ?? []).map((entry: { id: string }) => entry.id)
    ];
    if (sourceCombinedIds.length !== expectedSourceOrder.length) {
      throw new Error(
        `sourceType sort pagination size mismatch: expected=${expectedSourceOrder.length}, got=${sourceCombinedIds.length}`
      );
    }
    if (JSON.stringify(sourceCombinedIds) !== JSON.stringify(expectedSourceOrder)) {
      throw new Error(
        `sourceType sort pagination order mismatch: expected=${expectedSourceOrder.join(",")}, got=${sourceCombinedIds.join(",")}`
      );
    }

    // T2.1.3 GET /entries/:id
    const getEntryResp = await request(app).get(`/api/memory/entries/${primaryId}`);
    if (getEntryResp.status !== 200) {
      throw new Error(`get entry failed: status=${getEntryResp.status}`);
    }

    // T2.1.7 GET /entries/:id/facts
    const factsResp = await request(app).get(`/api/memory/entries/${primaryId}/facts`);
    if (factsResp.status !== 200 || !Array.isArray(factsResp.body) || factsResp.body.length === 0) {
      throw new Error(`get entry facts failed: status=${factsResp.status}`);
    }

    // T2.1.9 GET /entries/:id/related
    const relatedResp = await request(app)
      .get(`/api/memory/entries/${primaryId}/related`)
      .query({ limit: 5, chatSessionId: `phase2-session-${runTag}` });
    if (relatedResp.status !== 200 || !Array.isArray(relatedResp.body) || relatedResp.body.length === 0) {
      throw new Error(`get related entries failed: status=${relatedResp.status}`);
    }

    // T2.1.10 POST /entries/:id/access-log
    const manualAccessResp = await request(app)
      .post(`/api/memory/entries/${primaryId}/access-log`)
      .send({});
    if (manualAccessResp.status !== 201) {
      throw new Error(`post access-log failed: status=${manualAccessResp.status}`);
    }
    if (manualAccessResp.body?.accessType !== "manual_view") {
      throw new Error(`post access-log failed: unexpected accessType=${String(manualAccessResp.body?.accessType)}`);
    }
    if (manualAccessResp.body?.chatSessionId !== "ui:memory-weaving") {
      throw new Error(
        `post access-log failed: unexpected chatSessionId=${String(manualAccessResp.body?.chatSessionId)}`
      );
    }

    // T2.1.8 GET /entries/:id/access-log
    const accessLogResp = await request(app).get(`/api/memory/entries/${primaryId}/access-log`);
    if (accessLogResp.status !== 200 || !Array.isArray(accessLogResp.body?.logs)) {
      throw new Error(`get access logs failed: status=${accessLogResp.status}`);
    }
    const hasManualView = accessLogResp.body.logs.some((row: { access_type?: string }) => row.access_type === "manual_view");
    if (!hasManualView) {
      throw new Error("get access logs failed: missing manual_view log");
    }

    // T2.1.11 validation: blank content should be 400
    const invalidContentResp = await request(app).post("/api/memory/entries").send({
      content: "   ",
      reextract: false
    });
    if (invalidContentResp.status !== 400) {
      throw new Error(`blank content should return 400, got ${invalidContentResp.status}`);
    }

    // T2.2 GET /categories
    const categoriesResp = await request(app).get("/api/memory/categories");
    if (categoriesResp.status !== 200 || !Array.isArray(categoriesResp.body?.categories)) {
      throw new Error(`get categories failed: status=${categoriesResp.status}`);
    }

    // T2.3 GET /stats
    const statsResp = await request(app).get("/api/memory/stats");
    if (statsResp.status !== 200 || typeof statsResp.body?.total !== "number") {
      throw new Error(`get stats failed: status=${statsResp.status}`);
    }

    // T2.1.5 POST /entries/batch
    const batchPauseResp = await request(app).post("/api/memory/entries/batch").send({
      ids: [primaryId, secondaryId],
      action: "pause"
    });
    if (batchPauseResp.status !== 200 || (batchPauseResp.body?.affected ?? 0) < 2) {
      throw new Error(`batch pause failed: status=${batchPauseResp.status}`);
    }

    const batchResumeResp = await request(app).post("/api/memory/entries/batch").send({
      ids: [primaryId, secondaryId],
      action: "resume"
    });
    if (batchResumeResp.status !== 200 || (batchResumeResp.body?.affected ?? 0) < 2) {
      throw new Error(`batch resume failed: status=${batchResumeResp.status}`);
    }

    const batchConfirmResp = await request(app).post("/api/memory/entries/batch").send({
      ids: [primaryId, secondaryId],
      action: "confirm",
      sync_facts: true
    });
    if (batchConfirmResp.status !== 200 || (batchConfirmResp.body?.affected ?? 0) < 2) {
      throw new Error(`batch confirm failed: status=${batchConfirmResp.status}`);
    }

    // T2.1.12 validation: invalid UUID ids should be 400
    const invalidBatchResp = await request(app).post("/api/memory/entries/batch").send({
      ids: ["not-a-uuid"],
      action: "pause"
    });
    if (invalidBatchResp.status !== 400) {
      throw new Error(`invalid batch ids should return 400, got ${invalidBatchResp.status}`);
    }

    // T2.1.6 DELETE /entries
    const deleteResp = await request(app).delete("/api/memory/entries").send({
      ids: [primaryId, secondaryId]
    });
    if (deleteResp.status !== 200 || (deleteResp.body?.affected ?? 0) < 2) {
      throw new Error(`delete entries failed: status=${deleteResp.status}`);
    }
    cleanupIds.length = 0;

    const invalidDeleteResp = await request(app).delete("/api/memory/entries").send({
      ids: ["not-a-uuid"]
    });
    if (invalidDeleteResp.status !== 400) {
      throw new Error(`invalid delete ids should return 400, got ${invalidDeleteResp.status}`);
    }

    // T2.4 facts compatibility + deprecation header
    const factsCompatResp = await request(app).get("/api/memory/facts");
    const deprecationHeader = factsCompatResp.header["deprecation"];
    if (factsCompatResp.status !== 200 || deprecationHeader !== "true") {
      throw new Error(
        `facts compatibility failed: status=${factsCompatResp.status}, deprecation=${String(deprecationHeader)}`
      );
    }

    console.log("Phase 2 completed successfully.");
    console.log(`Run tag: ${runTag}`);
    console.log("T2.1 entries route group: ok");
    console.log("T2.2 categories endpoint: ok");
    console.log("T2.3 stats endpoint: ok");
    console.log("T2.4 facts compatibility (deprecated): ok");
  } finally {
    if (cleanupIds.length > 0) {
      await entryStore.deleteEntries(cleanupIds);
    }
    await closePgPoolSingleton();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Phase 2 failed: ${message}`);
  process.exitCode = 1;
});
