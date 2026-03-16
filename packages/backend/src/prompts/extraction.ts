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
  "COMPARED_WITH",
  "CEO_OF",
  "FOUNDER_OF",
  "EMPLOYED_BY",
  "MANAGES",
  "SUBSIDIARY_OF",
  "INVESTED_IN",
  "ACQUIRED_BY",
  "PARTNER_OF",
  "LOCATED_IN",
  "PRODUCES",
  "SUPPLIES_TO"
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

关系类型候选（请严格按语义选择最匹配的类型）：
${relationTypes.map((t) => `- ${t}`).join("\n")}

关系类型选择指南：
- CEO_OF: 某人是某组织的 CEO/首席执行官
- FOUNDER_OF: 某人创立了某组织
- CREATED_BY: 某事物由某人/组织创建（注意：不要将"担任 CEO"误标为 CREATED_BY）
- EMPLOYED_BY: 某人受雇于/就职于某组织
- MANAGES: 某人管理某团队/部门/项目
- SUBSIDIARY_OF: 某组织是另一组织的子公司
- INVESTED_IN: 某实体投资了另一实体
- ACQUIRED_BY: 某实体被另一实体收购
- BELONGS_TO: 某实体属于某类别/组织
- PART_OF: 某实体是另一实体的组成部分

规则：
1. 只抽取文本明确提及的信息，不做推测。
2. 名称标准化（统一简称/全称）。
3. confidence 范围 0-1。
4. 不要返回额外解释文本，仅返回 JSON。
5. 关系类型必须精确反映文本原意。例如"X 是 Y 的 CEO"应使用 CEO_OF，而非 CREATED_BY。
`.trim();
}
