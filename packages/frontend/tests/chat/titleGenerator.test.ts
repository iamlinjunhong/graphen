import { describe, it, expect } from 'vitest';
import { generateTemporaryTitle } from '../../src/chat/titleGenerator';

describe('generateTemporaryTitle', () => {
  it('returns null for empty string', () => {
    expect(generateTemporaryTitle('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(generateTemporaryTitle('   ')).toBeNull();
    expect(generateTemporaryTitle('\t\n ')).toBeNull();
  });

  it('returns full content for strings shorter than 5 characters', () => {
    expect(generateTemporaryTitle('Hi')).toBe('Hi');
    expect(generateTemporaryTitle('Test')).toBe('Test');
  });

  it('returns first sentence when under 30 characters', () => {
    expect(generateTemporaryTitle('Hello world. Second sentence.')).toBe('Hello world');
  });

  it('splits on Chinese punctuation', () => {
    expect(generateTemporaryTitle('你好世界。第二句话')).toBe('你好世界');
    expect(generateTemporaryTitle('这是问题？回答在这里')).toBe('这是问题');
    expect(generateTemporaryTitle('太棒了！继续加油')).toBe('太棒了');
  });

  it('splits on newline', () => {
    expect(generateTemporaryTitle('First line\nSecond line')).toBe('First line');
  });

  it('truncates first sentence exceeding 30 characters with ellipsis', () => {
    const longSentence = 'A'.repeat(50);
    const result = generateTemporaryTitle(longSentence);
    expect(result).toBe('A'.repeat(30) + '…');
  });

  it('does not truncate first sentence at exactly 30 characters', () => {
    const exact30 = 'B'.repeat(30);
    expect(generateTemporaryTitle(exact30)).toBe(exact30);
  });

  it('handles non-Chinese languages with same truncation strategy', () => {
    const longEnglish = 'This is a very long sentence that exceeds the maximum title length limit';
    const result = generateTemporaryTitle(longEnglish);
    expect(result!.length).toBe(31); // 30 chars + '…'
    expect(result!.endsWith('…')).toBe(true);
  });
});
