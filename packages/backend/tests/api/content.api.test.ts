import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Document } from "@graphen/shared";
import { createDocumentsRouter } from "../../src/routes/documents.js";
import type { DocumentPipelineResult, PipelineStatusEvent } from "../../src/pipeline/types.js";
import type { DocumentPipeline } from "../../src/pipeline/DocumentPipeline.js";
import { FakeGraphStore } from "../helpers/FakeGraphStore.js";

describe("document content & reparse API", () => {
  let store: FakeGraphStore;
  let app: ReturnType<typeof express>;
  let uploadsDir: string;
  let cacheDir: string;
  const cleanupDirs: string[] = [];

  beforeEach(() => {
    store = new FakeGraphStore();

    const suffix = randomUUID();
    uploadsDir = resolve("tmp", `content-uploads-${suffix}`);
    cacheDir = resolve("tmp", `content-cache-${suffix}`);
    cleanupDirs.push(uploadsDir, cacheDir);

    const pipeline = new FakePipeline(store);
    app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use(
      "/api/documents",
      createDocumentsRouter({
        store,
        pipeline: pipeline as unknown as DocumentPipeline,
        ensureStoreConnected: async () => {},
        uploadsDir,
        cacheDir,
      })
    );
  });

  afterEach(() => {
    for (const path of cleanupDirs.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  // Helper: upload a file and wait for processing to complete
  async function uploadAndWait(
    filename: string,
    content: string,
    contentType = "text/plain"
  ): Promise<string> {
    const res = await request(app)
      .post("/api/documents/upload")
      .attach("file", Buffer.from(content, "utf8"), { filename, contentType });
    expect(res.status).toBe(202);
    const documentId = res.headers["x-document-id"] as string;
    await waitFor(async () => {
      const docs = await store.getDocuments();
      return docs.some((d) => d.id === documentId && d.status === "completed");
    });
    return documentId;
  }

  // ─── GET /:id/content ───

  describe("GET /:id/content", () => {
    it("lazily creates sidecar and returns content on first access", async () => {
      const docId = await uploadAndWait("notes.txt", "Hello world from Graphen");

      const res = await request(app).get(`/api/documents/${docId}/content`);
      expect(res.status).toBe(200);
      expect(res.body.documentId).toBe(docId);
      expect(res.body.content).toBe("Hello world from Graphen");
      expect(res.body.contentSource).toBe("parsed");
      expect(res.body.truncated).toBe(false);
      expect(res.body.charCount).toBe(24);
      expect(res.body.totalCharCount).toBe(24);

      // Sidecar file should now exist
      const sidecarPath = resolve(uploadsDir, docId, ".editor", "content.txt");
      expect(existsSync(sidecarPath)).toBe(true);
    });

    it("returns sidecar content when it already exists", async () => {
      const docId = await uploadAndWait("readme.md", "# Original");

      // Manually write a sidecar to simulate prior edit
      const editorDir = resolve(uploadsDir, docId, ".editor");
      mkdirSync(editorDir, { recursive: true });
      writeFileSync(resolve(editorDir, "content.txt"), "# Edited content", "utf8");

      const res = await request(app).get(`/api/documents/${docId}/content`);
      expect(res.status).toBe(200);
      expect(res.body.content).toBe("# Edited content");
      expect(res.body.contentSource).toBe("edited");
    });

    it("returns 404 for non-existent document", async () => {
      const res = await request(app).get(`/api/documents/${randomUUID()}/content`);
      expect(res.status).toBe(404);
    });
  });

  // ─── POST /:id/reparse with content ───

  describe("POST /:id/reparse with content", () => {
    it("accepts content and queues reparse", async () => {
      const docId = await uploadAndWait("doc.txt", "Original text");

      const res = await request(app)
        .post(`/api/documents/${docId}/reparse`)
        .send({ content: "Edited text for reparse" });

      expect(res.status).toBe(202);
      expect(res.body.message).toBe("Reparse job queued");
      expect(res.body.id).toBe(docId);

      // Sidecar should be written
      const sidecarPath = resolve(uploadsDir, docId, ".editor", "content.txt");
      await waitFor(async () => existsSync(sidecarPath));
      expect(readFileSync(sidecarPath, "utf8")).toBe("Edited text for reparse");
    });

    it("returns 413 when content exceeds MAX_EDITABLE_CHARS", async () => {
      const docId = await uploadAndWait("big.txt", "small");

      const hugeContent = "x".repeat(200_001);
      const res = await request(app)
        .post(`/api/documents/${docId}/reparse`)
        .send({ content: hugeContent });

      expect(res.status).toBe(413);
      expect(res.body.error).toContain("200000");
    });

    it("returns 409 when document is already being processed", async () => {
      // Upload but don't wait for completion — the pipeline is still running
      const uploadRes = await request(app)
        .post("/api/documents/upload")
        .attach("file", Buffer.from("processing test", "utf8"), {
          filename: "busy.txt",
          contentType: "text/plain",
        });
      const docId = uploadRes.headers["x-document-id"] as string;

      // Immediately try to reparse while pipeline is still running
      const res = await request(app)
        .post(`/api/documents/${docId}/reparse`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("already being processed");
    });

    it("clears cache directory on reparse with content", async () => {
      const docId = await uploadAndWait("cached.txt", "Cached content");

      // Create fake cache files
      const docCacheDir = resolve(cacheDir, docId);
      mkdirSync(docCacheDir, { recursive: true });
      writeFileSync(resolve(docCacheDir, "chunks.json"), "[]", "utf8");
      writeFileSync(resolve(docCacheDir, "extractions.json"), "[]", "utf8");
      expect(existsSync(docCacheDir)).toBe(true);

      await request(app)
        .post(`/api/documents/${docId}/reparse`)
        .send({ content: "Updated content" });

      // Cache directory should be cleaned
      expect(existsSync(resolve(docCacheDir, "chunks.json"))).toBe(false);
    });

    it("works without content body (original reparse behavior)", async () => {
      const docId = await uploadAndWait("plain.txt", "Plain reparse");

      const res = await request(app)
        .post(`/api/documents/${docId}/reparse`)
        .send({});

      expect(res.status).toBe(202);
      expect(res.body.message).toBe("Reparse job queued");
    });
  });
});

// ─── Test helpers ───

class FakePipeline {
  private readonly emitter = new EventEmitter();

  constructor(private readonly store: FakeGraphStore) {}

  onStatus(listener: (event: PipelineStatusEvent) => void): void {
    this.emitter.on("status", listener);
  }

  async process(
    document: Document,
    buffer: Buffer,
    options?: { rawText?: string; forceRebuild?: boolean }
  ): Promise<DocumentPipelineResult> {
    this.emit(document.id, "parsing", 10);
    await sleep(5);
    this.emit(document.id, "extracting", 60);
    await sleep(5);

    const text = options?.rawText ?? buffer.toString("utf8");
    const words = text.trim().split(/\s+/).filter((w) => w.length > 0).length;

    const parsedDocument: Document = {
      ...document,
      status: "completed",
      parsedAt: new Date(),
      metadata: {
        ...document.metadata,
        wordCount: words,
        chunkCount: 1,
        entityCount: 1,
        edgeCount: 0,
      },
    };

    await this.store.saveDocument(parsedDocument);
    this.emit(document.id, "completed", 100);

    return {
      document: parsedDocument,
      chunks: [],
      resolvedGraph: { nodes: [], edges: [] },
      estimatedTokens: Math.ceil(text.length / 4),
    };
  }

  private emit(documentId: string, phase: PipelineStatusEvent["phase"], progress: number): void {
    this.emitter.emit("status", {
      documentId,
      phase,
      progress,
    } satisfies PipelineStatusEvent);
  }
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error("Timed out waiting for expected condition");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
