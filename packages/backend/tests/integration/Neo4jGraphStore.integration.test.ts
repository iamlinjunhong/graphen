import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import type { Document, DocumentChunk, GraphEdge, GraphNode } from "@graphen/shared";
import { Neo4jGraphStore } from "../../src/store/Neo4jGraphStore.js";

const runIntegration = process.env.RUN_NEO4J_INTEGRATION === "true";

describe.skipIf(!runIntegration)("Neo4jGraphStore integration", () => {
  let container: StartedTestContainer;
  let store: Neo4jGraphStore;

  beforeAll(async () => {
    container = await new GenericContainer("neo4j:5.26.0")
      .withEnvironment({
        NEO4J_AUTH: "neo4j/testpassword"
      })
      .withExposedPorts(7687)
      .start();

    store = new Neo4jGraphStore({
      uri: `bolt://${container.getHost()}:${container.getMappedPort(7687)}`,
      user: "neo4j",
      password: "testpassword",
      embeddingDimensions: 4
    });

    await store.connect();
  });

  afterAll(async () => {
    await store.disconnect();
    await container.stop();
  });

  it("supports graph/document CRUD and stats", async () => {
    const docId = randomUUID();
    const sourceNodeId = randomUUID();
    const targetNodeId = randomUUID();
    const edgeId = randomUUID();
    const chunkId = randomUUID();

    const document: Document = {
      id: docId,
      filename: "demo.md",
      fileType: "md",
      fileSize: 1024,
      status: "completed",
      uploadedAt: new Date(),
      parsedAt: new Date(),
      metadata: {
        chunkCount: 1,
        entityCount: 2,
        edgeCount: 1
      }
    };

    const chunks: DocumentChunk[] = [
      {
        id: chunkId,
        documentId: docId,
        content: "Graphen uses Neo4j for graph storage.",
        index: 0,
        embedding: [0.1, 0.2, 0.3, 0.4],
        metadata: {
          startLine: 1,
          endLine: 1
        }
      }
    ];

    const nodes: GraphNode[] = [
      {
        id: sourceNodeId,
        name: "Graphen",
        type: "Technology",
        description: "GraphRAG application",
        properties: {},
        sourceDocumentIds: [docId],
        sourceChunkIds: [chunkId],
        confidence: 0.98,
        embedding: [0.11, 0.2, 0.3, 0.39],
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        id: targetNodeId,
        name: "Neo4j",
        type: "Technology",
        description: "Graph database",
        properties: {},
        sourceDocumentIds: [docId],
        sourceChunkIds: [chunkId],
        confidence: 0.97,
        embedding: [0.1, 0.2, 0.31, 0.4],
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ];

    const edges: GraphEdge[] = [
      {
        id: edgeId,
        sourceNodeId,
        targetNodeId,
        relationType: "USES",
        description: "Graphen uses Neo4j",
        properties: {},
        weight: 1,
        sourceDocumentIds: [docId],
        confidence: 0.96,
        createdAt: new Date()
      }
    ];

    await store.saveDocument(document);
    await store.saveChunks(chunks);
    await store.saveNodes(nodes);
    await store.saveEdges(edges);

    const node = await store.getNodeById(sourceNodeId);
    expect(node?.name).toBe("Graphen");

    const typedNodes = await store.getNodesByType("Technology");
    expect(typedNodes.length).toBeGreaterThanOrEqual(2);

    const relatedEdges = await store.getEdgesByNode(sourceNodeId);
    expect(relatedEdges.some((edge) => edge.id === edgeId)).toBe(true);

    const neighbors = await store.getNeighbors(sourceNodeId, 2);
    expect(neighbors.nodes.some((item) => item.id === targetNodeId)).toBe(true);

    const subgraph = await store.getSubgraph({
      centerNodeIds: [sourceNodeId],
      maxDepth: 2,
      maxNodes: 20
    });
    expect(subgraph.nodes.some((item) => item.id === sourceNodeId)).toBe(true);

    const docs = await store.getDocuments();
    expect(docs.some((doc) => doc.id === docId)).toBe(true);

    const docChunks = await store.getChunksByDocument(docId);
    expect(docChunks).toHaveLength(1);

    const stats = await store.getStats();
    expect(stats.nodeCount).toBeGreaterThanOrEqual(2);
    expect(stats.edgeCount).toBeGreaterThanOrEqual(1);
    expect(stats.documentCount).toBeGreaterThanOrEqual(1);

    await store.deleteEdge(edgeId);
    await store.deleteNode(targetNodeId);
    await store.deleteDocumentAndRelated(docId);
  });

  it("supports vector search", async () => {
    const nodeId = randomUUID();
    const now = new Date();

    await store.saveNodes([
      {
        id: nodeId,
        name: "Vector Node",
        type: "Concept",
        description: "Node for vector search",
        properties: {},
        sourceDocumentIds: [],
        sourceChunkIds: [],
        confidence: 1,
        createdAt: now,
        updatedAt: now
      }
    ]);
    await store.saveEmbeddings(nodeId, [0.1, 0.2, 0.3, 0.4]);

    const searchResult = await retry(async () =>
      store.vectorSearch([0.1, 0.2, 0.3, 0.4], 3, {
        type: "Concept"
      })
    );

    expect(searchResult.some((item) => item.node.id === nodeId)).toBe(true);
  });
});

async function retry<T>(fn: () => Promise<T>, attempts = 8, delayMs = 500): Promise<T> {
  let latestError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      latestError = error;
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }
  throw latestError;
}
