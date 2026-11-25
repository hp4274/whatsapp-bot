import { detectProvider } from './campaigns-ops';

describe('detectProvider', () => {
  it('knows each service from how its key starts', () => {
    expect(detectProvider('sk-ant-api03-abc')).toBe('anthropic');
    expect(detectProvider('sk-proj-abc')).toBe('openai');
    expect(detectProvider('sk-or-v1-abc')).toBe('openrouter');
    expect(detectProvider('gsk_abc')).toBe('groq');
    expect(detectProvider(' AIzaSyabc ')).toBe('gemini');
    expect(detectProvider('sk-0123456789abcdef0123456789abcdef')).toBe('deepseek');
    expect(detectProvider('something-else')).toBeNull();
  });
});
