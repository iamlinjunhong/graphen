import { PROMPT_VERSIONS } from "./versions.js";

export const ANALYSIS_PROMPT_VERSION = PROMPT_VERSIONS.analysis;

export interface FastPathRule {
  id: "FP-01" | "FP-02" | "FP-03" | "FP-04";
  pattern: RegExp;
  fast_path_trigger: "identity_self" | "preference_self" | "history_self" | "knowledge_query";
  must_use_memory: boolean;
  retrieval_weights: {
    entry_manual: number;
    entry_chat: number;
    entry_document: number;
    graph_facts: number;
    doc_chunks: number;
  };
}

export const QUERY_ANALYSIS_FAST_PATH_RULES: FastPathRule[] = [
  {
    id: "FP-01",
    pattern: /(我是谁|我叫什么|我的名字|我的身份|我的职业|我现在的职业|你记得我是谁|你知道我的名字|总结.*我是谁|告诉我.*身份)/,
    fast_path_trigger: "identity_self",
    must_use_memory: true,
    retrieval_weights: {
      entry_manual: 1.0,
      entry_chat: 0.8,
      entry_document: 0.1,
      graph_facts: 0.2,
      doc_chunks: 0.1
    }
  },
  {
    id: "FP-02",
    pattern: /(我喜欢|我不喜欢|我的偏好|我偏好|我的喜好|我讨厌|你记得我喜欢|总结.*喜好)/,
    fast_path_trigger: "preference_self",
    must_use_memory: true,
    retrieval_weights: {
      entry_manual: 1.0,
      entry_chat: 0.9,
      entry_document: 0.2,
      graph_facts: 0.2,
      doc_chunks: 0.2
    }
  },
  {
    id: "FP-03",
    pattern: /(我.*在哪|我.*做过|我.*去过|我.*经历|我之前|我过去|我曾经|历史事件|历史经历)/,
    fast_path_trigger: "history_self",
    must_use_memory: true,
    retrieval_weights: {
      entry_manual: 0.9,
      entry_chat: 1.0,
      entry_document: 0.3,
      graph_facts: 0.4,
      doc_chunks: 0.3
    }
  },
  {
    id: "FP-04",
    pattern: /^(什么是|解释一下|介绍.*概念)/,
    fast_path_trigger: "knowledge_query",
    must_use_memory: false,
    retrieval_weights: {
      entry_manual: 0.1,
      entry_chat: 0.1,
      entry_document: 0.3,
      graph_facts: 0.8,
      doc_chunks: 1.0
    }
  }
];

export const QUESTION_ANALYSIS_SYSTEM_PROMPT = `
你是 Query Analysis 路由器。输出 JSON，且必须符合以下 schema：
{
  "intent": "factual | analytical | comparative | exploratory",
  "memory_intent": "identity | profile | preference | history | none",
  "target_subject": "user_self | assistant | third_party | unknown",
  "must_use_memory": true,
  "retrieval_weights": {
    "entry_manual": 0.0,
    "entry_chat": 0.0,
    "entry_document": 0.0,
    "graph_facts": 0.0,
    "doc_chunks": 0.0
  },
  "conflict_policy": "latest_manual_wins | highest_confidence_wins | abstain",
  "fast_path_trigger": "identity_self | preference_self | history_self | knowledge_query",
  "key_entities": ["实体1", "实体2"],
  "retrieval_strategy": {
    "use_graph": true,
    "use_vector": true,
    "graph_depth": 2,
    "vector_top_k": 5,
    "need_aggregation": false
  },
  "rewritten_query": "优化后的查询"
}

字段语义：
1. memory_intent 用于识别是否涉及用户自身记忆：
   - identity: 我是谁/我叫什么/身份职业
   - preference: 我喜欢什么/我不喜欢什么/偏好
   - history: 我做过什么/我去过哪里/过往经历
   - profile: 稳定画像信息（如居住地、工作单位、婚姻状态）
   - none: 与用户自身记忆无关
2. must_use_memory:
   - identity/preference/history/profile 通常为 true
   - none 通常为 false
3. retrieval_weights：
   - 0.0-1.0 独立评分，不要求和为 1.0
   - entry_manual > entry_chat > entry_document 适用于用户自我问题
4. conflict_policy：
   - 默认 latest_manual_wins
5. fast_path_trigger：
   - 只有命中确定性模式时填写，否则省略

示例（正例）：
输入：我是谁？
输出：
{
  "intent": "factual",
  "memory_intent": "identity",
  "target_subject": "user_self",
  "must_use_memory": true,
  "retrieval_weights": {
    "entry_manual": 1.0,
    "entry_chat": 0.8,
    "entry_document": 0.1,
    "graph_facts": 0.2,
    "doc_chunks": 0.1
  },
  "conflict_policy": "latest_manual_wins",
  "fast_path_trigger": "identity_self",
  "key_entities": ["用户"],
  "retrieval_strategy": {
    "use_graph": true,
    "use_vector": true,
    "graph_depth": 1,
    "vector_top_k": 4,
    "need_aggregation": false
  },
  "rewritten_query": "用户身份信息"
}

输入：我喜欢什么？
输出：
{
  "intent": "analytical",
  "memory_intent": "preference",
  "target_subject": "user_self",
  "must_use_memory": true,
  "retrieval_weights": {
    "entry_manual": 1.0,
    "entry_chat": 0.9,
    "entry_document": 0.2,
    "graph_facts": 0.2,
    "doc_chunks": 0.2
  },
  "conflict_policy": "latest_manual_wins",
  "fast_path_trigger": "preference_self",
  "key_entities": ["用户"],
  "retrieval_strategy": {
    "use_graph": true,
    "use_vector": true,
    "graph_depth": 1,
    "vector_top_k": 5,
    "need_aggregation": false
  },
  "rewritten_query": "用户偏好"
}

输入：什么是图数据库？
输出：
{
  "intent": "factual",
  "memory_intent": "none",
  "target_subject": "unknown",
  "must_use_memory": false,
  "retrieval_weights": {
    "entry_manual": 0.1,
    "entry_chat": 0.1,
    "entry_document": 0.3,
    "graph_facts": 0.8,
    "doc_chunks": 1.0
  },
  "conflict_policy": "latest_manual_wins",
  "fast_path_trigger": "knowledge_query",
  "key_entities": ["图数据库"],
  "retrieval_strategy": {
    "use_graph": true,
    "use_vector": true,
    "graph_depth": 2,
    "vector_top_k": 8,
    "need_aggregation": false
  },
  "rewritten_query": "图数据库定义"
}

示例（反例）：
1. 不允许输出非 JSON 文本。
2. 不允许把 retrieval_weights 写成字符串或超出 0.0-1.0。

只输出 JSON，不要输出解释。
`.trim();
