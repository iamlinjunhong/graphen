import type {
  ChatMessage,
  ChatSession,
  ConfigModelsResponse,
  CreateChatMessageRequest,
  CreateChatMessageResponse,
  CreateChatSessionRequest,
  CreateChatSessionResponse,
  Document,
  DocumentStatus,
  GetConfigResponse,
  GetDocumentContentResponse,
  GraphEdge,
  GraphNode,
  GraphOverviewResponse,
  GraphSubgraphResponse,
  GraphVectorSearchRequest,
  GraphVectorSearchResponse,
  HealthResponse,
  ListChatSessionsResponse,
  UpdateConfigRequest,
  UpdateConfigResponse
} from "@graphen/shared";
import type {
  ChatSessionDetailResponse,
  GetDocumentResponse,
  GraphExportResponse,
  GraphNodeResponse,
  GraphNodesResponse,
  GraphQualityResponse,
  GraphSearchResponse,
  ListDocumentsResponse,
  ReparseDocumentResponse,
  TestConnectionResponse,
  UploadDocumentResponse
} from "@graphen/shared";

export class ApiClientError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.details = details;
  }
}

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
type QueryPrimitive = string | number | boolean | null | undefined;
type QueryValue = QueryPrimitive | QueryPrimitive[];
type QueryParams = Record<string, QueryValue>;

interface RequestOptions {
  method?: HttpMethod;
  query?: QueryParams;
  headers?: Record<string, string>;
  body?: BodyInit | null | undefined;
  json?: unknown;
  signal?: AbortSignal | undefined;
}

interface RequestResult<T> {
  data: T;
  headers: Headers;
  status: number;
}

interface PaginationMeta {
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface PaginatedResult<T> extends PaginationMeta {
  items: T[];
}

export interface UploadDocumentAccepted extends UploadDocumentResponse {
  documentId: string;
}

export interface DocumentStatusSnapshot {
  id: string;
  status: DocumentStatus | "pending";
  phase?: string;
  progress?: number;
  message?: string;
  updatedAt: Date;
}

interface RawDocument extends Omit<Document, "uploadedAt" | "parsedAt"> {
  uploadedAt: string | Date;
  parsedAt?: string | Date;
}

interface RawGraphNode extends Omit<GraphNode, "createdAt" | "updatedAt"> {
  createdAt: string | Date;
  updatedAt: string | Date;
}

interface RawGraphEdge extends Omit<GraphEdge, "createdAt"> {
  createdAt: string | Date;
}

interface RawChatSession extends Omit<ChatSession, "createdAt" | "updatedAt"> {
  createdAt: string | Date;
  updatedAt: string | Date;
}

interface RawChatMessage extends Omit<ChatMessage, "createdAt"> {
  createdAt: string | Date;
}

const API_BASE_URL = resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL as string | undefined);

function resolveApiBaseUrl(rawBaseUrl: string | undefined): string {
  if (!rawBaseUrl || rawBaseUrl.trim().length === 0) {
    return "http://localhost:3001/api";
  }

  const trimmed = rawBaseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/api")) {
    return trimmed;
  }
  return `${trimmed}/api`;
}

function buildQuery(query?: QueryParams): string {
  if (!query) {
    return "";
  }

  const searchParams = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(query)) {
    if (rawValue === undefined || rawValue === null) {
      continue;
    }

    if (Array.isArray(rawValue)) {
      const values = rawValue
        .filter((item): item is string | number | boolean => item !== undefined && item !== null)
        .map(String)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      if (values.length > 0) {
        searchParams.set(key, values.join(","));
      }
      continue;
    }

    searchParams.set(key, String(rawValue));
  }

  const serialized = searchParams.toString();
  return serialized.length > 0 ? `?${serialized}` : "";
}

function toDate(value: string | Date): Date {
  if (value instanceof Date) {
    return value;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date(0);
  }
  return parsed;
}

function parseDocument(raw: RawDocument): Document {
  const { uploadedAt, parsedAt, ...rest } = raw;
  const document: Document = {
    ...rest,
    uploadedAt: toDate(uploadedAt)
  };
  if (parsedAt !== undefined) {
    document.parsedAt = toDate(parsedAt);
  }
  return document;
}

function parseGraphNode(raw: RawGraphNode): GraphNode {
  return {
    ...raw,
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt)
  };
}

function parseGraphEdge(raw: RawGraphEdge): GraphEdge {
  return {
    ...raw,
    createdAt: toDate(raw.createdAt)
  };
}

function parseChatSession(raw: RawChatSession): ChatSession {
  return {
    ...raw,
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt)
  };
}

function parseChatMessage(raw: RawChatMessage): ChatMessage {
  return {
    ...raw,
    createdAt: toDate(raw.createdAt)
  };
}

function parsePagination(headers: Headers): PaginationMeta {
  const totalCount = Number(headers.get("x-total-count") ?? "0");
  const page = Number(headers.get("x-page") ?? "1");
  const pageSize = Number(headers.get("x-page-size") ?? "20");

  return {
    totalCount: Number.isFinite(totalCount) ? totalCount : 0,
    page: Number.isFinite(page) ? page : 1,
    pageSize: Number.isFinite(pageSize) ? pageSize : 20
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readErrorPayload(response: Response): Promise<{
  message: string;
  details?: unknown;
}> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    return {
      message: text.trim().length > 0 ? text : `Request failed with status ${response.status}`
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      message: `Request failed with status ${response.status}`
    };
  }

  if (!isRecord(payload)) {
    return {
      message: `Request failed with status ${response.status}`
    };
  }

  const error = payload.error;
  const details = payload.details;
  return {
    message: typeof error === "string" ? error : `Request failed with status ${response.status}`,
    details
  };
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<RequestResult<T>> {
  const query = buildQuery(options.query);
  const url = `${API_BASE_URL}${path}${query}`;
  const headers = new Headers(options.headers);

  let body: BodyInit | null | undefined = options.body;
  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.json);
  }

  const requestInit: RequestInit = {
    method: options.method ?? "GET",
    headers
  };
  if (body !== undefined) {
    requestInit.body = body;
  }
  if (options.signal !== undefined) {
    requestInit.signal = options.signal;
  }

  const response = await fetch(url, requestInit);

  if (!response.ok) {
    const { message, details } = await readErrorPayload(response);
    throw new ApiClientError(message, response.status, details);
  }

  if (response.status === 204) {
    return {
      data: undefined as T,
      headers: response.headers,
      status: response.status
    };
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiClientError("Unexpected response type from API", response.status);
  }

  const data = (await response.json()) as T;
  return {
    data,
    headers: response.headers,
    status: response.status
  };
}

export const apiClient = {
  documents: {
    async list(params?: {
      page?: number;
      pageSize?: number;
      status?: DocumentStatus;
      signal?: AbortSignal;
    }): Promise<PaginatedResult<Document>> {
      const result = await request<ListDocumentsResponse>("/documents", {
        query: {
          page: params?.page,
          pageSize: params?.pageSize,
          status: params?.status
        },
        signal: params?.signal
      });

      const pagination = parsePagination(result.headers);
      return {
        items: result.data.documents.map((document) => parseDocument(document as RawDocument)),
        ...pagination
      };
    },

    async getById(id: string, signal?: AbortSignal): Promise<Document> {
      const result = await request<GetDocumentResponse>(`/documents/${id}`, { signal });
      return parseDocument(result.data.document as RawDocument);
    },

    async upload(file: File, signal?: AbortSignal): Promise<UploadDocumentAccepted> {
      const formData = new FormData();
      formData.set("file", file);

      const result = await request<UploadDocumentResponse>("/documents/upload", {
        method: "POST",
        body: formData,
        signal
      });

      const documentId =
        result.data.documentId || result.headers.get("x-document-id") || "";
      return {
        ...result.data,
        documentId
      };
    },

    async delete(id: string, signal?: AbortSignal): Promise<void> {
      await request<void>(`/documents/${id}`, {
        method: "DELETE",
        signal
      });
    },

    async reparse(id: string, content?: string, signal?: AbortSignal): Promise<ReparseDocumentResponse> {
      const result = await request<ReparseDocumentResponse>(`/documents/${id}/reparse`, {
        method: "POST",
        json: content !== undefined ? { content } : undefined,
        signal
      });
      return result.data;
    },

    async getContent(id: string, signal?: AbortSignal): Promise<GetDocumentContentResponse> {
      const result = await request<GetDocumentContentResponse>(
        `/documents/${id}/content`,
        { signal }
      );
      return result.data;
    },

    async getStatus(id: string, signal?: AbortSignal): Promise<DocumentStatus | "pending"> {
      const result = await request<{ id: string; status: DocumentStatus | "pending" }>(
        `/documents/${id}/status`,
        { signal }
      );
      return result.data.status;
    },

    statusStreamUrl(id: string): string {
      return `${API_BASE_URL}/documents/${id}/status?stream=true`;
    },

    async getPreview(id: string, signal?: AbortSignal): Promise<string> {
      const result = await request<{ documentId: string; preview: string }>(
        `/documents/${id}/preview`,
        { signal }
      );
      return result.data.preview;
    }
  },

  graph: {
    async getOverview(signal?: AbortSignal): Promise<GraphOverviewResponse> {
      const result = await request<GraphOverviewResponse>("/graph/overview", { signal });
      return result.data;
    },

    async getNodes(params?: {
      page?: number;
      pageSize?: number;
      q?: string;
      type?: string;
      types?: string[];
      documentId?: string;
      documentIds?: string[];
      minConfidence?: number;
      signal?: AbortSignal;
    }): Promise<PaginatedResult<GraphNode>> {
      const result = await request<GraphNodesResponse>("/graph/nodes", {
        query: {
          page: params?.page,
          pageSize: params?.pageSize,
          q: params?.q,
          type: params?.type,
          types: params?.types,
          documentId: params?.documentId,
          documentIds: params?.documentIds,
          minConfidence: params?.minConfidence
        },
        signal: params?.signal
      });

      const pagination = parsePagination(result.headers);
      return {
        items: result.data.nodes.map((node) => parseGraphNode(node as RawGraphNode)),
        ...pagination
      };
    },

    async getNodeById(id: string, signal?: AbortSignal): Promise<GraphNode> {
      const result = await request<GraphNodeResponse>(`/graph/nodes/${id}`, { signal });
      return parseGraphNode(result.data.node as RawGraphNode);
    },

    async getNeighbors(
      id: string,
      params?: { depth?: number; maxNodes?: number; signal?: AbortSignal }
    ): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
      const result = await request<GraphSubgraphResponse>(`/graph/nodes/${id}/neighbors`, {
        query: {
          depth: params?.depth,
          maxNodes: params?.maxNodes
        },
        signal: params?.signal
      });
      return {
        nodes: result.data.nodes.map((node) => parseGraphNode(node as RawGraphNode)),
        edges: result.data.edges.map((edge) => parseGraphEdge(edge as RawGraphEdge))
      };
    },

    async getSubgraph(params?: {
      centerNodeIds?: string[];
      nodeTypes?: string[];
      relationTypes?: string[];
      documentIds?: string[];
      minConfidence?: number;
      maxDepth?: number;
      maxNodes?: number;
      signal?: AbortSignal;
    }): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
      const result = await request<GraphSubgraphResponse>("/graph/subgraph", {
        query: {
          centerNodeIds: params?.centerNodeIds,
          nodeTypes: params?.nodeTypes,
          relationTypes: params?.relationTypes,
          documentIds: params?.documentIds,
          minConfidence: params?.minConfidence,
          maxDepth: params?.maxDepth,
          maxNodes: params?.maxNodes
        },
        signal: params?.signal
      });
      return {
        nodes: result.data.nodes.map((node) => parseGraphNode(node as RawGraphNode)),
        edges: result.data.edges.map((edge) => parseGraphEdge(edge as RawGraphEdge))
      };
    },

    async search(
      query: string,
      params?: { page?: number; pageSize?: number; signal?: AbortSignal }
    ): Promise<PaginatedResult<GraphNode>> {
      const result = await request<GraphSearchResponse>("/graph/search", {
        query: {
          q: query,
          page: params?.page,
          pageSize: params?.pageSize
        },
        signal: params?.signal
      });

      const pagination = parsePagination(result.headers);
      return {
        items: result.data.results.map((node) => parseGraphNode(node as RawGraphNode)),
        ...pagination
      };
    },

    async vectorSearch(
      payload: GraphVectorSearchRequest,
      signal?: AbortSignal
    ): Promise<GraphVectorSearchResponse> {
      const result = await request<GraphVectorSearchResponse>("/graph/vector-search", {
        method: "POST",
        json: payload,
        signal
      });
      return {
        results: result.data.results.map((item) => ({
          ...item,
          node: parseGraphNode(item.node as RawGraphNode)
        }))
      };
    },

    async getQuality(signal?: AbortSignal): Promise<GraphQualityResponse> {
      const result = await request<GraphQualityResponse>("/graph/quality", { signal });
      return result.data;
    },

    async exportGraph(
      format: "jsonld" | "cypher" = "jsonld",
      signal?: AbortSignal
    ): Promise<GraphExportResponse> {
      const result = await request<GraphExportResponse>("/graph/export", {
        query: { format },
        signal
      });
      return result.data;
    }
  },

  chat: {
    async createSession(
      payload: CreateChatSessionRequest,
      signal?: AbortSignal
    ): Promise<ChatSession> {
      const result = await request<CreateChatSessionResponse>("/chat/sessions", {
        method: "POST",
        json: payload,
        signal
      });
      return parseChatSession(result.data.session as RawChatSession);
    },

    async listSessions(
      params?: { limit?: number; signal?: AbortSignal }
    ): Promise<ChatSession[]> {
      const result = await request<ListChatSessionsResponse>("/chat/sessions", {
        query: {
          limit: params?.limit
        },
        signal: params?.signal
      });
      return result.data.sessions.map((session) => parseChatSession(session as RawChatSession));
    },

    async getSessionDetail(id: string, signal?: AbortSignal): Promise<{
      session: ChatSession;
      messages: ChatMessage[];
    }> {
      const result = await request<ChatSessionDetailResponse>(`/chat/sessions/${id}`, {
        signal
      });
      return {
        session: parseChatSession(result.data.session as RawChatSession),
        messages: result.data.session.messages.map((message) =>
          parseChatMessage(message as RawChatMessage)
        )
      };
    },

    async deleteSession(id: string, signal?: AbortSignal): Promise<void> {
      await request<void>(`/chat/sessions/${id}`, {
        method: "DELETE",
        signal
      });
    },

    async sendMessage(
      id: string,
      payload: CreateChatMessageRequest,
      signal?: AbortSignal
    ): Promise<CreateChatMessageResponse> {
      const result = await request<CreateChatMessageResponse>(`/chat/sessions/${id}/messages`, {
        method: "POST",
        json: payload,
        signal
      });
      return result.data;
    },

    streamUrl(id: string): string {
      return `${API_BASE_URL}/chat/sessions/${id}/messages?stream=true`;
    },

    parseMessage(raw: ChatMessage): ChatMessage {
      return parseChatMessage(raw as RawChatMessage);
    }
  },

  config: {
    async get(signal?: AbortSignal): Promise<GetConfigResponse> {
      const result = await request<GetConfigResponse>("/config", { signal });
      return result.data;
    },

    async update(payload: UpdateConfigRequest, signal?: AbortSignal): Promise<UpdateConfigResponse> {
      const result = await request<UpdateConfigResponse>("/config", {
        method: "PUT",
        json: payload,
        signal
      });
      return result.data;
    },

    async getModels(signal?: AbortSignal): Promise<ConfigModelsResponse> {
      const result = await request<ConfigModelsResponse>("/config/models", {
        signal
      });
      return result.data;
    },

    async testConnection(signal?: AbortSignal): Promise<TestConnectionResponse> {
      const result = await request<TestConnectionResponse>("/config/test-connection", {
        method: "POST",
        signal
      });
      return result.data;
    }
  },

  health: {
    async get(signal?: AbortSignal): Promise<HealthResponse> {
      const result = await request<HealthResponse>("/health", {
        signal
      });
      return result.data;
    }
  }
};

export type ApiClient = typeof apiClient;
