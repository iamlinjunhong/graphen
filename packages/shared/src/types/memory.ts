// Memory Agent 类型定义
// MemoryFact 是对 GraphEdge 的元数据增强 + 独立的非图谱事实
// 存储在 SQLite 中，通过 nodeId 与 Neo4j 图谱松耦合

export type MemorySourceType =
  | "document"       // 文档管线提取
  | "chat_user"      // 用户对话消息
  | "chat_assistant"  // 助手回复（低置信度）
  | "manual";        // 用户手工输入

export type MemoryEntryState =
  | "active"
  | "paused"
  | "archived"
  | "deleted";

export type FactReviewStatus =
  | "auto"           // 系统自动提取，未审阅
  | "confirmed"      // 用户确认
  | "modified"       // 用户修改过
  | "rejected"       // 用户拒绝
  | "conflicted";    // 与其他事实冲突

export type MemoryFactState = "active" | "deleted";

export type FactValueType = "entity" | "text" | "number" | "date";

export interface MemoryFact {
  id: string;
  entryId?: string;

  // 三元组核心
  subjectNodeId: string;       // 关联 GraphNode.id
  subjectText?: string;        // 主语文本兜底（PG 分层模型）
  predicate: string;
  objectNodeId?: string;       // 对象是实体时
  objectText?: string;         // 对象是文本值时
  valueType: FactValueType;

  // 去重与置信度
  normalizedKey: string;       // subject|predicate|object 的标准化键
  confidence: number;          // 综合置信度 0-1
  factState?: MemoryFactState; // PG 分层模型的事实状态

  // 审阅状态
  reviewStatus: FactReviewStatus;
  reviewNote?: string;

  // 时间戳（ISO 字符串，SQLite 友好）
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;          // 软删除
  neo4jSynced?: boolean;
  neo4jSyncedAt?: string;
  neo4jRetryCount?: number;
  neo4jLastError?: string;
}

export interface MemoryEntry {
  id: string;
  content: string;
  embedding?: number[];
  normalizedContentKey: string;
  state: MemoryEntryState;
  reviewStatus: FactReviewStatus;
  reviewNote?: string;
  categories: string[];
  sourceType: MemorySourceType;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  similarity?: number;
}

export interface MemoryEntryFact {
  id: string;
  entryId: string;
  subjectNodeId?: string;
  subjectText: string;
  predicate: string;
  objectNodeId?: string;
  objectText?: string;
  valueType: FactValueType;
  normalizedFactKey: string;
  confidence: number;
  factState: MemoryFactState;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  neo4jSynced: boolean;
  neo4jSyncedAt?: string;
  neo4jRetryCount: number;
  neo4jLastError?: string;
}

export interface MemoryEntryCreateMetadata {
  categories?: string[];
  sourceType?: MemorySourceType;
  state?: MemoryEntryState;
  reviewStatus?: FactReviewStatus;
  reviewNote?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  embedding?: number[];
}

export interface MemoryEntryUpdateMetadata {
  categories?: string[];
  sourceType?: MemorySourceType;
  state?: MemoryEntryState;
  reviewStatus?: FactReviewStatus;
  reviewNote?: string;
  lastSeenAt?: string;
  embedding?: number[] | null;
}

export interface MemoryEntryUpsertFactInput {
  subjectNodeId?: string;
  subjectText?: string;
  predicate: string;
  objectNodeId?: string;
  objectText?: string;
  valueType?: FactValueType;
  confidence?: number;
  factState?: MemoryFactState;
}

export interface MemoryEntrySearchFilters {
  states?: MemoryEntryState[];
  reviewStatus?: FactReviewStatus[];
  sourceTypes?: MemorySourceType[];
  categories?: string[];
  includeDeleted?: boolean;
}

export interface MemoryEntrySearchQuery {
  query?: string;
  filters?: MemoryEntrySearchFilters;
  page?: number;
  pageSize?: number;
  sortBy?: "content" | "sourceType" | "createdAt" | "updatedAt" | "lastSeenAt";
  sortOrder?: "asc" | "desc";
}

export interface PaginatedEntries {
  entries: MemoryEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UpsertEntryFactsResult {
  created: number;
  updated: number;
  facts: MemoryEntryFact[];
}

export interface MemoryEntryWithFacts {
  entry: MemoryEntry;
  facts: MemoryEntryFact[];
}

export interface MemoryEvidence {
  id: string;
  factId: string;
  sourceType: MemorySourceType;

  // 来源定位（按 sourceType 填充不同字段）
  documentId?: string;
  chunkId?: string;
  chatSessionId?: string;
  chatMessageId?: string;

  excerpt?: string;            // 证据原文片段
  extractedAt: string;
}


// --- 存储层接口 ---

/** 查询 facts 的筛选条件 */
export interface MemoryFactQuery {
  subjectNodeId?: string;
  reviewStatus?: FactReviewStatus[];
  sourceType?: MemorySourceType;
  documentId?: string;
  chatSessionId?: string;
  since?: string;              // ISO 时间戳，用于增量查询
  page?: number;
  pageSize?: number;
}

/** 分页结果 */
export interface PaginatedFacts {
  facts: MemoryFact[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * MemoryStoreLike — 记忆存储层接口（类似 ChatStoreLike）
 * 负责 SQLite 层面的 CRUD，不含业务逻辑
 */
export interface MemoryStoreLike {
  close(): void;

  // Fact CRUD
  createFact(fact: Omit<MemoryFact, "createdAt" | "updatedAt">): MemoryFact;
  getFacts(query: MemoryFactQuery): PaginatedFacts;
  getFactById(id: string): MemoryFact | null;
  getFactByNormalizedKey(normalizedKey: string): MemoryFact | null;
  getFactsByNodeId(nodeId: string, limit?: number): MemoryFact[];
  updateFact(id: string, updates: Partial<Pick<MemoryFact,
    "predicate" | "objectNodeId" | "objectText" | "valueType" |
    "normalizedKey" | "confidence" | "reviewStatus" | "reviewNote" |
    "lastSeenAt" | "deletedAt"
  >>): MemoryFact | null;
  softDeleteFact(id: string): boolean;

  // Evidence CRUD
  addEvidence(evidence: Omit<MemoryEvidence, "id">): MemoryEvidence;
  getEvidenceByFactId(factId: string): MemoryEvidence[];
}

export interface MemoryEntryStoreLike {
  createEntry(
    content: string,
    embedding?: number[] | null,
    metadata?: MemoryEntryCreateMetadata
  ): Promise<MemoryEntry>;
  updateEntry(
    id: string,
    content: string,
    embedding?: number[] | null,
    metadata?: MemoryEntryUpdateMetadata
  ): Promise<MemoryEntry | null>;
  getEntry(id: string): Promise<MemoryEntry | null>;
  upsertFacts(entryId: string, facts: MemoryEntryUpsertFactInput[]): Promise<UpsertEntryFactsResult>;
  searchEntries(input: MemoryEntrySearchQuery): Promise<PaginatedEntries>;
  searchEntriesByVector(embedding: number[], limit?: number): Promise<MemoryEntry[]>;
  getEntryFacts(entryId: string): Promise<MemoryEntryFact[]>;
  updateEntryState(ids: string[], state: MemoryEntryState, changedBy?: string): Promise<number>;
  deleteEntries(ids: string[]): Promise<number>;
}

// --- 服务层接口 ---

/** mergeFacts 的输入：候选事实 + 证据 */
export interface CandidateFact {
  subjectNodeId: string;
  predicate: string;
  objectNodeId?: string;
  objectText?: string;
  valueType: FactValueType;
  confidence: number;
  evidence: Omit<MemoryEvidence, "id" | "factId">;
}

/** mergeFacts 的结果 */
export interface MergeResult {
  created: number;
  updated: number;
  conflicted: number;
}

/** 审阅操作 */
export type ReviewAction = "confirm" | "reject" | "resolve";

/**
 * MemoryServiceLike — 记忆业务逻辑接口
 * 包含合并去重、审阅、检索等高层操作
 */
export interface MemoryServiceLike {
  /** 批量合并候选事实（去重 + 冲突检测） */
  mergeFacts(candidates: CandidateFact[]): MergeResult;

  /** 审阅事实（确认/拒绝/解决冲突） */
  reviewFact(factId: string, action: ReviewAction, note?: string): MemoryFact | null;

  /** 按关联节点 ID 检索相关记忆（用于对话上下文注入） */
  retrieveRelevant(nodeIds: string[], limit?: number): MemoryFact[];

  /** 将记忆格式化为 LLM prompt 文本 */
  buildMemoryContextText(facts: MemoryFact[]): string;

  /** 创建 Entry（自由文本主记录） */
  createEntry(content: string, metadata?: MemoryEntryCreateMetadata): Promise<MemoryEntry>;

  /** 编辑 Entry 文本 */
  updateEntry(
    id: string,
    content: string,
    metadata?: MemoryEntryUpdateMetadata
  ): Promise<MemoryEntry | null>;

  /** 获取 Entry + 关联 Facts */
  getEntryWithFacts(id: string): Promise<MemoryEntryWithFacts | null>;
}
