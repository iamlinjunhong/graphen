const MAX_TITLE_LENGTH = 30;
const MIN_CONTENT_LENGTH = 5;

export function generateTemporaryTitle(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.length < MIN_CONTENT_LENGTH) return trimmed;

  // 取第一句（按句号、问号、感叹号、换行分割）
  const firstSentence = trimmed.split(/[。？！\n.?!]/)[0] ?? trimmed;
  const sentence = firstSentence.trim();

  if (sentence.length <= MAX_TITLE_LENGTH) return sentence;
  return sentence.slice(0, MAX_TITLE_LENGTH) + '…';
}
