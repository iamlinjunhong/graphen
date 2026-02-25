import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import type { Document, GraphEdge, GraphNode } from "@graphen/shared";
import { createGraphRouter } from "../../src/routes/graph.js";
import { FakeGraphStore } from "../helpers/FakeGraphStore.js";

describe("graph api", () => {
  let store: FakeGraphStore;
  let app: ReturnType<typeof express>;

  beforeEach(async () => {
    store = new FakeGraphStore();
    await seed(store);

    app = express();
    app.use(express.json());
    app.use(
      "/api/graph",
      createGraphRouter({
        store,
        ensureStoreConnected: async () => {}
      })
    );
  });

  it("returns overview stats and supports nodes pagination/filter", async () => {
    const overviewResponse = await request(app).get("/api/graph/overview");
    expect(overviewResponse.status).toBe(200);
    expect(overviewResponse.body.nodeCount).toBe(4);
    expect(overviewResponse.body.edgeCount).toBe(3);
    expect(overviewResponse.body.nodeTypeDistribution.Technology).toBe(2);

    const nodesByTypeResponse = await request(app)
      .get("/api/graph/nodes")
      .query({ page: 1, pageSize: 10, type: "Technology" });
    expect(nodesByTypeResponse.status).toBe(200);
    expect(nodesByTypeResponse.body.nodes).toHaveLength(2);
    expect(nodesByTypeResponse.body.nodes[0].type).toBe("Technology");

    const filteredResponse = await request(app)
      .get("/api/graph/nodes")
      .query({ page: 1, pageSize: 10, documentId: "doc-b", minConfidence: 0.8 });
    expect(filteredResponse.status).toBe(200);
    expect(filteredResponse.body.nodes).toHaveLength(1);
    expect(filteredResponse.body.nodes[0].id).toBe("n3");
  });

  it("supports node detail, neighbors, and subgraph query", async () => {
    const detailResponse = await request(app).get("/api/graph/nodes/n1");
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.node.name).toBe("Graphen");

    const notFoundResponse = await request(app).get("/api/graph/nodes/unknown");
    expect(notFoundResponse.status).toBe(404);

    const neighborsResponse = await request(app)
      .get("/api/graph/nodes/n1/neighbors")
      .query({ depth: 1, maxNodes: 2 });
    expect(neighborsResponse.status).toBe(200);
    expect(neighborsResponse.body.nodes).toHaveLength(2);
    expect(neighborsResponse.body.nodes[0].id).toBe("n1");

    const subgraphResponse = await request(app)
      .get("/api/graph/subgraph")
      .query({
        centerNodeIds: "n1",
        nodeTypes: "Technology",
        relationTypes: "USES",
        maxDepth: 1,
        maxNodes: 10
      });
    expect(subgraphResponse.status).toBe(200);
    expect(subgraphResponse.body.nodes).toHaveLength(2);
    expect(subgraphResponse.body.edges).toHaveLength(1);
    expect(subgraphResponse.body.edges[0].relationType).toBe("USES");
  });

  it("supports fulltext search and vector search", async () => {
    const searchResponse = await request(app)
      .get("/api/graph/search")
      .query({ q: "neo", page: 1, pageSize: 10 });
    expect(searchResponse.status).toBe(200);
    expect(searchResponse.body.query).toBe("neo");
    expect(searchResponse.body.results).toHaveLength(1);
    expect(searchResponse.body.results[0].id).toBe("n2");

    const vectorResponse = await request(app).post("/api/graph/vector-search").send({
      vector: [0.1, 0.2, 0.3],
      k: 2,
      filter: {
        type: "Technology"
      }
    });
    expect(vectorResponse.status).toBe(200);
    expect(vectorResponse.body.results).toHaveLength(2);
    expect(vectorResponse.body.results[0].node.type).toBe("Technology");
  });
});

async function seed(store: FakeGraphStore): Promise<void> {
  const now = new Date("2026-02-25T00:00:00.000Z");
  const documents: Document[] = [
    {
      id: "doc-a",
      filename: "a.txt",
      fileType: "txt",
      fileSize: 100,
      status: "completed",
      uploadedAt: now,
      metadata: {}
    },
    {
      id: "doc-b",
      filename: "b.txt",
      fileType: "txt",
      fileSize: 120,
      status: "completed",
      uploadedAt: new Date(now.getTime() + 1000),
      metadata: {}
    }
  ];
  for (const document of documents) {
    await store.saveDocument(document);
  }

  const nodes: GraphNode[] = [
    {
      id: "n1",
      name: "Graphen",
      type: "Technology",
      description: "GraphRAG platform",
      properties: {},
      sourceDocumentIds: ["doc-a"],
      sourceChunkIds: ["c1"],
      confidence: 0.95,
      createdAt: now,
      updatedAt: new Date(now.getTime() + 1000)
    },
    {
      id: "n2",
      name: "Neo4j",
      type: "Technology",
      description: "Graph database",
      properties: {},
      sourceDocumentIds: ["doc-a"],
      sourceChunkIds: ["c1"],
      confidence: 0.92,
      createdAt: now,
      updatedAt: new Date(now.getTime() + 2000)
    },
    {
      id: "n3",
      name: "Vector RAG",
      type: "Concept",
      description: "Retrieval strategy",
      properties: {},
      sourceDocumentIds: ["doc-b"],
      sourceChunkIds: ["c2"],
      confidence: 0.88,
      createdAt: now,
      updatedAt: new Date(now.getTime() + 3000)
    },
    {
      id: "n4",
      name: "Alice",
      type: "Person",
      description: "Contributor",
      properties: {},
      sourceDocumentIds: ["doc-b"],
      sourceChunkIds: ["c3"],
      confidence: 0.7,
      createdAt: now,
      updatedAt: new Date(now.getTime() + 4000)
    }
  ];

  const edges: GraphEdge[] = [
    {
      id: "e1",
      sourceNodeId: "n1",
      targetNodeId: "n2",
      relationType: "USES",
      description: "Graphen uses Neo4j",
      properties: {},
      weight: 1,
      sourceDocumentIds: ["doc-a"],
      confidence: 0.9,
      createdAt: now
    },
    {
      id: "e2",
      sourceNodeId: "n1",
      targetNodeId: "n3",
      relationType: "SUPPORTS",
      description: "Graphen supports vector retrieval",
      properties: {},
      weight: 1,
      sourceDocumentIds: ["doc-b"],
      confidence: 0.85,
      createdAt: now
    },
    {
      id: "e3",
      sourceNodeId: "n4",
      targetNodeId: "n1",
      relationType: "BUILDS",
      description: "Alice builds Graphen",
      properties: {},
      weight: 1,
      sourceDocumentIds: ["doc-b"],
      confidence: 0.65,
      createdAt: now
    }
  ];

  await store.saveNodes(nodes);
  await store.saveEdges(edges);
}
