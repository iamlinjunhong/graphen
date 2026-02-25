import type { Response } from "express";
import { Router } from "express";
import { z } from "zod";
import type {
  AbstractGraphStore,
  GraphNode,
  SubgraphQuery
} from "@graphen/shared";
import type {
  GraphNodeResponse,
  GraphNodesResponse,
  GraphOverviewResponse,
  GraphSearchResponse,
  GraphSubgraphResponse,
  GraphVectorSearchResponse
} from "@graphen/shared";
import { validate } from "../middleware/validator.js";
import { ensureGraphStoreConnected, getGraphStoreSingleton } from "../runtime/graphRuntime.js";
import { logger } from "../utils/logger.js";

const nodeParamsSchema = z.object({
  id: z.string().min(1)
});

const graphNodesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  types: z.string().min(1).optional(),
  documentId: z.string().min(1).optional(),
  documentIds: z.string().min(1).optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional()
});

const neighborsQuerySchema = z.object({
  depth: z.coerce.number().int().min(1).max(5).default(1),
  maxNodes: z.coerce.number().int().min(1).max(1000).default(200)
});

const subgraphQuerySchema = z.object({
  centerNodeIds: z.string().optional(),
  nodeTypes: z.string().optional(),
  relationTypes: z.string().optional(),
  documentIds: z.string().optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  maxDepth: z.coerce.number().int().min(1).max(6).default(2),
  maxNodes: z.coerce.number().int().min(1).max(2000).default(200)
});

const searchQuerySchema = z.object({
  q: z.string().min(1),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
});

const vectorSearchBodySchema = z.object({
  vector: z.array(z.number().finite()).min(1),
  k: z.coerce.number().int().min(1).max(200).default(10),
  filter: z.record(z.unknown()).optional()
});

interface CreateGraphRouterOptions {
  store?: AbstractGraphStore;
  ensureStoreConnected?: () => Promise<void>;
}

function parseCsv(input?: string): string[] | undefined {
  if (!input) {
    return undefined;
  }

  const values = input
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return values.length > 0 ? values : undefined;
}

function mergeCsv(primary?: string, secondary?: string): string[] | undefined {
  const first = parseCsv(primary) ?? [];
  const second = parseCsv(secondary) ?? [];
  const values = [...first, ...second];
  if (values.length === 0) {
    return undefined;
  }
  return Array.from(new Set(values));
}

function nodeMatches(
  node: GraphNode,
  filters: {
    nodeTypes: string[] | undefined;
    documentIds: string[] | undefined;
    minConfidence: number | undefined;
  }
): boolean {
  if (filters.nodeTypes && filters.nodeTypes.length > 0 && !filters.nodeTypes.includes(node.type)) {
    return false;
  }

  if (filters.documentIds && filters.documentIds.length > 0) {
    const hit = node.sourceDocumentIds.some((id) => filters.documentIds?.includes(id));
    if (!hit) {
      return false;
    }
  }

  if (
    filters.minConfidence !== undefined &&
    Number.isFinite(filters.minConfidence) &&
    node.confidence < filters.minConfidence
  ) {
    return false;
  }

  return true;
}

export function createGraphRouter(options: CreateGraphRouterOptions = {}): Router {
  const store = options.store ?? getGraphStoreSingleton();
  const ensureStoreConnected =
    options.ensureStoreConnected ??
    (options.store ? () => store.connect() : () => ensureGraphStoreConnected(store));
  const graphRouter = Router();

  const ensureStoreReady = async (res: Response): Promise<boolean> => {
    try {
      await ensureStoreConnected();
      return true;
    } catch (error) {
      logger.error({ err: error }, "Graph store connection failed");
      res.status(503).json({ error: "Graph store unavailable" });
      return false;
    }
  };

  graphRouter.get("/overview", async (_req, res) => {
    if (!(await ensureStoreReady(res))) {
      return;
    }

    const stats = await store.getStats();
    const response: GraphOverviewResponse = {
      nodeCount: stats.nodeCount,
      edgeCount: stats.edgeCount,
      nodeTypeDistribution: stats.nodeTypeDistribution,
      edgeTypeDistribution: stats.edgeTypeDistribution
    };
    res.json(response);
  });

  graphRouter.get(
    "/nodes",
    validate({ query: graphNodesQuerySchema }),
    async (req, res) => {
      if (!(await ensureStoreReady(res))) {
        return;
      }

      const { page, pageSize, q, type, types, documentId, documentIds, minConfidence } =
        req.query as unknown as z.infer<typeof graphNodesQuerySchema>;
      const offset = (page - 1) * pageSize;
      const nodeTypes = mergeCsv(type, types);
      const docIds = mergeCsv(documentId, documentIds);

      let candidates: GraphNode[] = [];

      if (q) {
        const fetchLimit = Math.min(2000, Math.max(offset + pageSize, pageSize * 3));
        const searchResults = await store.searchNodes(q, fetchLimit);
        candidates = searchResults.map((item) => item.node);
        candidates = candidates.filter((node) =>
          nodeMatches(node, {
            nodeTypes,
            documentIds: docIds,
            minConfidence
          })
        );
      } else if (nodeTypes && nodeTypes.length === 1 && !docIds && minConfidence === undefined) {
        const singleType = nodeTypes[0];
        if (!singleType) {
          candidates = [];
        } else {
          candidates = await store.getNodesByType(singleType, pageSize, offset);
        }
      } else {
        const query: SubgraphQuery = {
          maxNodes: Math.min(2000, Math.max(offset + pageSize, pageSize * 4))
        };
        if (nodeTypes) {
          query.nodeTypes = nodeTypes;
        }
        if (docIds) {
          query.documentIds = docIds;
        }
        if (minConfidence !== undefined) {
          query.minConfidence = minConfidence;
        }
        const subgraph = await store.getSubgraph(query);
        candidates = subgraph.nodes;
      }

      candidates = candidates.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

      const isDirectPagedByStore =
        !q && nodeTypes && nodeTypes.length === 1 && !docIds && minConfidence === undefined;
      const nodes = isDirectPagedByStore
        ? candidates
        : candidates.slice(offset, offset + pageSize);

      res.setHeader("x-total-count", String(candidates.length));
      res.setHeader("x-page", String(page));
      res.setHeader("x-page-size", String(pageSize));

      const response: GraphNodesResponse = { nodes };
      res.json(response);
    }
  );

  graphRouter.get(
    "/nodes/:id",
    validate({ params: nodeParamsSchema }),
    async (req, res) => {
      if (!(await ensureStoreReady(res))) {
        return;
      }

      const nodeId = req.params.id ?? "";
      const node = await store.getNodeById(nodeId);
      if (!node) {
        return res.status(404).json({ error: "Node not found" });
      }

      const response: GraphNodeResponse = { node };
      return res.json(response);
    }
  );

  graphRouter.get(
    "/nodes/:id/neighbors",
    validate({
      params: nodeParamsSchema,
      query: neighborsQuerySchema
    }),
    async (req, res) => {
      if (!(await ensureStoreReady(res))) {
        return;
      }

      const nodeId = req.params.id ?? "";
      const { depth, maxNodes } = req.query as unknown as z.infer<typeof neighborsQuerySchema>;

      const root = await store.getNodeById(nodeId);
      if (!root) {
        return res.status(404).json({ error: "Node not found" });
      }

      const subgraph = await store.getNeighbors(nodeId, depth);
      if (subgraph.nodes.length <= maxNodes) {
        const response: GraphSubgraphResponse = subgraph;
        return res.json(response);
      }

      const ordered = [
        root,
        ...subgraph.nodes.filter((node) => node.id !== root.id)
      ].slice(0, maxNodes);
      const allowedIds = new Set(ordered.map((node) => node.id));
      const edges = subgraph.edges.filter(
        (edge) => allowedIds.has(edge.sourceNodeId) && allowedIds.has(edge.targetNodeId)
      );

      const response: GraphSubgraphResponse = {
        nodes: ordered,
        edges
      };
      return res.json(response);
    }
  );

  graphRouter.get(
    "/subgraph",
    validate({ query: subgraphQuerySchema }),
    async (req, res) => {
      if (!(await ensureStoreReady(res))) {
        return;
      }

      const {
        centerNodeIds,
        nodeTypes,
        relationTypes,
        documentIds,
        minConfidence,
        maxDepth,
        maxNodes
      } = req.query as unknown as z.infer<typeof subgraphQuerySchema>;

      const query: SubgraphQuery = {
        maxDepth,
        maxNodes
      };
      const parsedCenterNodeIds = parseCsv(centerNodeIds);
      const parsedNodeTypes = parseCsv(nodeTypes);
      const parsedRelationTypes = parseCsv(relationTypes);
      const parsedDocumentIds = parseCsv(documentIds);
      if (parsedCenterNodeIds) {
        query.centerNodeIds = parsedCenterNodeIds;
      }
      if (parsedNodeTypes) {
        query.nodeTypes = parsedNodeTypes;
      }
      if (parsedRelationTypes) {
        query.relationTypes = parsedRelationTypes;
      }
      if (parsedDocumentIds) {
        query.documentIds = parsedDocumentIds;
      }
      if (minConfidence !== undefined) {
        query.minConfidence = minConfidence;
      }

      const response: GraphSubgraphResponse = await store.getSubgraph(query);
      return res.json(response);
    }
  );

  graphRouter.get(
    "/search",
    validate({ query: searchQuerySchema }),
    async (req, res) => {
      if (!(await ensureStoreReady(res))) {
        return;
      }

      const { q, page, pageSize } = req.query as unknown as z.infer<
        typeof searchQuerySchema
      >;
      const offset = (page - 1) * pageSize;
      const fetchLimit = Math.min(2000, Math.max(offset + pageSize, pageSize * 3));
      const results = await store.searchNodes(q, fetchLimit);
      const sliced = results.slice(offset, offset + pageSize);

      res.setHeader("x-total-count", String(results.length));
      res.setHeader("x-page", String(page));
      res.setHeader("x-page-size", String(pageSize));

      const response: GraphSearchResponse = {
        query: q,
        results: sliced.map((item) => item.node)
      };
      return res.json(response);
    }
  );

  graphRouter.post(
    "/vector-search",
    validate({ body: vectorSearchBodySchema }),
    async (req, res) => {
      if (!(await ensureStoreReady(res))) {
        return;
      }

      const { vector, k, filter } = req.body as z.infer<typeof vectorSearchBodySchema>;
      const results = await store.vectorSearch(vector, k, filter);

      const response: GraphVectorSearchResponse = {
        results
      };
      return res.json(response);
    }
  );

  return graphRouter;
}

export const graphRouter = createGraphRouter();
