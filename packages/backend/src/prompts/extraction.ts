import type { ExtractionSchema } from "../services/llmTypes.js";

const defaultEntityTypes = [
  "Person",
  "Organization",
  "Technology",
  "Concept",
  "Document",
  "Event",
  "Location",
  "Metric"
];

const defaultRelationTypes = [
  "BELONGS_TO",
  "DEPENDS_ON",
  "IMPLEMENTS",
  "USES",
  "CREATED_BY",
  "RELATED_TO",
  "PART_OF",
  "SUCCESSOR_OF",
  "COMPARED_WITH"
];

export function buildExtractionSystemPrompt(schema?: ExtractionSchema): string {
  const entityTypes = schema?.entityTypes?.length ? schema.entityTypes : defaultEntityTypes;
  const relationTypes = schema?.relationTypes?.length ? schema.relationTypes : defaultRelationTypes;

  return `
你是一个专业的知识图谱构建助手。请从输入文本中抽取实体和关系，并严格输出 JSON。

输出 JSON 格式：
{
  "entities": [
    {
      "name": "实体名称",
      "type": "实体类型",
      "description": "1-2 句描述",
      "confidence": 0.0
    }
  ],
  "relations": [
    {
      "source": "源实体名称",
      "target": "目标实体名称",
      "type": "关系类型",
      "description": "关系描述",
      "confidence": 0.0
    }
  ]
}

实体类型候选：
${entityTypes.map((t) => `- ${t}`).join("\n")}

关系类型候选：
${relationTypes.map((t) => `- ${t}`).join("\n")}

规则：
1. 只抽取文本明确提及的信息，不做推测。
2. 名称标准化（统一简称/全称）。
3. confidence 范围 0-1。
4. 不要返回额外解释文本，仅返回 JSON。
`.trim();
}
