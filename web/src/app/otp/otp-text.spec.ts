import { codeSamples, renderOtp, sampleCode } from './otp-text';

describe('renderOtp', () => {
  it('fills every placeholder, each as often as it appears', () => {
    expect(
      renderOtp('{code} is your {brand} code. Valid {minutes} min. Code: {code}', {
        code: '4821',
        brand: 'Asha Bakery',
        minutes: 5,
      }),
    ).toBe('4821 is your Asha Bakery code. Valid 5 min. Code: 4821');
  });

  it('leaves text without placeholders alone', () => {
    expect(renderOtp('Hello', { code: '1', brand: 'b', minutes: 1 })).toBe('Hello');
  });
});

describe('sampleCode', () => {
  it('matches the chosen length, held to 4..8', () => {
    expect(sampleCode(6)).toHaveLength(6);
    expect(sampleCode(2)).toHaveLength(4);
    expect(sampleCode(12)).toHaveLength(8);
  });
});

describe('codeSamples', () => {
  it('uses the real address and a key placeholder in every language', () => {
    for (const text of Object.values(codeSamples('https://example.test'))) {
      expect(text).toContain('https://example.test/api/v1/otp/send');
      expect(text).toContain('https://example.test/api/v1/otp/verify');
      expect(text).toContain('YOUR_API_KEY');
    }
  });
});
