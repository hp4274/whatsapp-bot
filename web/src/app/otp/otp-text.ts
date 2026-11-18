/** The placeholders an OTP message may use; `{code}` is required (the server rejects a template without it). */
export const OTP_PLACEHOLDERS: readonly string[] = ['{code}', '{brand}', '{minutes}'];

/** The message a customer gets: every placeholder filled, as the server fills it. */
export function renderOtp(template: string, values: { code: string; brand: string; minutes: number }): string {
  return template
    .replace(/\{code\}/g, values.code)
    .replace(/\{brand\}/g, values.brand)
    .replace(/\{minutes\}/g, String(values.minutes));
}

/** A fixed, made-up code of the chosen length for the preview, so it does not flicker on each keystroke. */
export function sampleCode(length: number): string {
  const n = Math.min(8, Math.max(4, Math.round(length) || 6));
  return '73915284'.slice(0, n);
}

export type SampleLang = 'curl' | 'node' | 'python' | 'php';

/** Send + verify for each language, against this server's own address. */
export function codeSamples(base: string): Record<SampleLang, string> {
  const send = `${base}/api/v1/otp/send`;
  const verify = `${base}/api/v1/otp/verify`;
  return {
    curl: `# 1. Send a code to your customer's WhatsApp
curl -X POST ${send} \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"phone": "+919876543210", "purpose": "login"}'

# 2. Check the code they typed (use the id from step 1)
curl -X POST ${verify} \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"id": "OTP_ID", "code": "123456"}'`,
    node: `const KEY = 'YOUR_API_KEY';
const headers = { Authorization: \`Bearer \${KEY}\`, 'Content-Type': 'application/json' };

// 1. Send a code to your customer's WhatsApp
const sent = await fetch('${send}', {
  method: 'POST',
  headers,
  body: JSON.stringify({ phone: '+919876543210', purpose: 'login' }),
}).then((r) => r.json());

// 2. Check the code they typed
const check = await fetch('${verify}', {
  method: 'POST',
  headers,
  body: JSON.stringify({ id: sent.id, code: '123456' }),
}).then((r) => r.json());

if (check.valid) {
  // signed in
}`,
    python: `import requests

KEY = "YOUR_API_KEY"
headers = {"Authorization": f"Bearer {KEY}"}

# 1. Send a code to your customer's WhatsApp
sent = requests.post("${send}", headers=headers,
                     json={"phone": "+919876543210", "purpose": "login"}).json()

# 2. Check the code they typed
check = requests.post("${verify}", headers=headers,
                      json={"id": sent["id"], "code": "123456"}).json()

if check["valid"]:
    pass  # signed in`,
    php: `<?php
$key = 'YOUR_API_KEY';

function wuzie(string $url, array $body, string $key): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ["Authorization: Bearer $key", 'Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode($body),
    ]);
    $res = json_decode(curl_exec($ch), true);
    curl_close($ch);
    return $res;
}

// 1. Send a code to your customer's WhatsApp
$sent = wuzie('${send}', ['phone' => '+919876543210', 'purpose' => 'login'], $key);

// 2. Check the code they typed
$check = wuzie('${verify}', ['id' => $sent['id'], 'code' => '123456'], $key);

if ($check['valid']) {
    // signed in
}`,
  };
}
