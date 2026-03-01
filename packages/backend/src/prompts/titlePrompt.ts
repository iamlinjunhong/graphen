export function buildTitleGenerationPrompt(userMessage: string, assistantResponse: string): string {
  return `你是一个标题生成助手。根据以下对话内容，生成一个简洁、描述性的中文标题，用于概括对话主题。

要求：
- 标题不超过30个字符
- 使用中文
- 简洁明了，能概括对话核心主题
- 不要使用引号或标点符号包裹标题
- 直接输出标题文本，不要有任何前缀或解释

用户消息：${userMessage}

助手回复：${assistantResponse.slice(0, 500)}`;
}
