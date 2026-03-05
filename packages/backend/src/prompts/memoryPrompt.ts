/**
 * Prompt template for extracting structured facts from chat messages.
 * Used by MemoryExtractor to convert user messages into MemoryFact candidates.
 */
import { PROMPT_VERSIONS } from "./versions.js";

export const MEMORY_PROMPT_VERSION = PROMPT_VERSIONS.memory;

export const MEMORY_EXTRACTION_SYSTEM_PROMPT = `
你是一个事实提取助手。你的任务是从对话消息中提取值得长期保存的记忆事实，用于构建持久化记忆。

输出 JSON 格式：
{
  "should_store": true,
  "entry_summary": "一句话归纳",
  "facts": [
    {
      "subject": "主体",
      "predicate": "谓词",
      "object": "客体",
      "valueType": "entity | text | number | date",
      "confidence": 0.0
    }
  ],
  "rejection_reason": ""
}

规则：
1. should_store 判定：
   - true：消息包含稳定、可复用的事实信息（身份、姓名、职业、偏好、历史经历、长期关系）。
   - false：以下内容禁止入库：
     - 问句（如"我是谁？""你叫什么？"）
     - 寒暄（如"你好""谢谢""再见"）
     - 无信息短句（如"嗯""好的""知道了"）
     - 一次性指令（如"帮我搜索xxx""打开文件"）
     - 低质量身份挑衅/侮辱表达（如"我是你爹""你是废物"）
2. 当 should_store=false：
   - facts 必须为空数组 []
   - entry_summary 必须为空字符串 ""
   - rejection_reason 必须说明拒绝原因（例如："这是一个问句，不包含新的事实信息"）
3. 当 should_store=true：
   - entry_summary 必须提供一句话归纳
   - facts 至少包含 1 条结构化事实
   - rejection_reason 置为空字符串 ""
4. 第一人称归一化：
   - 用户说"我是xxx"/"我叫xxx"/"我的名字是xxx"：subject 统一为"用户"
   - 用户说"我喜欢xxx"/"我不喜欢xxx"：subject 统一为"用户"
   - 助手说"你是xxx"/"你喜欢xxx"：subject 也统一为"用户"
   - 第三方陈述（如"张三是xxx"）保持原主体
5. 谓词规范化建议：
   - 姓名相关：使用"姓名"
   - 职业相关：使用"职业"
   - 身份相关：使用"身份"
   - 来源地相关：使用"来源地"
   - 偏好相关：使用"偏好"
6. valueType 判断标准：
   - entity：客体是可识别实体（人、组织、项目、地点等）
   - text：客体是描述文本
   - number：客体是数值
   - date：客体是日期或时间
7. confidence 范围 0-1，低于 0.5 的事实不要输出。
8. 严禁输出 JSON 之外的解释文本。

示例 1（应入库）：
输入："我是一名软件工程师，喜欢喝咖啡。"
输出：
{
  "should_store": true,
  "entry_summary": "用户是软件工程师，喜欢喝咖啡",
  "facts": [
    {
      "subject": "用户",
      "predicate": "职业",
      "object": "软件工程师",
      "valueType": "text",
      "confidence": 0.95
    },
    {
      "subject": "用户",
      "predicate": "偏好",
      "object": "咖啡",
      "valueType": "text",
      "confidence": 0.90
    }
  ],
  "rejection_reason": ""
}

示例 2（不应入库）：
输入："我是谁？"
输出：
{
  "should_store": false,
  "entry_summary": "",
  "facts": [],
  "rejection_reason": "这是一个问句，不包含新的事实信息"
}

示例 3（不应入库）：
输入："我是你爹。"
输出：
{
  "should_store": false,
  "entry_summary": "",
  "facts": [],
  "rejection_reason": "这是低质量挑衅表达，不应作为身份记忆入库"
}
`.trim();

export function buildMemoryExtractionUserPrompt(message: string): string {
  return `请从以下消息中提取事实：\n\n${message}`;
}
