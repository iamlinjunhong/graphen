import neo4j, {
  type Driver,
  type Integer,
  type Node,
  type Relationship,
  type Session,
  type SessionConfig
} from "neo4j-driver";
import type {
  AbstractGraphStore,
  ChunkSearchResult,
  Document,
  DocumentChunk,
  DocumentStatus,
  GraphEdge,
  GraphNode,
  GraphStats,
  SearchResult,
  SubgraphQuery
} from "@graphen/shared";
import { appConfig } from "../config.js";

export interface Neo4jGraphStoreConfig {
  uri: string;
  user: string;
  password: string;
  database?: string;
  embeddingDimensions: number;
}

type AccessMode = "READ" | "WRITE";

export class Neo4jGraphStore implements AbstractGraphStore {
  private driver: Driver | null = null;

  constructor(private readonly config: Neo4jGraphStoreConfig) {}

  static fromEnv(): Neo4jGraphStore {
    return new Neo4jGraphStore({
      uri: appConfig.NEO4J_URI,
      user: appConfig.NEO4J_USER,
      password: appConfig.NEO4J_PASSWORD,
      database: appConfig.NEO4J_DATABASE,
      embeddingDimensions: appConfig.EMBEDDING_DIMENSIONS
    });
  }

  async connect(): Promise<void> {
    if (this.driver) {
      return;
    }

    this.driver = neo4j.driver(
      this.config.uri,
      neo4j.auth.basic(this.config.user, this.config.password)
    );

    try {
      await this.driver.verifyConnectivity();
      await this.ensureIndexes();
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.driver) {
      return;
    }

    await this.driver.close();
    this.driver = null;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.driver) {
      return false;
    }

    try {
      await this.withSession("READ", async (session) => {
        await session.run("RETURN 1 AS ok");
      });
      return true;
    } catch {
      return false;
    }
  }

  async saveNodes(nodes: GraphNode[]): Promise<void> {
    if (nodes.length === 0) {
      return;
    }

    await this.withSession("WRITE", async (session) => {
      await session.run(
        `
        UNWIND $nodes AS node
        MERGE (e:Entity {id: node.id})
        SET
          e.name = node.name,
          e.type = node.type,
          e.description = node.description,
          e.properties = node.properties,
          e.embedding = node.embedding,
          e.sourceDocumentIds = node.sourceDocumentIds,
          e.sourceChunkIds = node.sourceChunkIds,
          e.confidence = node.confidence,
          e.createdAt = coalesce(e.createdAt, node.createdAt),
          e.updatedAt = node.updatedAt
        `,
        {
          nodes: nodes.map((node) => this.serializeNode(node))
        }
      );
    });
  }

  async getNodeById(id: string): Promise<GraphNode | null> {
    return this.withSession("READ", async (session) => {
      const result = await session.run(
        `
        MATCH (e:Entity {id: $id})
        RETURN e
        LIMIT 1
        `,
        { id }
      );

      const record = result.records[0];
      if (!record) {
        return null;
      }

      return this.mapGraphNode(record.get("e") as Node);
    });
  }

  async getNodesByType(type: string, limit = 50, offset = 0): Promise<GraphNode[]> {
    const safeLimit = Math.max(1, limit);
    const safeOffset = Math.max(0, offset);

    return this.withSession("READ", async (session) => {
      const result = await session.run(
        `
        MATCH (e:Entity {type: $type})
        RETURN e
        ORDER BY e.name ASC
        SKIP $offset
        LIMIT $limit
        `,
        { type, limit: neo4j.int(safeLimit), offset: neo4j.int(safeOffset) }
      );

      return result.records.map((record) => this.mapGraphNode(record.get("e") as Node));
    });
  }

  async searchNodes(query: string, limit = 10): Promise<SearchResult[]> {
    const keyword = query.trim();
    if (keyword.length === 0) {
      return [];
    }

    const safeLimit = Math.max(1, limit);

    return this.withSession("READ", async (session) => {
      try {
        const result = await session.run(
          `
          CALL db.index.fulltext.queryNodes('entity_name_fulltext', $query)
          YIELD node, score
          RETURN node, score
          LIMIT $limit
          `,
          { query: keyword, limit: neo4j.int(safeLimit) }
        );

        return result.records.map((record) => ({
          node: this.mapGraphNode(record.get("node") as Node),
          score: this.toNumber(record.get("score"))
        }));
      } catch {
        const fallback = await session.run(
          `
          MATCH (node:Entity)
          WHERE toLower(coalesce(node.name, "")) CONTAINS toLower($query)
             OR toLower(coalesce(node.description, "")) CONTAINS toLower($query)
          RETURN node, 1.0 AS score
          LIMIT $limit
          `,
          { query: keyword, limit: neo4j.int(safeLimit) }
        );

        return fallback.records.map((record) => ({
          node: this.mapGraphNode(record.get("node") as Node),
          score: this.toNumber(record.get("score"))
        }));
      }
    });
  }

  async deleteNode(id: string): Promise<void> {
    await this.withSession("WRITE", async (session) => {
      await session.run(
        `
        MATCH (e:Entity {id: $id})
        DETACH DELETE e
        `,
        { id }
      );
    });
  }

  async saveEdges(edges: GraphEdge[]): Promise<void> {
    if (edges.length === 0) {
      return;
    }

    await this.withSession("WRITE", async (session) => {
      await session.run(
        `
        UNWIND $edges AS edge
        MERGE (source:Entity {id: edge.sourceNodeId})
        ON CREATE SET
          source.name = edge.sourceNodeId,
          source.type = "Unknown",
          source.description = "",
          source.properties = '{}',
          source.sourceDocumentIds = [],
          source.sourceChunkIds = [],
          source.confidence = 1.0,
          source.createdAt = edge.createdAt,
          source.updatedAt = edge.createdAt
        MERGE (target:Entity {id: edge.targetNodeId})
        ON CREATE SET
          target.name = edge.targetNodeId,
          target.type = "Unknown",
          target.description = "",
          target.properties = '{}',
          target.sourceDocumentIds = [],
          target.sourceChunkIds = [],
          target.confidence = 1.0,
          target.createdAt = edge.createdAt,
          target.updatedAt = edge.createdAt
        MERGE (source)-[r:RELATED_TO {id: edge.id}]->(target)
        SET
          r.sourceNodeId = edge.sourceNodeId,
          r.targetNodeId = edge.targetNodeId,
          r.relationType = edge.relationType,
          r.description = edge.description,
          r.properties = edge.properties,
          r.weight = edge.weight,
          r.sourceDocumentIds = edge.sourceDocumentIds,
          r.confidence = edge.confidence,
          r.createdAt = coalesce(r.createdAt, edge.createdAt)
        `,
        {
          edges: edges.map((edge) => this.serializeEdge(edge))
        }
      );
    });
  }

  async getEdgesByNode(nodeId: string): Promise<GraphEdge[]> {
    return this.withSession("READ", async (session) => {
      const result = await session.run(
        `
        MATCH (:Entity {id: $nodeId})-[r:RELATED_TO]-(:Entity)
        RETURN DISTINCT r
        `,
        { nodeId }
      );

      return result.records.map((record) => this.mapGraphEdge(record.get("r") as Relationship));
    });
  }

  async deleteEdge(id: string): Promise<void> {
    await this.withSession("WRITE", async (session) => {
      await session.run(
        `
        MATCH ()-[r:RELATED_TO {id: $id}]-()
        DELETE r
        `,
        { id }
      );
    });
  }

  async getNeighbors(nodeId: string, depth = 1): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const safeDepth = Math.max(1, Math.min(depth, 5));

    return this.withSession("READ", async (session) => {
      const nodeResult = await session.run(
        `
        MATCH (root:Entity {id: $nodeId})
        CALL {
          WITH root
          MATCH (root)-[:RELATED_TO*1..${safeDepth}]-(neighbor:Entity)
          RETURN DISTINCT neighbor
        }
        WITH collect(DISTINCT root) + collect(DISTINCT neighbor) AS rawNodes
        UNWIND rawNodes AS node
        WITH node WHERE node IS NOT NULL
        RETURN DISTINCT node
        `,
        { nodeId }
      );

      const nodes = nodeResult.records.map((record) => this.mapGraphNode(record.get("node") as Node));
      if (nodes.length === 0) {
        return { nodes: [], edges: [] };
      }

      const nodeIds = nodes.map((node) => node.id);
      const edgeResult = await session.run(
        `
        MATCH (source:Entity)-[r:RELATED_TO]->(target:Entity)
        WHERE source.id IN $nodeIds AND target.id IN $nodeIds
        RETURN DISTINCT r
        `,
        { nodeIds }
      );

      const edges = edgeResult.records.map((record) =>
        this.mapGraphEdge(record.get("r") as Relationship)
      );

      return { nodes, edges };
    });
  }

  async getSubgraph(query: SubgraphQuery): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const safeMaxDepth = Math.max(1, query.maxDepth ?? 2);
    const safeMaxNodes = Math.max(1, query.maxNodes ?? 200);

    return this.withSession("READ", async (session) => {
      let candidateNodes: GraphNode[] = [];

      if (query.centerNodeIds && query.centerNodeIds.length > 0) {
        const result = await session.run(
          `
          MATCH (seed:Entity)
          WHERE seed.id IN $centerNodeIds
          OPTIONAL MATCH path = (seed)-[:RELATED_TO*0..$maxDepth]-(node:Entity)
          WITH collect(DISTINCT node)[0..$candidateLimit] AS nodes
          UNWIND nodes AS node
          WITH node WHERE node IS NOT NULL
          RETURN DISTINCT node
          `,
          {
            centerNodeIds: query.centerNodeIds,
            maxDepth: neo4j.int(safeMaxDepth),
            candidateLimit: neo4j.int(safeMaxNodes * 3)
          }
        );
        candidateNodes = result.records.map((record) => this.mapGraphNode(record.get("node") as Node));
      } else {
        const result = await session.run(
          `
          MATCH (node:Entity)
          RETURN node
          LIMIT $candidateLimit
          `,
          { candidateLimit: neo4j.int(safeMaxNodes * 3) }
        );
        candidateNodes = result.records.map((record) => this.mapGraphNode(record.get("node") as Node));
      }

      const nodes = candidateNodes
        .filter((node) => this.matchesNodeFilter(node, query))
        .slice(0, safeMaxNodes);

      if (nodes.length === 0) {
        return { nodes: [], edges: [] };
      }

      const nodeIds = nodes.map((node) => node.id);
      const edgeResult = await session.run(
        `
        MATCH (source:Entity)-[r:RELATED_TO]->(target:Entity)
        WHERE source.id IN $nodeIds AND target.id IN $nodeIds
        RETURN DISTINCT r
        `,
        { nodeIds }
      );

      const edges = edgeResult.records
        .map((record) => this.mapGraphEdge(record.get("r") as Relationship))
        .filter((edge) => this.matchesEdgeFilter(edge, query));

      return { nodes, edges };
    });
  }

  async saveEmbeddings(nodeId: string, embedding: number[]): Promise<void> {
    await this.withSession("WRITE", async (session) => {
      await session.run(
        `
        MATCH (e:Entity {id: $nodeId})
        SET e.embedding = $embedding
        `,
        { nodeId, embedding }
      );
    });
  }

  async vectorSearch(
    vector: number[],
    k: number,
    filter?: Record<string, unknown>
  ): Promise<SearchResult[]> {
    if (vector.length === 0) {
      return [];
    }

    const safeK = Math.max(1, k);

    return this.withSession("READ", async (session) => {
      const result = await session.run(
        `
        CALL db.index.vector.queryNodes('entity_embedding', $k, $vector)
        YIELD node, score
        WITH node, score
        WHERE $filter IS NULL OR all(key IN keys($filter) WHERE node[key] = $filter[key])
        RETURN node, score
        `,
        {
          vector,
          k: neo4j.int(safeK),
          filter: filter ?? null
        }
      );

      return result.records.map((record) => ({
        node: this.mapGraphNode(record.get("node") as Node),
        score: this.toNumber(record.get("score"))
      }));
    });
  }

  async chunkVectorSearch(vector: number[], k: number): Promise<ChunkSearchResult[]> {
    if (vector.length === 0) {
      return [];
    }

    const safeK = Math.max(1, k);

    return this.withSession("READ", async (session) => {
      const result = await session.run(
        `
        CALL db.index.vector.queryNodes('chunk_embedding', $k, $vector)
        YIELD node, score
        RETURN node, score
        `,
        { vector, k: neo4j.int(safeK) }
      );

      return result.records.map((record) => ({
        chunk: this.mapDocumentChunk(record.get("node") as Node),
        score: this.toNumber(record.get("score"))
      }));
    });
  }

  async saveDocument(doc: Document): Promise<void> {
    await this.withSession("WRITE", async (session) => {
      await session.run(
        `
        MERGE (d:Document {id: $doc.id})
        SET
          d.filename = $doc.filename,
          d.fileType = $doc.fileType,
          d.fileSize = $doc.fileSize,
          d.status = $doc.status,
          d.uploadedAt = $doc.uploadedAt,
          d.parsedAt = $doc.parsedAt,
          d.metadata = $doc.metadata,
          d.errorMessage = $doc.errorMessage
        `,
        {
          doc: this.serializeDocument(doc)
        }
      );
    });
  }

  async getDocuments(): Promise<Document[]> {
    return this.withSession("READ", async (session) => {
      const result = await session.run(
        `
        MATCH (d:Document)
        RETURN d
        ORDER BY d.uploadedAt DESC
        `
      );

      return result.records.map((record) => this.mapDocument(record.get("d") as Node));
    });
  }

  async deleteDocumentAndRelated(docId: string): Promise<void> {
    await this.withSession("WRITE", async (session) => {
      await session.run(
        `
        MATCH (d:Document {id: $docId})
        OPTIONAL MATCH (d)-[:HAS_CHUNK]->(chunk:Chunk)
        DETACH DELETE d, chunk
        `,
        { docId }
      );

      await session.run(
        `
        MATCH (e:Entity)
        WHERE $docId IN coalesce(e.sourceDocumentIds, [])
        SET e.sourceDocumentIds = [id IN e.sourceDocumentIds WHERE id <> $docId]
        WITH e
        WHERE size(coalesce(e.sourceDocumentIds, [])) = 0
        DETACH DELETE e
        `,
        { docId }
      );

      await session.run(
        `
        MATCH ()-[r:RELATED_TO]->()
        WHERE $docId IN coalesce(r.sourceDocumentIds, [])
        SET r.sourceDocumentIds = [id IN r.sourceDocumentIds WHERE id <> $docId]
        WITH r
        WHERE size(coalesce(r.sourceDocumentIds, [])) = 0
        DELETE r
        `,
        { docId }
      );
    });
  }

  async saveChunks(chunks: DocumentChunk[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    await this.withSession("WRITE", async (session) => {
      await session.run(
        `
        UNWIND $chunks AS chunk
        MERGE (c:Chunk {id: chunk.id})
        SET
          c.documentId = chunk.documentId,
          c.content = chunk.content,
          c.index = chunk.index,
          c.embedding = chunk.embedding,
          c.metadata = chunk.metadata
        MERGE (d:Document {id: chunk.documentId})
        ON CREATE SET
          d.filename = chunk.documentId,
          d.fileType = "txt",
          d.fileSize = 0,
          d.status = "parsing",
          d.uploadedAt = chunk.createdAt,
          d.metadata = '{}'
        MERGE (d)-[rel:HAS_CHUNK]->(c)
        SET rel.index = chunk.index
        `,
        {
          chunks: chunks.map((chunk) => this.serializeChunk(chunk))
        }
      );
    });
  }

  async getChunksByDocument(docId: string): Promise<DocumentChunk[]> {
    return this.withSession("READ", async (session) => {
      const result = await session.run(
        `
        MATCH (c:Chunk {documentId: $docId})
        RETURN c
        ORDER BY c.index ASC
        `,
        { docId }
      );

      return result.records.map((record) => this.mapDocumentChunk(record.get("c") as Node));
    });
  }

  async getStats(): Promise<GraphStats> {
    return this.withSession("READ", async (session) => {
      const countResult = await session.run(
        `
        MATCH (e:Entity)
        WITH count(e) AS nodeCount
        MATCH ()-[r:RELATED_TO]->()
        WITH nodeCount, count(r) AS edgeCount
        MATCH (d:Document)
        RETURN nodeCount, edgeCount, count(d) AS documentCount
        `
      );

      const distNodeResult = await session.run(
        `
        MATCH (e:Entity)
        RETURN e.type AS name, count(*) AS value
        `
      );

      const distEdgeResult = await session.run(
        `
        MATCH ()-[r:RELATED_TO]->()
        RETURN r.relationType AS name, count(*) AS value
        `
      );

      const row = countResult.records[0];
      return {
        nodeCount: this.toNumber(row?.get("nodeCount")),
        edgeCount: this.toNumber(row?.get("edgeCount")),
        documentCount: this.toNumber(row?.get("documentCount")),
        nodeTypeDistribution: this.toDistributionMap(distNodeResult),
        edgeTypeDistribution: this.toDistributionMap(distEdgeResult)
      };
    });
  }

  private async ensureIndexes(): Promise<void> {
    const dimension = Math.max(1, Math.floor(this.config.embeddingDimensions));

    await this.withSession("WRITE", async (session) => {
      await session.run(
        `
        CREATE VECTOR INDEX entity_embedding IF NOT EXISTS
        FOR (e:Entity) ON (e.embedding)
        OPTIONS {indexConfig: {\`vector.dimensions\`: ${dimension}, \`vector.similarity_function\`: 'cosine'}}
        `
      );

      await session.run(
        `
        CREATE VECTOR INDEX chunk_embedding IF NOT EXISTS
        FOR (c:Chunk) ON (c.embedding)
        OPTIONS {indexConfig: {\`vector.dimensions\`: ${dimension}, \`vector.similarity_function\`: 'cosine'}}
        `
      );

      await session.run(
        `
        CREATE FULLTEXT INDEX entity_name_fulltext IF NOT EXISTS
        FOR (e:Entity) ON EACH [e.name, e.description]
        `
      );
    });
  }

  private withSession<T>(accessMode: AccessMode, fn: (session: Session) => Promise<T>): Promise<T> {
    const sessionConfig: SessionConfig = {
      defaultAccessMode: accessMode === "READ" ? neo4j.session.READ : neo4j.session.WRITE
    };
    if (this.config.database) {
      sessionConfig.database = this.config.database;
    }

    const session = this.getDriver().session(sessionConfig);

    return fn(session).finally(async () => {
      await session.close();
    });
  }

  private getDriver(): Driver {
    if (!this.driver) {
      throw new Error("Neo4jGraphStore is not connected. Call connect() first.");
    }

    return this.driver;
  }

  private mapGraphNode(node: Node): GraphNode {
    const props = this.asRecord(node.properties);
    const propsRaw = props.properties;
    const parsedProps = typeof propsRaw === "string"
      ? (() => { try { return JSON.parse(propsRaw); } catch { return {}; } })()
      : propsRaw;
    const graphNode: GraphNode = {
      id: this.toString(props.id, node.elementId),
      name: this.toString(props.name, ""),
      type: this.toString(props.type, "Unknown"),
      description: this.toString(props.description, ""),
      properties: this.asRecord(parsedProps),
      sourceDocumentIds: this.toStringArray(props.sourceDocumentIds),
      sourceChunkIds: this.toStringArray(props.sourceChunkIds),
      confidence: this.toNumber(props.confidence, 1),
      createdAt: this.toDate(props.createdAt, new Date(0)),
      updatedAt: this.toDate(props.updatedAt, new Date(0))
    };

    const embedding = this.toOptionalNumberArray(props.embedding);
    if (embedding) {
      graphNode.embedding = embedding;
    }

    return graphNode;
  }

  private mapGraphEdge(relationship: Relationship): GraphEdge {
    const props = this.asRecord(relationship.properties);
    const edgePropsRaw = props.properties;
    const parsedEdgeProps = typeof edgePropsRaw === "string"
      ? (() => { try { return JSON.parse(edgePropsRaw); } catch { return {}; } })()
      : edgePropsRaw;
    return {
      id: this.toString(props.id, relationship.elementId),
      sourceNodeId: this.toString(props.sourceNodeId, ""),
      targetNodeId: this.toString(props.targetNodeId, ""),
      relationType: this.toString(props.relationType, "RELATED_TO"),
      description: this.toString(props.description, ""),
      properties: this.asRecord(parsedEdgeProps),
      weight: this.toNumber(props.weight, 1),
      sourceDocumentIds: this.toStringArray(props.sourceDocumentIds),
      confidence: this.toNumber(props.confidence, 1),
      createdAt: this.toDate(props.createdAt, new Date(0))
    };
  }

  private mapDocument(node: Node): Document {
    const props = this.asRecord(node.properties);
    const metadataRaw = props.metadata;
    const metadataRecord = typeof metadataRaw === "string"
      ? this.asRecord((() => { try { return JSON.parse(metadataRaw); } catch { return {}; } })())
      : this.asRecord(metadataRaw);
    const metadata: Document["metadata"] = {};

    const pageCount = this.toOptionalNumber(metadataRecord.pageCount);
    const wordCount = this.toOptionalNumber(metadataRecord.wordCount);
    const chunkCount = this.toOptionalNumber(metadataRecord.chunkCount);
    const entityCount = this.toOptionalNumber(metadataRecord.entityCount);
    const edgeCount = this.toOptionalNumber(metadataRecord.edgeCount);

    if (pageCount !== undefined) {
      metadata.pageCount = pageCount;
    }
    if (wordCount !== undefined) {
      metadata.wordCount = wordCount;
    }
    if (chunkCount !== undefined) {
      metadata.chunkCount = chunkCount;
    }
    if (entityCount !== undefined) {
      metadata.entityCount = entityCount;
    }
    if (edgeCount !== undefined) {
      metadata.edgeCount = edgeCount;
    }

    const document: Document = {
      id: this.toString(props.id, node.elementId),
      filename: this.toString(props.filename, ""),
      fileType: this.toDocumentFileType(props.fileType),
      fileSize: this.toNumber(props.fileSize, 0),
      status: this.toDocumentStatus(props.status),
      uploadedAt: this.toDate(props.uploadedAt, new Date(0)),
      metadata
    };

    const parsedAt = this.toOptionalDate(props.parsedAt);
    if (parsedAt) {
      document.parsedAt = parsedAt;
    }

    const errorMessage = this.toOptionalString(props.errorMessage);
    if (errorMessage !== undefined) {
      document.errorMessage = errorMessage;
    }

    return document;
  }

  private mapDocumentChunk(node: Node): DocumentChunk {
    const props = this.asRecord(node.properties);
    const chunkMetaRaw = props.metadata;
    const metadataRecord = typeof chunkMetaRaw === "string"
      ? this.asRecord((() => { try { return JSON.parse(chunkMetaRaw); } catch { return {}; } })())
      : this.asRecord(chunkMetaRaw);
    const metadata: DocumentChunk["metadata"] = {};

    const pageNumber = this.toOptionalNumber(metadataRecord.pageNumber);
    const startLine = this.toOptionalNumber(metadataRecord.startLine);
    const endLine = this.toOptionalNumber(metadataRecord.endLine);

    if (pageNumber !== undefined) {
      metadata.pageNumber = pageNumber;
    }
    if (startLine !== undefined) {
      metadata.startLine = startLine;
    }
    if (endLine !== undefined) {
      metadata.endLine = endLine;
    }

    const chunk: DocumentChunk = {
      id: this.toString(props.id, node.elementId),
      documentId: this.toString(props.documentId, ""),
      content: this.toString(props.content, ""),
      index: this.toNumber(props.index, 0),
      metadata
    };

    const embedding = this.toOptionalNumberArray(props.embedding);
    if (embedding) {
      chunk.embedding = embedding;
    }

    return chunk;
  }

  private serializeNode(node: GraphNode): Record<string, unknown> {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      description: node.description,
      properties: JSON.stringify(node.properties ?? {}),
      embedding: node.embedding ?? null,
      sourceDocumentIds: node.sourceDocumentIds,
      sourceChunkIds: node.sourceChunkIds,
      confidence: node.confidence,
      createdAt: node.createdAt.toISOString(),
      updatedAt: node.updatedAt.toISOString()
    };
  }

  private serializeEdge(edge: GraphEdge): Record<string, unknown> {
    return {
      id: edge.id,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      relationType: edge.relationType,
      description: edge.description,
      properties: JSON.stringify(edge.properties ?? {}),
      weight: edge.weight,
      sourceDocumentIds: edge.sourceDocumentIds,
      confidence: edge.confidence,
      createdAt: edge.createdAt.toISOString()
    };
  }

  private serializeDocument(doc: Document): Record<string, unknown> {
    return {
      id: doc.id,
      filename: doc.filename,
      fileType: doc.fileType,
      fileSize: doc.fileSize,
      status: doc.status,
      uploadedAt: doc.uploadedAt.toISOString(),
      parsedAt: doc.parsedAt ? doc.parsedAt.toISOString() : null,
      metadata: JSON.stringify(doc.metadata ?? {}),
      errorMessage: doc.errorMessage ?? null
    };
  }

  private serializeChunk(chunk: DocumentChunk): Record<string, unknown> {
    return {
      id: chunk.id,
      documentId: chunk.documentId,
      content: chunk.content,
      index: chunk.index,
      embedding: chunk.embedding ?? null,
      metadata: JSON.stringify(chunk.metadata ?? {}),
      createdAt: new Date().toISOString()
    };
  }

  private matchesNodeFilter(node: GraphNode, query: SubgraphQuery): boolean {
    if (query.nodeTypes && query.nodeTypes.length > 0 && !query.nodeTypes.includes(node.type)) {
      return false;
    }

    if (query.documentIds && query.documentIds.length > 0) {
      const hit = node.sourceDocumentIds.some((docId) => query.documentIds?.includes(docId));
      if (!hit) {
        return false;
      }
    }

    if (query.minConfidence !== undefined && node.confidence < query.minConfidence) {
      return false;
    }

    return true;
  }

  private matchesEdgeFilter(edge: GraphEdge, query: SubgraphQuery): boolean {
    if (
      query.relationTypes &&
      query.relationTypes.length > 0 &&
      !query.relationTypes.includes(edge.relationType)
    ) {
      return false;
    }

    if (query.documentIds && query.documentIds.length > 0) {
      const hit = edge.sourceDocumentIds.some((docId) => query.documentIds?.includes(docId));
      if (!hit) {
        return false;
      }
    }

    if (query.minConfidence !== undefined && edge.confidence < query.minConfidence) {
      return false;
    }

    return true;
  }

  private toDistributionMap(result: { records: Array<{ get: (field: string) => unknown }> }): Record<string, number> {
    const distribution: Record<string, number> = {};
    for (const record of result.records) {
      const name = this.toString(record.get("name"), "Unknown");
      distribution[name] = this.toNumber(record.get("value"), 0);
    }
    return distribution;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private toString(value: unknown, fallback: string): string {
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return fallback;
  }

  private toOptionalString(value: unknown): string | undefined {
    if (typeof value === "string") {
      return value;
    }
    return undefined;
  }

  private toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.map((item) => String(item));
  }

  private toNumber(value: unknown, fallback = 0): number {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : fallback;
    }
    if (neo4j.isInt(value)) {
      return (value as Integer).toNumber();
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return fallback;
  }

  private toOptionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    return this.toNumber(value);
  }

  private toOptionalNumberArray(value: unknown): number[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    return value.map((item) => this.toNumber(item));
  }

  private toDate(value: unknown, fallback: Date): Date {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value;
    }

    if (typeof value === "string" || typeof value === "number") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    return fallback;
  }

  private toOptionalDate(value: unknown): Date | undefined {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }

    const parsed = this.toDate(value, new Date(Number.NaN));
    if (Number.isNaN(parsed.getTime())) {
      return undefined;
    }
    return parsed;
  }

  private toDocumentStatus(value: unknown): DocumentStatus {
    const status = this.toString(value, "error");
    const statuses: DocumentStatus[] = [
      "uploading",
      "parsing",
      "extracting",
      "embedding",
      "completed",
      "error"
    ];
    return statuses.includes(status as DocumentStatus) ? (status as DocumentStatus) : "error";
  }

  private toDocumentFileType(value: unknown): Document["fileType"] {
    const type = this.toString(value, "txt");
    if (type === "pdf" || type === "md" || type === "txt") {
      return type;
    }
    return "txt";
  }
}
