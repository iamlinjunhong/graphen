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
  GraphEdge,
  GraphNode,
  GraphStats,
  SearchResult,
  SubgraphQuery
} from "@graphen/shared";
import { appConfig } from "../config.js";
import { logger } from "../utils/logger.js";

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
  private statsCache: { data: GraphStats; expiresAt: number } | null = null;
  private static readonly STATS_TTL_MS = 30_000;

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
          ON CREATE SET
            e.name = node.name,
            e.nameLower = node.nameLower,
            e.type = node.type,
            e.description = node.description,
            e.properties = node.properties,
            e.embedding = node.embedding,
            e.sourceDocumentIds = node.sourceDocumentIds,
            e.sourceChunkIds = node.sourceChunkIds,
            e.confidence = node.confidence,
            e.createdAt = node.createdAt,
            e.updatedAt = node.updatedAt
          ON MATCH SET
            e.name = node.name,
            e.nameLower = node.nameLower,
            e.type = node.type,
            e.description = CASE
              WHEN size(node.description) > size(coalesce(e.description, ''))
              THEN node.description
              ELSE e.description
            END,
            e.properties = node.properties,
            e.embedding = node.embedding,
            e.sourceDocumentIds = REDUCE(acc = [], x IN (coalesce(e.sourceDocumentIds, []) + coalesce(node.sourceDocumentIds, [])) | CASE WHEN x IN acc THEN acc ELSE acc + x END),
            e.sourceChunkIds = REDUCE(acc = [], x IN (coalesce(e.sourceChunkIds, []) + coalesce(node.sourceChunkIds, [])) | CASE WHEN x IN acc THEN acc ELSE acc + x END),
            e.confidence = node.confidence,
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
  /**
   * Look up existing Entity nodes by type + lowercased name pairs.
   * Returns a map from `type:lowerName` canonical key to the existing node ID.
   */
  async findNodeIdsByCanonicalKeys(
    keys: Array<{ type: string; lowerName: string }>
  ): Promise<Map<string, string>> {
    if (keys.length === 0) {
      return new Map();
    }

    return this.withSession("READ", async (session) => {
      const result = await session.run(
        `
        UNWIND $keys AS key
        MATCH (e:Entity)
        WHERE toLower(e.type) = key.type AND toLower(e.name) = key.lowerName
        RETURN key.type + ':' + key.lowerName AS canonicalKey, e.id AS nodeId
        LIMIT $limit
        `,
        {
          keys: keys.map((k) => ({ type: k.type.toLowerCase(), lowerName: k.lowerName })),
          limit: neo4j.int(keys.length * 2)
        }
      );

      const map = new Map<string, string>();
      for (const record of result.records) {
        const canonicalKey = this.toString(record.get("canonicalKey"), "");
        const nodeId = this.toString(record.get("nodeId"), "");
        if (canonicalKey.length > 0 && nodeId.length > 0 && !map.has(canonicalKey)) {
          map.set(canonicalKey, nodeId);
        }
      }
      return map;
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
          MATCH (source:Entity {id: edge.sourceNodeId})
          MATCH (target:Entity {id: edge.targetNodeId})
          MERGE (source)-[r:RELATED_TO {id: edge.id}]->(target)
          SET
            r.sourceNodeId = edge.sourceNodeId,
            r.targetNodeId = edge.targetNodeId,
            r.relationType = edge.relationType,
            r.description = edge.description,
            r.properties = edge.properties,
            r.weight = edge.weight,
            r.sourceDocumentIds = REDUCE(acc = [], x IN (coalesce(r.sourceDocumentIds, []) + coalesce(edge.sourceDocumentIds, [])) | CASE WHEN x IN acc THEN acc ELSE acc + x END),
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

  /**
   * Remove all graph data exclusively sourced by the given document.
   * Nodes/edges with only this document in sourceDocumentIds are deleted.
   * Nodes/edges also sourced by other documents just have the docId stripped.
   */
  async removeDocumentData(docId: string): Promise<void> {
    await this.withSession("WRITE", async (session) => {
      // Step 1: Delete edges exclusively sourced by this document,
      // or remove this docId from shared edges.
      // Use directed match to avoid processing each edge twice.
      await session.run(
        `
        MATCH ()-[r:RELATED_TO]->()
        WHERE $docId IN r.sourceDocumentIds
        WITH r, [x IN r.sourceDocumentIds WHERE x <> $docId] AS remaining
        FOREACH (_ IN CASE WHEN size(remaining) = 0 THEN [1] ELSE [] END | DELETE r)
        FOREACH (_ IN CASE WHEN size(remaining) > 0 THEN [1] ELSE [] END | SET r.sourceDocumentIds = remaining)
        `,
        { docId }
      );

      // Step 2: For nodes exclusively sourced by this document, only delete
      // if they have no remaining relationships (avoid DETACH DELETE which
      // would cascade-remove edges contributed by other documents).
      // First, remove docId from shared nodes.
      await session.run(
        `
        MATCH (e:Entity)
        WHERE $docId IN e.sourceDocumentIds
        WITH e, [x IN e.sourceDocumentIds WHERE x <> $docId] AS remaining
        WHERE size(remaining) > 0
        SET e.sourceDocumentIds = remaining
        `,
        { docId }
      );

      // Step 3: Delete orphan nodes that were exclusively sourced by this
      // document and have no remaining relationships.
      await session.run(
        `
        MATCH (e:Entity)
        WHERE $docId IN e.sourceDocumentIds
          AND size([x IN e.sourceDocumentIds WHERE x <> $docId]) = 0
          AND NOT EXISTS { (e)-[]-() }
        DELETE e
        `,
        { docId }
      );

      // Step 4: Any remaining nodes still referencing this docId — just
      // strip the docId (node stays alive because it has edges from other docs).
      await session.run(
        `
        MATCH (e:Entity)
        WHERE $docId IN e.sourceDocumentIds
        SET e.sourceDocumentIds = [x IN e.sourceDocumentIds WHERE x <> $docId]
        `,
        { docId }
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
          // Build dynamic WHERE clauses for node filtering (T7)
          const nodeFilterClauses: string[] = [];
          const sharedParams: Record<string, unknown> = {};

          if (query.nodeTypes && query.nodeTypes.length > 0) {
            nodeFilterClauses.push("n.type IN $nodeTypes");
            sharedParams.nodeTypes = query.nodeTypes;
          }
          if (query.documentIds && query.documentIds.length > 0) {
            nodeFilterClauses.push(
              "any(docId IN n.sourceDocumentIds WHERE docId IN $documentIds)"
            );
            sharedParams.documentIds = query.documentIds;
          }
          if (query.minConfidence !== undefined) {
            nodeFilterClauses.push("n.confidence >= $minConfidence");
            sharedParams.minConfidence = query.minConfidence;
          }

          const nodeFilterStr =
            nodeFilterClauses.length > 0 ? `AND ${nodeFilterClauses.join(" AND ")}` : "";

          let candidateNodes: GraphNode[];

          if (query.centerNodeIds && query.centerNodeIds.length > 0) {
            // Use iterative BFS expansion for reliable multi-hop traversal.
            // The previous OPTIONAL MATCH with variable-length paths could miss
            // multi-hop neighbors in certain Neo4j query plan scenarios.
            candidateNodes = await this.bfsExpandNodes(
              session,
              query.centerNodeIds,
              safeMaxDepth,
              safeMaxNodes,
              nodeFilterStr,
              sharedParams
            );
            logger.info(
              {
                centerNodeIds: query.centerNodeIds,
                safeMaxDepth,
                candidateNodeCount: candidateNodes.length,
                candidateNodeNames: candidateNodes.map((n) => n.name).slice(0, 20)
              },
              "Neo4j getSubgraph: candidate nodes found (BFS)"
            );
          } else {
            const nodeWhereStr =
              nodeFilterClauses.length > 0
                ? `WHERE ${nodeFilterClauses.map((c) => c.replace(/\bn\./g, "node.")).join(" AND ")}`
                : "";
            const cypher = `
              MATCH (node:Entity)
              ${nodeWhereStr}
              WITH node
              OPTIONAL MATCH (node)-[deg:RELATED_TO]-()
              WITH node, count(deg) AS degree
              ORDER BY degree DESC
              LIMIT $candidateLimit
              RETURN node
            `;
            const result = await session.run(cypher, {
              ...sharedParams,
              candidateLimit: neo4j.int(safeMaxNodes * 3)
            });
            candidateNodes = result.records.map((record) =>
              this.mapGraphNode(record.get("node") as Node)
            );
          }

          const nodes = candidateNodes.slice(0, safeMaxNodes);

          if (nodes.length === 0) {
            return { nodes: [], edges: [] };
          }

          // Build edge query with Cypher-level filtering (T7)
          const nodeIds = nodes.map((node) => node.id);
          const edgeWhereClauses: string[] = [
            "source.id IN $nodeIds",
            "target.id IN $nodeIds"
          ];
          const edgeParams: Record<string, unknown> = { nodeIds };

          if (query.relationTypes && query.relationTypes.length > 0) {
            edgeWhereClauses.push("r.relationType IN $relationTypes");
            edgeParams.relationTypes = query.relationTypes;
          }
          if (query.documentIds && query.documentIds.length > 0) {
            edgeWhereClauses.push(
              "any(docId IN r.sourceDocumentIds WHERE docId IN $edgeDocumentIds)"
            );
            edgeParams.edgeDocumentIds = query.documentIds;
          }
          if (query.minConfidence !== undefined) {
            edgeWhereClauses.push("r.confidence >= $edgeMinConfidence");
            edgeParams.edgeMinConfidence = query.minConfidence;
          }

          const edgeCypher = `
            MATCH (source:Entity)-[r:RELATED_TO]->(target:Entity)
            WHERE ${edgeWhereClauses.join(" AND ")}
            RETURN DISTINCT r
          `;
          const edgeResult = await session.run(edgeCypher, edgeParams);
          const edges = edgeResult.records.map((record) =>
            this.mapGraphEdge(record.get("r") as Relationship)
          );

          return { nodes, edges };
        });
      }

  /**
   * Iterative BFS expansion from seed nodes.
   * Each hop is a separate Cypher query that finds direct neighbors of the
   * current frontier, guaranteeing that multi-hop nodes are discovered
   * regardless of Neo4j query planner behavior with variable-length paths.
   */
  private async bfsExpandNodes(
    session: Session,
    seedIds: string[],
    maxDepth: number,
    maxNodes: number,
    nodeFilterStr: string,
    filterParams: Record<string, unknown>
  ): Promise<GraphNode[]> {
    const visitedIds = new Set<string>();
    const allNodes: GraphNode[] = [];

    // Step 0: fetch seed nodes themselves
    const seedResult = await session.run(
      `MATCH (n:Entity) WHERE n.id IN $ids RETURN n`,
      { ids: seedIds }
    );
    const seedNodes = seedResult.records.map((r) => this.mapGraphNode(r.get("n") as Node));
    for (const node of seedNodes) {
      if (!visitedIds.has(node.id)) {
        visitedIds.add(node.id);
        allNodes.push(node);
      }
    }

    logger.info(
      { seedCount: seedNodes.length, seedNames: seedNodes.map((n) => n.name) },
      "Neo4j BFS: seeds loaded"
    );

    // Frontier = IDs to expand from in the current hop
    let frontier = seedNodes.map((n) => n.id);

    for (let hop = 1; hop <= maxDepth; hop++) {
      if (frontier.length === 0 || allNodes.length >= maxNodes * 3) break;

      // Find all direct neighbors (both directions) of the frontier nodes
      // that haven't been visited yet.
      const hopCypher = `
        MATCH (src:Entity)-[:RELATED_TO]-(n:Entity)
        WHERE src.id IN $frontierIds AND NOT n.id IN $visitedIds
        ${nodeFilterStr}
        RETURN DISTINCT n
      `;
      const hopResult = await session.run(hopCypher, {
        ...filterParams,
        frontierIds: frontier,
        visitedIds: [...visitedIds]
      });

      const newNodes = hopResult.records.map((r) => this.mapGraphNode(r.get("n") as Node));
      const newFrontier: string[] = [];

      for (const node of newNodes) {
        if (!visitedIds.has(node.id)) {
          visitedIds.add(node.id);
          allNodes.push(node);
          newFrontier.push(node.id);
        }
      }

      logger.info(
        {
          hop,
          frontierSize: frontier.length,
          newNodesFound: newFrontier.length,
          newNodeNames: newNodes.map((n) => n.name).slice(0, 20),
          totalNodes: allNodes.length
        },
        "Neo4j BFS: hop completed"
      );

      frontier = newFrontier;
    }

    // Sort by degree (most connected first) for consistent prioritization
    if (allNodes.length > 0) {
      const degreeResult = await session.run(
        `
        UNWIND $nodeIds AS nid
        MATCH (n:Entity {id: nid})
        OPTIONAL MATCH (n)-[deg:RELATED_TO]-()
        RETURN n.id AS id, count(deg) AS degree
        `,
        { nodeIds: allNodes.map((n) => n.id) }
      );
      const degreeMap = new Map<string, number>();
      for (const record of degreeResult.records) {
        degreeMap.set(
          this.toString(record.get("id"), ""),
          this.toNumber(record.get("degree"))
        );
      }
      allNodes.sort((a, b) => (degreeMap.get(b.id) ?? 0) - (degreeMap.get(a.id) ?? 0));
    }

    return allNodes;
  }

  async getStats(): Promise<GraphStats> {
      // T8: Return cached stats if still valid
      if (this.statsCache && Date.now() < this.statsCache.expiresAt) {
        return this.statsCache.data;
      }

      const stats = await this.withSession("READ", async (session) => {
        // T8: Single Cypher query using CALL {} subqueries
        const result = await session.run(
          `
          CALL {
            MATCH (e:Entity)
            RETURN count(e) AS nodeCount
          }
          CALL {
            MATCH ()-[r:RELATED_TO]->()
            RETURN count(r) AS edgeCount
          }
          CALL {
            MATCH (d:Document)
            RETURN count(d) AS documentCount
          }
          CALL {
            MATCH (e:Entity)
            RETURN e.type AS ntName, count(*) AS ntValue
          }
          CALL {
            MATCH ()-[r:RELATED_TO]->()
            RETURN r.relationType AS etName, count(*) AS etValue
          }
          RETURN nodeCount, edgeCount, documentCount,
                 collect(DISTINCT {name: ntName, value: ntValue}) AS nodeTypeDist,
                 collect(DISTINCT {name: etName, value: etValue}) AS edgeTypeDist
          `
        );

        const row = result.records[0];
        const nodeCount = this.toNumber(row?.get("nodeCount"));
        const edgeCount = this.toNumber(row?.get("edgeCount"));
        const documentCount = this.toNumber(row?.get("documentCount"));

        const toDistMap = (items: unknown): Record<string, number> => {
          const map: Record<string, number> = {};
          if (!Array.isArray(items)) return map;
          for (const item of items) {
            if (item && typeof item === "object" && "name" in item && "value" in item) {
              const name = String((item as Record<string, unknown>).name ?? "");
              const value = this.toNumber((item as Record<string, unknown>).value);
              if (name.length > 0) {
                map[name] = value;
              }
            }
          }
          return map;
        };

        return {
          nodeCount,
          edgeCount,
          documentCount,
          nodeTypeDistribution: toDistMap(row?.get("nodeTypeDist")),
          edgeTypeDistribution: toDistMap(row?.get("edgeTypeDist"))
        };
      });

      // Cache the result
      this.statsCache = {
        data: stats,
        expiresAt: Date.now() + Neo4jGraphStore.STATS_TTL_MS
      };

      return stats;
    }

  private async ensureIndexes(): Promise<void> {
      const dimension = Math.max(1, Math.floor(this.config.embeddingDimensions));

      await this.withSession("WRITE", async (session) => {
        // Vector indexes
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

        // Fulltext index
        await session.run(
          `
          CREATE FULLTEXT INDEX entity_name_fulltext IF NOT EXISTS
          FOR (e:Entity) ON EACH [e.name, e.description]
          `
        );

        // T6: Unique constraints
        await session.run(
          `CREATE CONSTRAINT entity_id_unique IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE`
        );
        await session.run(
          `CREATE CONSTRAINT document_id_unique IF NOT EXISTS FOR (d:Document) REQUIRE d.id IS UNIQUE`
        );
        await session.run(
          `CREATE CONSTRAINT chunk_id_unique IF NOT EXISTS FOR (c:Chunk) REQUIRE c.id IS UNIQUE`
        );

        // T6: B-tree indexes for Entity.type and Entity.confidence
        await session.run(
          `CREATE INDEX entity_type_idx IF NOT EXISTS FOR (e:Entity) ON (e.type)`
        );
        await session.run(
          `CREATE INDEX entity_confidence_idx IF NOT EXISTS FOR (e:Entity) ON (e.confidence)`
        );

        // Index on lower-cased name for syncSingleFact OPTIONAL MATCH lookups
        await session.run(
          `CREATE INDEX entity_name_lower_idx IF NOT EXISTS FOR (e:Entity) ON (e.nameLower)`
        );
      });
    }
  // T16: Graph quality report
  async getQualityReport(): Promise<{
    ghostNodes: number;
    isolatedNodes: number;
    lowConfidenceNodes: number;
    suspectedDuplicates: number;
    totalNodes: number;
    totalEdges: number;
  }> {
    return this.withSession("READ", async (session) => {
      const result = await session.run(`
        CALL { MATCH (e:Entity) RETURN count(e) AS totalNodes }
        CALL { MATCH ()-[r:RELATED_TO]->() RETURN count(r) AS totalEdges }
        CALL { MATCH (e:Entity) WHERE e.type = "Unknown" RETURN count(e) AS ghostNodes }
        CALL {
          MATCH (e:Entity)
          WHERE NOT (e)--()
          RETURN count(e) AS isolatedNodes
        }
        CALL {
          MATCH (e:Entity)
          WHERE e.confidence < 0.5
          RETURN count(e) AS lowConfidenceNodes
        }
        CALL {
          MATCH (e:Entity)
          WITH e.name AS name, e.type AS type, count(*) AS cnt
          WHERE cnt > 1
          RETURN sum(cnt) AS suspectedDuplicates
        }
        RETURN totalNodes, totalEdges, ghostNodes, isolatedNodes, lowConfidenceNodes, suspectedDuplicates
      `);

      const row = result.records[0];
      return {
        totalNodes: this.toNumber(row?.get("totalNodes")),
        totalEdges: this.toNumber(row?.get("totalEdges")),
        ghostNodes: this.toNumber(row?.get("ghostNodes")),
        isolatedNodes: this.toNumber(row?.get("isolatedNodes")),
        lowConfidenceNodes: this.toNumber(row?.get("lowConfidenceNodes")),
        suspectedDuplicates: this.toNumber(row?.get("suspectedDuplicates"))
      };
    });
  }

  // T17: Export all nodes and edges
  async exportAllNodesAndEdges(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    return this.withSession("READ", async (session) => {
      const nodeResult = await session.run(`MATCH (e:Entity) RETURN e`);
      const nodes = nodeResult.records.map((r) => this.mapGraphNode(r.get("e") as Node));

      const edgeResult = await session.run(
        `MATCH (s:Entity)-[r:RELATED_TO]->(t:Entity) RETURN r, s.id AS sourceId, t.id AS targetId`
      );
      const edges = edgeResult.records.map((r) => this.mapGraphEdge(r.get("r") as Relationship));

      return { nodes, edges };
    });
  }

  async runCypher(query: string, params: Record<string, unknown> = {}): Promise<void> {
    await this.withSession("WRITE", async (session) => {
      await session.run(query, params);
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


  private serializeNode(node: GraphNode): Record<string, unknown> {
    return {
      id: node.id,
      name: node.name,
      nameLower: node.name.trim().toLowerCase().replace(/\s+/g, " "),
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
}
