import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Document } from "@graphen/shared";
import { createDocumentsRouter } from "../../src/routes/documents.js";
import type { DocumentPipelineResult, PipelineStatusEvent } from "../../src/pipeline/types.js";
import type { DocumentPipeline } from "../../src/pipeline/DocumentPipeline.js";
import { FakeGraphStore } from "../helpers/FakeGraphStore.js";

describe("documents api", () => {
  let store: FakeGraphStore;
  let app: ReturnType<typeof express>;
  let uploadsDir: string;
  let cacheDir: string;
  const cleanupDirs: string[] = [];

  beforeEach(() => {
    store = new FakeGraphStore();

    const suffix = randomUUID();
    uploadsDir = resolve("tmp", `api-docs-uploads-${suffix}`);
    cacheDir = resolve("tmp", `api-docs-cache-${suffix}`);
    cleanupDirs.push(uploadsDir, cacheDir);

    const pipeline = new FakePipeline(store);
    app = express();
    app.use(express.json());
    app.use(
      "/api/documents",
      createDocumentsRouter({
        store,
        pipeline: pipeline as unknown as DocumentPipeline,
        ensureStoreConnected: async () => {},
        uploadsDir,
        cacheDir
      })
    );
  });

  afterEach(() => {
    for (const path of cleanupDirs.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("uploads a document and supports list/detail/status endpoints", async () => {
    const uploadResponse = await request(app)
      .post("/api/documents/upload")
      .attach("file", Buffer.from("Graphen uses Neo4j for graph search", "utf8"), {
        filename: "demo.txt",
        contentType: "text/plain"
      });

    expect(uploadResponse.status).toBe(202);
    expect(uploadResponse.body.message).toBe("File upload accepted");
    const documentId = uploadResponse.headers["x-document-id"];
    expect(typeof documentId).toBe("string");
    // B1/B2: documentId also present in response body
    expect(uploadResponse.body.documentId).toBe(documentId);

    await waitFor(async () => {
      const docs = await store.getDocuments();
      return docs.some((doc) => doc.id === documentId && doc.status === "completed");
    });

    const listResponse = await request(app)
      .get("/api/documents")
      .query({ page: 1, pageSize: 10 });
    expect(listResponse.status).toBe(200);
    expect(listResponse.headers["x-total-count"]).toBe("1");
    expect(listResponse.body.documents).toHaveLength(1);

    const detailResponse = await request(app).get(`/api/documents/${documentId}`);
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.document.id).toBe(documentId);
    expect(detailResponse.body.document.status).toBe("completed");

    const statusResponse = await request(app).get(`/api/documents/${documentId}/status`);
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body).toEqual({
      id: documentId,
      status: "completed"
    });

    const sseResponse = await request(app)
      .get(`/api/documents/${documentId}/status`)
      .set("Accept", "text/event-stream");
    expect(sseResponse.status).toBe(200);
    expect(sseResponse.headers["content-type"]).toContain("text/event-stream");
    expect(sseResponse.text).toContain("\"status\":\"completed\"");
  });

  it("supports reparse and delete", async () => {
    const uploadResponse = await request(app)
      .post("/api/documents/upload")
      .attach("file", Buffer.from("Graphen supports GraphRAG", "utf8"), {
        filename: "guide.md",
        contentType: "text/markdown"
      });
    const documentId = uploadResponse.headers["x-document-id"];
    expect(typeof documentId).toBe("string");

    await waitFor(async () => {
      const doc = (await store.getDocuments()).find((item) => item.id === documentId);
      return doc?.status === "completed";
    });

    const reparseResponse = await request(app).post(`/api/documents/${documentId}/reparse`);
    expect(reparseResponse.status).toBe(202);
    expect(reparseResponse.body).toEqual({
      message: "Reparse job queued",
      id: documentId
    });

    await waitFor(async () => {
      const doc = (await store.getDocuments()).find((item) => item.id === documentId);
      return doc?.status === "completed";
    });

    const deleteResponse = await request(app).delete(`/api/documents/${documentId}`);
    expect(deleteResponse.status).toBe(204);
    expect(existsSync(resolve(uploadsDir, documentId))).toBe(false);
    expect(existsSync(resolve(cacheDir, documentId))).toBe(false);

    const detailResponse = await request(app).get(`/api/documents/${documentId}`);
    expect(detailResponse.status).toBe(404);
  });
});

class FakePipeline {
  private readonly emitter = new EventEmitter();

  constructor(private readonly store: FakeGraphStore) {}

  onStatus(listener: (event: PipelineStatusEvent) => void): void {
    this.emitter.on("status", listener);
  }

  async process(document: Document, buffer: Buffer): Promise<DocumentPipelineResult> {
    this.emit(document.id, "parsing", 10);
    await sleep(5);
    this.emit(document.id, "extracting", 60);
    await sleep(5);

    const words = buffer
      .toString("utf8")
      .trim()
      .split(/\s+/)
      .filter((item) => item.length > 0).length;

    const parsedDocument: Document = {
      ...document,
      status: "completed",
      parsedAt: new Date(),
      metadata: {
        ...document.metadata,
        wordCount: words,
        chunkCount: 1,
        entityCount: 1,
        edgeCount: 0
      }
    };

    await this.store.saveDocument(parsedDocument);
    this.emit(document.id, "completed", 100);

    return {
      document: parsedDocument,
      chunks: [],
      resolvedGraph: {
        nodes: [],
        edges: []
      },
      estimatedTokens: Math.ceil(buffer.length / 4)
    };
  }

  private emit(documentId: string, phase: PipelineStatusEvent["phase"], progress: number): void {
    this.emitter.emit("status", {
      documentId,
      phase,
      progress
    } satisfies PipelineStatusEvent);
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await sleep(20);
  }
  throw new Error("Timed out waiting for expected condition");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
