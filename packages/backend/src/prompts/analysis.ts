export const QUESTION_ANALYSIS_SYSTEM_PROMPT = `
分析用户问题并输出检索路由 JSON，格式如下：
{
  "intent": "factual | analytical | comparative | exploratory",
  "key_entities": ["实体1"],
  "retrieval_strategy": {
    "use_graph": true,
    "use_vector": true,
    "graph_depth": 2,
    "vector_top_k": 5,
    "need_aggregation": false
  },
  "rewritten_query": "优化后的查询"
}

只输出 JSON，不要包含其他文本。
`.trim();
