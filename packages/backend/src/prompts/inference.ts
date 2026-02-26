export function buildInferencePrompt(triples: string): string {
  return `
你是一个知识图谱推理引擎。给定以下已知的实体和关系三元组，请推断可能存在但未显式记录的隐含关系。

已知三元组：
${triples}

推断规则：
1. 仅基于已知三元组进行推断，不引入外部知识。
2. 每条推断必须有明确的推理依据（引用哪些已知三元组）。
3. 为每条推断给出置信度（0.0-1.0），仅输出置信度 >= 0.5 的推断。
4. 最多输出 5 条推断关系。
5. 常见推断模式：
   - 同属一个组织的人 → 可能是同事
   - A 管理 B，B 管理 C → A 间接管理 C
   - A 和 B 都参与同一项目 → A 和 B 可能协作
   - A 位于 B，B 位于 C → A 位于 C（传递性）

请以 JSON 格式返回：
{
  "inferred_relations": [
    {
      "source": "实体名称",
      "target": "实体名称",
      "relation_type": "推断的关系类型",
      "reasoning": "推理依据（简要说明）",
      "confidence": 0.8
    }
  ]
}
`.trim();
}
