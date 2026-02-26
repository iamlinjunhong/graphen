/**
 * 实体类型中英文映射 + 颜色配置
 * 与 useGraphData.ts 中 ENTITY_TYPE_COLORS 保持同步
 */

export interface EntityTypeConfig {
  en: string;
  zh: string;
  color: string;
}

export const ENTITY_TYPE_MAP: Record<string, EntityTypeConfig> = {
  Person: { en: "Person", zh: "人物", color: "#c4683f" },
  Technology: { en: "Technology", zh: "技术", color: "#229288" },
  Organization: { en: "Organization", zh: "组织", color: "#3d9863" },
  Concept: { en: "Concept", zh: "概念", color: "#3566b8" },
  Document: { en: "Document", zh: "文档", color: "#d89f38" },
  Event: { en: "Event", zh: "事件", color: "#cc5a6c" },
  Location: { en: "Location", zh: "地点", color: "#7f6ad4" },
  Metric: { en: "Metric", zh: "指标", color: "#63717a" }
};

const DEFAULT_CONFIG: EntityTypeConfig = { en: "Unknown", zh: "未知", color: "#8f8b80" };

export function getEntityTypeLabel(type: string): string {
  return ENTITY_TYPE_MAP[type]?.zh ?? type;
}

export function getEntityTypeColor(type: string): string {
  return ENTITY_TYPE_MAP[type]?.color ?? DEFAULT_CONFIG.color;
}

export function getEntityTypeConfig(type: string): EntityTypeConfig {
  return ENTITY_TYPE_MAP[type] ?? { ...DEFAULT_CONFIG, en: type };
}
