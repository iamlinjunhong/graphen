import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import type { Document, DocumentChunk, GraphEdge, GraphNode } from "@graphen/shared";
import { createChatRouter } from "../../src/routes/chat.js";
import { InMemoryChatStore } from "../../src/services/InMemoryChatStore.js";
import { FakeGraphStore } from "../helpers/FakeGraphStore.js";
import { FakeLLMService } from "../helpers/FakeLLMService.js";

describe("chat api", () => {
  let store: FakeGraphStore;
  let llm: FakeLLMService;
  let chatStore: InMemoryChatStore;
  let app: ReturnType<typeof express>;

  beforeEach(async () => {
    store = new FakeGraphStore();
    llm = new FakeLLMService();
    chatStore = new InMemoryChatStore();
    await seedGraph(store);

    app = express();
    app.use(express.json());
    app.use(
      "/api/chat",
      createChatRouter({
        chatStore,
        graphStore: store,
        llmService: llm,
        ensureStoreConnected: async () => {}
      })
    );
  });

  it("supports chat session CRUD and non-stream message completion", async () => {
    const createSessionResponse = await request(app)
      .post("/api/chat/sessions")
      .send({ title: "Knowledge QA" });
    expect(createSessionResponse.status).toBe(201);
    const sessionId = createSessionResponse.body.session.id;
    expect(typeof sessionId).toBe("string");

    const listResponse = await request(app).get("/api/chat/sessions");
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.sessions).toHaveLength(1);

    const messageResponse = await request(app)
      .post(`/api/chat/sessions/${sessionId}/messages`)
      .send({ content: "Graphen 和 Neo4j 有什么关系？" });
    expect(messageResponse.status).toBe(202);
    expect(messageResponse.body.sessionId).toBe(sessionId);
    expect(messageResponse.body.message.content).toBe("Graphen 使用 Neo4j。");

    const detailResponse = await request(app).get(`/api/chat/sessions/${sessionId}`);
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.session.messages).toHaveLength(2);
    expect(detailResponse.body.session.messages[0].role).toBe("user");
    expect(detailResponse.body.session.messages[1].role).toBe("assistant");
    expect(detailResponse.body.session.messages[1].sources.length).toBeGreaterThan(0);
    expect(detailResponse.body.session.messages[1].graphContext.nodes.length).toBeGreaterThan(0);

    const deleteResponse = await request(app).delete(`/api/chat/sessions/${sessionId}`);
    expect(deleteResponse.status).toBe(204);

    const detailAfterDeleteResponse = await request(app).get(`/api/chat/sessions/${sessionId}`);
    expect(detailAfterDeleteResponse.status).toBe(404);
  });

  it("streams assistant response via SSE", async () => {
    const createSessionResponse = await request(app)
      .post("/api/chat/sessions")
      .send({ title: "SSE Session" });
    const sessionId = createSessionResponse.body.session.id as string;

    const streamResponse = await request(app)
      .post(`/api/chat/sessions/${sessionId}/messages`)
      .set("Accept", "text/event-stream")
      .send({ content: "请基于图谱回答" });

    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers["content-type"]).toContain("text/event-stream");
    expect(streamResponse.text).toContain("event: ack");
    expect(streamResponse.text).toContain("event: analysis");
    expect(streamResponse.text).toContain("event: delta");
    expect(streamResponse.text).toContain("event: sources");
    expect(streamResponse.text).toContain("event: done");
    expect(streamResponse.text).toContain("Graphen");
    expect(streamResponse.text).toContain("Neo4j");
  });
});

async function seedGraph(store: FakeGraphStore): Promise<void> {
  const now = new Date("2026-02-25T00:00:00.000Z");

  const documents: Document[] = [
    {
      id: "doc-chat",
      filename: "chat-source.md",
      fileType: "md",
      fileSize: 1200,
      status: "completed",
      uploadedAt: now,
      metadata: {}
    }
  ];
  for (const doc of documents) {
    await store.saveDocument(doc);
  }

  const chunks: DocumentChunk[] = [
    {
      id: "chunk-1",
      documentId: "doc-chat",
      content: "Graphen uses Neo4j as graph database for GraphRAG query.",
      index: 0,
      embedding: [0.1, 0.2, 0.3, 0.4],
      metadata: {
        pageNumber: 1
      }
    },
    {
      id: "chunk-2",
      documentId: "doc-chat",
      content: "Vector search retrieves similar chunks for the user question.",
      index: 1,
      embedding: [0.2, 0.3, 0.4, 0.5],
      metadata: {
        pageNumber: 1
      }
    }
  ];
  await store.saveChunks(chunks);

  const nodes: GraphNode[] = [
    {
      id: "node-graphen",
      name: "Graphen",
      type: "Technology",
      description: "GraphRAG platform",
      properties: {},
      sourceDocumentIds: ["doc-chat"],
      sourceChunkIds: ["chunk-1"],
      confidence: 0.95,
      createdAt: now,
      updatedAt: now
    },
    {
      id: "node-neo4j",
      name: "Neo4j",
      type: "Technology",
      description: "Graph database",
      properties: {},
      sourceDocumentIds: ["doc-chat"],
      sourceChunkIds: ["chunk-1"],
      confidence: 0.94,
      createdAt: now,
      updatedAt: now
    }
  ];
  const edges: GraphEdge[] = [
    {
      id: "edge-uses",
      sourceNodeId: "node-graphen",
      targetNodeId: "node-neo4j",
      relationType: "USES",
      description: "Graphen uses Neo4j",
      properties: {},
      weight: 1,
      sourceDocumentIds: ["doc-chat"],
      confidence: 0.93,
      createdAt: now
    }
  ];

  await store.saveNodes(nodes);
  await store.saveEdges(edges);
}
