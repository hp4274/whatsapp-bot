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

describe('otpGuideHtml', () => {
  it('holds the address, every call, the limits and the errors, with every text escaped', async () => {
    const { otpGuideHtml } = await import('./otp-text');
    const page = otpGuideHtml({
      base: 'https://app.example',
      business: 'Asha <Bakery>',
      limits: 'a code works 10 minutes',
    });
    expect(page).toContain('<title>WhatsApp OTP API guide - Asha &lt;Bakery&gt;</title>');
    expect(page).toContain('<code>https://app.example/api/v1</code>');
    for (const path of ['/api/v1/otp/send', '/api/v1/otp/verify', '/api/v1/otp/{id}']) expect(page).toContain(`<code>${path}</code>`);
    expect(page).toContain('a code works 10 minutes.');
    expect(page).toContain('<td><code>invalid_api_key</code></td>');
    // A sample keeps its own backticks (JS template literals) and its PHP tag as text.
    expect(page).toContain('`Bearer ${KEY}`');
    expect(page).toContain('&lt;?php');
  });

  it('reads as a public guide without an account name or limits', async () => {
    const { otpGuideHtml } = await import('./otp-text');
    const page = otpGuideHtml({ base: 'https://app.example' });
    expect(page).toContain('<title>WhatsApp OTP API guide</title>');
    expect(page).not.toContain('Your limits');
  });
});
